type VoidCallback<T = void> = (payload: T) => void

type ProxyStatusPayload = { running: boolean; port: number }
type ProxyResponsePayload = {
  path: string
  model?: string
  status: number
  tokens?: number
  inputTokens?: number
  outputTokens?: number
  credits?: number
  error?: string
}

const ADMIN_TOKEN_KEY = 'kiro-web-admin-token'
const UI_PREFS_KEY = 'kiro-web-prefs'
const MACHINE_ID_KEY = 'kiro-web-machine-id'

let metaCache: { authRequired: boolean } | null = null
let proxyPollTimer: number | null = null
let proxyPollInFlight = false
let seenRecentRequestKeys = new Set<string>()
let proxyStatusSnapshot = ''

const backgroundRefreshProgressListeners = new Set<
  VoidCallback<{ completed: number; total: number; success: number; failed: number }>
>()
const backgroundRefreshResultListeners = new Set<
  VoidCallback<{ id: string; success: boolean; data?: unknown; error?: string }>
>()
const backgroundCheckProgressListeners = new Set<
  VoidCallback<{ completed: number; total: number; success: number; failed: number }>
>()
const backgroundCheckResultListeners = new Set<
  VoidCallback<{ id: string; success: boolean; data?: unknown; error?: string }>
>()
const proxyResponseListeners = new Set<VoidCallback<ProxyResponsePayload>>()
const proxyStatusChangeListeners = new Set<VoidCallback<ProxyStatusPayload>>()
const proxyErrorListeners = new Set<VoidCallback<string>>()

function randomHex(length: number): string {
  const bytes = new Uint8Array(Math.ceil(length / 2))
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, length)
}

function getStoredPreferences(): Record<string, unknown> {
  try {
    const raw = localStorage.getItem(UI_PREFS_KEY)
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function setStoredPreference(key: string, value: unknown): void {
  const next = getStoredPreferences()
  next[key] = value
  localStorage.setItem(UI_PREFS_KEY, JSON.stringify(next))
}

function getStoredPreference<T>(key: string, fallback: T): T {
  const prefs = getStoredPreferences()
  return (prefs[key] as T | undefined) ?? fallback
}

function addListener<T>(set: Set<VoidCallback<T>>, callback: VoidCallback<T>): () => void {
  set.add(callback)
  if (set === proxyResponseListeners || set === proxyStatusChangeListeners || set === proxyErrorListeners) {
    ensureProxyPolling()
  }
  return () => {
    set.delete(callback)
    stopProxyPollingIfIdle()
  }
}

function emitTo<T>(listeners: Set<VoidCallback<T>>, payload: T): void {
  for (const listener of listeners) {
    try {
      listener(payload)
    } catch (error) {
      console.error('[web-runtime] listener error', error)
    }
  }
}

async function fetchMeta(): Promise<{ authRequired: boolean }> {
  if (metaCache) {
    return metaCache
  }

  const response = await fetch('/api/meta')
  if (!response.ok) {
    throw new Error(`Failed to fetch meta: ${response.status}`)
  }

  metaCache = (await response.json()) as { authRequired: boolean }
  return metaCache
}

async function promptForAdminToken(): Promise<string | null> {
  const meta = await fetchMeta()
  if (!meta.authRequired) {
    return null
  }

  const provided = window.prompt('请输入 Web 管理口令 / Enter admin token')
  if (!provided) {
    return null
  }

  localStorage.setItem(ADMIN_TOKEN_KEY, provided)
  return provided
}

async function callRenderer<T>(method: string, params?: Record<string, unknown>): Promise<T> {
  const token = localStorage.getItem(ADMIN_TOKEN_KEY) || ''
  const execute = async (adminToken?: string): Promise<Response> => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    }
    if (adminToken) {
      headers['X-Admin-Token'] = adminToken
    }

    return fetch('/api/renderer/call', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        method,
        params: params || {}
      })
    })
  }

  let response = await execute(token)
  if (response.status === 401) {
    const newToken = await promptForAdminToken()
    if (!newToken) {
      throw new Error('Unauthorized')
    }
    response = await execute(newToken)
  }

  const body = (await response.json().catch(() => ({}))) as { result?: T; error?: string }
  if (!response.ok) {
    throw new Error(body.error || `Request failed: ${response.status}`)
  }

  return body.result as T
}

async function pollProxyStatus(): Promise<void> {
  if (proxyPollInFlight) {
    return
  }

  proxyPollInFlight = true
  try {
    const result = await callRenderer<{
      running: boolean
      config?: { port?: number }
      stats?: {
        recentRequests?: Array<{
          timestamp: number
          path: string
          model?: string
          inputTokens?: number
          outputTokens?: number
          credits?: number
          success: boolean
          error?: string
        }>
      }
    }>('proxyGetStatus')

    const statusPayload = {
      running: Boolean(result.running),
      port: Number(result.config?.port || 0)
    }
    const statusKey = JSON.stringify(statusPayload)
    if (statusKey !== proxyStatusSnapshot) {
      proxyStatusSnapshot = statusKey
      emitTo(proxyStatusChangeListeners, statusPayload)
    }

    const requests = result.stats?.recentRequests || []
    if (seenRecentRequestKeys.size === 0) {
      for (const item of requests) {
        seenRecentRequestKeys.add(`${item.timestamp}:${item.path}:${item.model || ''}:${item.error || ''}`)
      }
      return
    }

    const sorted = [...requests].sort((left, right) => left.timestamp - right.timestamp)
    for (const item of sorted) {
      const key = `${item.timestamp}:${item.path}:${item.model || ''}:${item.error || ''}`
      if (seenRecentRequestKeys.has(key)) {
        continue
      }

      seenRecentRequestKeys.add(key)
      emitTo(proxyResponseListeners, {
        path: item.path,
        model: item.model,
        status: item.success ? 200 : 500,
        inputTokens: item.inputTokens,
        outputTokens: item.outputTokens,
        tokens: (item.inputTokens || 0) + (item.outputTokens || 0),
        credits: item.credits,
        error: item.error
      })
    }

    if (seenRecentRequestKeys.size > 300) {
      seenRecentRequestKeys = new Set(Array.from(seenRecentRequestKeys).slice(-200))
    }
  } catch (error) {
    emitTo(proxyErrorListeners, error instanceof Error ? error.message : 'Proxy poll failed')
  } finally {
    proxyPollInFlight = false
  }
}

function ensureProxyPolling(): void {
  if (proxyPollTimer !== null) {
    return
  }

  proxyPollTimer = window.setInterval(() => {
    void pollProxyStatus()
  }, 2000)
  void pollProxyStatus()
}

function stopProxyPollingIfIdle(): void {
  if (
    proxyResponseListeners.size > 0 ||
    proxyStatusChangeListeners.size > 0 ||
    proxyErrorListeners.size > 0
  ) {
    return
  }

  if (proxyPollTimer !== null) {
    window.clearInterval(proxyPollTimer)
    proxyPollTimer = null
  }
}

function createUnsupported<T>(message: string, fallback: T): Promise<T> {
  console.warn(`[web-runtime] ${message}`)
  return Promise.resolve(fallback)
}

function getMachineId(): string {
  const existing = localStorage.getItem(MACHINE_ID_KEY)
  if (existing) {
    return existing
  }

  const generated = randomHex(64)
  localStorage.setItem(MACHINE_ID_KEY, generated)
  return generated
}

async function pickFile(): Promise<{ content: string; format: string } | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.json,.csv,.txt,.md,.log'
    input.onchange = async () => {
      const file = input.files?.[0]
      if (!file) {
        resolve(null)
        return
      }

      const text = await file.text()
      const ext = file.name.includes('.') ? file.name.split('.').pop()!.toLowerCase() : 'txt'
      resolve({ content: text, format: ext })
    }
    input.click()
  })
}

function downloadFile(data: string, filename: string): boolean {
  try {
    const blob = new Blob([data], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = filename
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    URL.revokeObjectURL(url)
    return true
  } catch {
    return false
  }
}

export function isWebRuntime(): boolean {
  return typeof window !== 'undefined' && Boolean((window as typeof window & { __KIRO_WEB_RUNTIME__?: boolean }).__KIRO_WEB_RUNTIME__)
}

export function installWebRuntimeApi(): void {
  if (typeof window === 'undefined') {
    return
  }

  if (window.api) {
    return
  }

  ;(window as typeof window & { __KIRO_WEB_RUNTIME__?: boolean }).__KIRO_WEB_RUNTIME__ = true

  window.api = {
    openExternal: (url: string) => {
      window.open(url, '_blank', 'noopener,noreferrer')
    },
    getAppVersion: () => callRenderer<string>('getAppVersion'),
    onAuthCallback: () => () => {},

    loadAccounts: () => callRenderer('loadAccounts'),
    saveAccounts: (data, options) =>
      callRenderer('saveAccounts', {
        data,
        allowEmptyAccounts: options?.allowEmptyAccounts === true
      }).then(() => undefined),
    refreshAccountToken: (account) => callRenderer('refreshAccountToken', { account }),
    checkAccountStatus: (account) => callRenderer('checkAccountStatus', { account }),

    backgroundBatchRefresh: async (accounts, concurrency, syncInfo) => {
      const result = await callRenderer<{
        success: boolean
        completed: number
        successCount: number
        failedCount: number
        results?: Array<{ id: string; success: boolean; data?: unknown; error?: string }>
      }>('backgroundBatchRefresh', { accounts, concurrency, syncInfo })

      const total = result.results?.length || 0
      let success = 0
      let failed = 0
      for (const item of result.results || []) {
        if (item.success) {
          success++
        } else {
          failed++
        }
        emitTo(backgroundRefreshProgressListeners, {
          completed: success + failed,
          total,
          success,
          failed
        })
        emitTo(backgroundRefreshResultListeners, item)
      }

      return {
        success: result.success,
        completed: result.completed,
        successCount: result.successCount,
        failedCount: result.failedCount
      }
    },
    onBackgroundRefreshProgress: (callback) => addListener(backgroundRefreshProgressListeners, callback),
    onBackgroundRefreshResult: (callback) => addListener(backgroundRefreshResultListeners, callback),

    backgroundBatchCheck: async (accounts, concurrency) => {
      const result = await callRenderer<{
        success: boolean
        completed: number
        successCount: number
        failedCount: number
        results?: Array<{ id: string; success: boolean; data?: unknown; error?: string }>
      }>('backgroundBatchCheck', { accounts, concurrency })

      const total = result.results?.length || 0
      let success = 0
      let failed = 0
      for (const item of result.results || []) {
        if (item.success) {
          success++
        } else {
          failed++
        }
        emitTo(backgroundCheckProgressListeners, {
          completed: success + failed,
          total,
          success,
          failed
        })
        emitTo(backgroundCheckResultListeners, item)
      }

      return {
        success: result.success,
        completed: result.completed,
        successCount: result.successCount,
        failedCount: result.failedCount
      }
    },
    onBackgroundCheckProgress: (callback) => addListener(backgroundCheckProgressListeners, callback),
    onBackgroundCheckResult: (callback) => addListener(backgroundCheckResultListeners, callback),

    switchAccount: async () => ({ success: true }),
    logoutAccount: async () => ({ success: true, deletedCount: 0 }),

    exportToFile: async (data, filename) => downloadFile(data, filename),
    importFromFile: () => pickFile(),

    verifyAccountCredentials: (credentials) => callRenderer('verifyAccountCredentials', { credentials }),
    getLocalActiveAccount: async () => ({ success: false, error: 'Web version does not expose local SSO cache' }),
    loadKiroCredentials: async () => ({ success: false, error: 'Web version cannot read local desktop credentials' }),
    importFromSsoToken: async () => ({
      success: false,
      error: { message: 'Web version does not support direct SSO token import yet. Please use CSV or OIDC credentials.' }
    }),

    startBuilderIdLogin: async () =>
      createUnsupported('Builder ID login is not available in the web runtime', {
        success: false,
        error: 'Web 版暂不支持在线授权登录，请使用 OIDC 凭证或 CSV 导入'
      }),
    pollBuilderIdAuth: async () =>
      createUnsupported('Builder ID auth polling is not available in the web runtime', {
        success: false,
        error: 'Web 版暂不支持在线授权登录'
      }),
    cancelBuilderIdLogin: async () => ({ success: true }),
    startIamSsoLogin: async () =>
      createUnsupported('IAM SSO login is not available in the web runtime', {
        success: false,
        error: 'Web 版暂不支持在线授权登录，请改用手动导入'
      }),
    pollIamSsoAuth: async () =>
      createUnsupported('IAM SSO auth polling is not available in the web runtime', {
        success: false,
        error: 'Web 版暂不支持在线授权登录'
      }),
    cancelIamSsoLogin: async () => ({ success: true }),
    startSocialLogin: async () =>
      createUnsupported('Social login is not available in the web runtime', {
        success: false,
        error: 'Web 版暂不支持在线授权登录，请改用 OIDC 凭证导入'
      }),
    exchangeSocialToken: async () =>
      createUnsupported('Social token exchange is not available in the web runtime', {
        success: false,
        error: 'Web 版暂不支持在线授权登录'
      }),
    cancelSocialLogin: async () => ({ success: true }),
    onSocialAuthCallback: () => () => {},

    setProxy: async (_enabled, _url) => ({ success: true }),

    machineIdGetOSType: async () => 'linux',
    machineIdGetCurrent: async () => ({ success: true, machineId: getMachineId() }),
    machineIdSet: async (newMachineId) => {
      localStorage.setItem(MACHINE_ID_KEY, newMachineId)
      return { success: true, machineId: newMachineId }
    },
    machineIdGenerateRandom: async () => randomHex(64),
    machineIdCheckAdmin: async () => false,
    machineIdRequestAdminRestart: async () => false,
    machineIdBackupToFile: async (machineId) => downloadFile(machineId, 'machine-id.txt'),
    machineIdRestoreFromFile: async () => {
      const picked = await pickFile()
      if (!picked) {
        return { success: false, error: 'No file selected' }
      }
      const machineId = picked.content.trim()
      localStorage.setItem(MACHINE_ID_KEY, machineId)
      return { success: true, machineId }
    },

    checkForUpdates: async () => ({ hasUpdate: false, version: await callRenderer<string>('getAppVersion') }),
    checkForUpdatesManual: async () => {
      const version = await callRenderer<string>('getAppVersion')
      return {
        hasUpdate: false,
        currentVersion: version,
        latestVersion: version
      }
    },
    downloadUpdate: async () => ({ success: false, error: 'Web version does not support in-app updates' }),
    installUpdate: async () => undefined,
    onUpdateChecking: () => () => {},
    onUpdateAvailable: () => () => {},
    onUpdateNotAvailable: () => () => {},
    onUpdateDownloadProgress: () => () => {},
    onUpdateDownloaded: () => () => {},
    onUpdateError: () => () => {},

    getKiroSettings: async () => ({ error: 'Web version does not expose desktop Kiro settings' }),
    getKiroAvailableModels: async () => ({ models: [], error: 'Unsupported in web runtime' }),
    saveKiroSettings: async () => ({ success: false, error: 'Unsupported in web runtime' }),
    openKiroMcpConfig: async () => ({ success: false, error: 'Unsupported in web runtime' }),
    openKiroSteeringFolder: async () => ({ success: false, error: 'Unsupported in web runtime' }),
    openKiroSettingsFile: async () => ({ success: false, error: 'Unsupported in web runtime' }),
    openKiroSteeringFile: async () => ({ success: false, error: 'Unsupported in web runtime' }),
    createKiroDefaultRules: async () => ({ success: false, error: 'Unsupported in web runtime' }),
    readKiroSteeringFile: async () => ({ success: false, error: 'Unsupported in web runtime' }),
    saveKiroSteeringFile: async () => ({ success: false, error: 'Unsupported in web runtime' }),
    deleteKiroSteeringFile: async () => ({ success: false, error: 'Unsupported in web runtime' }),
    saveMcpServer: async () => ({ success: false, error: 'Unsupported in web runtime' }),
    deleteMcpServer: async () => ({ success: false, error: 'Unsupported in web runtime' }),

    proxyStart: (config) => callRenderer('proxyStart', { config }),
    proxyStop: () => callRenderer('proxyStop'),
    proxyGetStatus: () => callRenderer('proxyGetStatus'),
    proxyResetCredits: () => callRenderer('proxyResetCredits'),
    proxyResetTokens: () => callRenderer('proxyResetTokens'),
    proxyResetRequestStats: () => callRenderer('proxyResetRequestStats'),
    proxyGetLogs: (count) => callRenderer('proxyGetLogs', { count }),
    proxyClearLogs: () => callRenderer('proxyClearLogs'),
    proxyGetLogsCount: () => callRenderer('proxyGetLogsCount'),
    proxyUpdateConfig: (config) => callRenderer('proxyUpdateConfig', { config }),
    proxyAddAccount: async () => ({ success: false, error: 'Please use sync accounts in web mode' }),
    proxyRemoveAccount: async () => ({ success: false, error: 'Please manage accounts from the account list in web mode' }),
    proxySyncAccounts: (accounts) => callRenderer('proxySyncAccounts', { accounts }),
    proxyGetAccounts: () => callRenderer('proxyGetAccounts'),
    proxyResetPool: () => callRenderer('proxyResetPool'),
    proxyRefreshModels: () => callRenderer('proxyRefreshModels'),
    proxyGetModels: () => callRenderer('proxyGetModels'),
    accountGetModels: (accessToken, region, profileArn, accountId) =>
      callRenderer('accountGetModels', { accessToken, region, profileArn, accountId }),
    accountGetSubscriptions: (accessToken, region, accountId) =>
      callRenderer('accountGetSubscriptions', { accessToken, region, accountId }),
    accountGetSubscriptionUrl: (accessToken, subscriptionType, region, accountId) =>
      callRenderer('accountGetSubscriptionUrl', { accessToken, subscriptionType, region, accountId }),
    openSubscriptionWindow: async (url) => {
      window.open(url, '_blank', 'noopener,noreferrer')
      return { success: true }
    },
    proxySaveLogs: (logs) => callRenderer('proxySaveLogs', { logs }),
    proxyLoadLogs: () => callRenderer('proxyLoadLogs'),
    onProxyRequest: () => () => {},
    onProxyResponse: (callback) => addListener(proxyResponseListeners, callback),
    onProxyError: (callback) => addListener(proxyErrorListeners, callback),
    onProxyStatusChange: (callback) => addListener(proxyStatusChangeListeners, callback),

    getUsageApiType: async () => getStoredPreference<'rest' | 'cbor'>('usageApiType', 'rest'),
    setUsageApiType: async (type) => {
      setStoredPreference('usageApiType', type)
      return { success: true, type }
    },
    getUseKProxyForApi: async () => getStoredPreference<boolean>('useKProxyForApi', false),
    setUseKProxyForApi: async (enabled) => {
      setStoredPreference('useKProxyForApi', enabled)
      return { success: true, enabled }
    },

    kproxyInit: async () => ({ success: false, error: 'Unsupported in web runtime' }),
    kproxyStart: async () => ({ success: false, error: 'Unsupported in web runtime' }),
    kproxyStop: async () => ({ success: false, error: 'Unsupported in web runtime' }),
    kproxyGetStatus: async () => ({ running: false, config: null, stats: null, caInfo: null }),
    kproxyUpdateConfig: async () => ({ success: false, error: 'Unsupported in web runtime' }),
    kproxySetDeviceId: async () => ({ success: false, error: 'Unsupported in web runtime' }),
    kproxyGenerateDeviceId: async () => ({ success: false }),
    kproxyAddDeviceMapping: async () => ({ success: false, error: 'Unsupported in web runtime' }),
    kproxyGetDeviceMappings: async () => ({ success: false, mappings: [] }),
    kproxySwitchToAccount: async () => ({ success: false, error: 'Unsupported in web runtime' }),
    kproxyGetCaCert: async () => ({ success: false, error: 'Unsupported in web runtime' }),
    kproxyExportCaCert: async () => ({ success: false, error: 'Unsupported in web runtime' }),
    kproxyCheckCaCertInstalled: async () => ({ success: false, installed: false, error: 'Unsupported in web runtime' }),
    proxyGetApiKeys: () => callRenderer('proxyGetApiKeys'),
    proxyAddApiKey: (apiKey) => callRenderer('proxyAddApiKey', { apiKey }),
    proxyUpdateApiKey: (id, updates) => callRenderer('proxyUpdateApiKey', { id, updates }),
    proxyDeleteApiKey: (id) => callRenderer('proxyDeleteApiKey', { id }),
    proxyResetApiKeyUsage: (id) => callRenderer('proxyResetApiKeyUsage', { id }),
    kproxyInstallCaCert: async () => ({ success: false, error: 'Unsupported in web runtime' }),
    kproxyUninstallCaCert: async () => ({ success: false, error: 'Unsupported in web runtime' }),
    kproxyResetStats: async () => ({ success: false }),
    onKproxyRequest: () => () => {},
    onKproxyResponse: () => () => {},
    onKproxyError: () => () => {},
    onKproxyStatusChange: () => () => {},
    onKproxyMitm: () => () => {},

    getShowWindowShortcut: async () => getStoredPreference<string>('showWindowShortcut', ''),
    setShowWindowShortcut: async (shortcut) => {
      setStoredPreference('showWindowShortcut', shortcut)
      return { success: true }
    },
    getTraySettings: async () =>
      getStoredPreference('traySettings', {
        enabled: false,
        closeAction: 'ask' as const,
        showNotifications: false,
        minimizeOnStart: false
      }),
    saveTraySettings: async (settings) => {
      const current = getStoredPreference('traySettings', {
        enabled: false,
        closeAction: 'ask' as const,
        showNotifications: false,
        minimizeOnStart: false
      })
      setStoredPreference('traySettings', { ...current, ...settings })
      return { success: true }
    },
    updateTrayAccount: () => undefined,
    updateTrayAccountList: () => undefined,
    refreshTrayMenu: () => undefined,
    updateTrayLanguage: () => undefined,
    onTrayRefreshAccount: () => () => {},
    onTraySwitchAccount: () => () => {},
    onShowCloseConfirmDialog: () => () => {},
    sendCloseConfirmResponse: () => undefined
  }
}
