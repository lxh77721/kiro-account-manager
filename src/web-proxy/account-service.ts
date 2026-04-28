import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { ProxyServer, type ApiKey, type ProxyConfig, type ProxyAccount } from '../main/proxy'
import { fetchAvailableSubscriptions, fetchKiroModels, fetchSubscriptionToken } from '../main/proxy/kiroApi'
import { proxyLogStore, proxyLogger } from '../main/proxy/logger'
import { getRuntimeUserDataPath } from '../main/runtimePath'
import {
  buildStoredAccountFromImport,
  generateMachineId,
  normalizeAuthMethod,
  normalizeProvider,
  refreshTokenByMethod,
  toProxyAccount,
  verifyStoredAccount
} from './kiro-account-api'
import { StateDatabase, type PersistedRendererState } from './state-database'
import type {
  ImportCandidate,
  PublicAccountView,
  PublicStateView,
  StoredAccount,
  WebProxyState
} from './types'

interface ImportResult {
  success: number
  failed: number
  updated: number
  errors: Array<{ message: string }>
}

interface RendererCredentialsLike {
  accessToken?: string
  refreshToken?: string
  clientId?: string
  clientSecret?: string
  region?: string
  authMethod?: string
  provider?: string
  startUrl?: string
  expiresAt?: number
}

interface RendererUsageLike {
  current?: number
  limit?: number
  percentUsed?: number
  lastUpdated?: number
  baseLimit?: number
  baseCurrent?: number
  freeTrialLimit?: number
  freeTrialCurrent?: number
  freeTrialExpiry?: string
  bonuses?: Array<{
    code: string
    name: string
    current: number
    limit: number
    expiresAt?: string
  }>
  nextResetDate?: string
  resourceDetail?: {
    displayName?: string
    displayNamePlural?: string
    resourceType?: string
    currency?: string
    unit?: string
    overageRate?: number
    overageCap?: number
    overageEnabled?: boolean
  }
}

interface RendererSubscriptionLike {
  type?: 'Free' | 'Pro' | 'Pro_Plus' | 'Enterprise' | 'Teams'
  title?: string
  rawType?: string
  expiresAt?: number
  daysRemaining?: number
  managementTarget?: string
  upgradeCapability?: string
  overageCapability?: string
}

interface RendererAccountLike {
  id?: string
  email?: string
  nickname?: string
  userId?: string
  idp?: string
  profileArn?: string
  machineId?: string
  status?: string
  lastError?: string
  createdAt?: number
  lastCheckedAt?: number
  credentials?: RendererCredentialsLike
  usage?: RendererUsageLike
  subscription?: RendererSubscriptionLike
}

interface RendererStoreData {
  accounts?: Record<string, RendererAccountLike>
  groups?: Record<string, unknown>
  tags?: Record<string, unknown>
  [key: string]: unknown
}

interface RendererCallPayload {
  method?: string
  params?: Record<string, unknown>
}

interface BackgroundAccountLike {
  id?: string
  email?: string
  nickname?: string
  userId?: string
  idp?: string
  needsTokenRefresh?: boolean
  machineId?: string
  profileArn?: string
  status?: string
  lastError?: string
  createdAt?: number
  lastCheckedAt?: number
  credentials?: RendererCredentialsLike
  accessToken?: string
  refreshToken?: string
  clientId?: string
  clientSecret?: string
  region?: string
  authMethod?: string
  provider?: string
  expiresAt?: number
  usage?: RendererUsageLike
  subscription?: RendererSubscriptionLike
}

interface UiRecentLog {
  time: string
  path: string
  model?: string
  status: number
  tokens?: number
  inputTokens?: number
  outputTokens?: number
  credits?: number
  error?: string
}

function createEmptyApiKeyUsage(): ApiKey['usage'] {
  return {
    totalRequests: 0,
    totalCredits: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    daily: {}
  }
}

export class WebProxyService {
  private static readonly MAX_RENDERER_BACKUPS = 10
  private readonly dataDir: string
  private readonly stateFile: string
  private readonly rendererStateFile: string
  private readonly rendererBackupDir: string
  private readonly dbFile: string
  private readonly uiLogsFile: string
  private readonly packageJsonPath: string
  private state: WebProxyState
  private readonly proxyServer: ProxyServer
  private readonly stateDatabase: StateDatabase
  private packageVersionCache: string | null = null
  private rendererStateCache: RendererStoreData | null = null
  private rendererStateMtimeMs: number | null = null
  private rendererStateCacheLoaded = false

  constructor() {
    this.dataDir = getRuntimeUserDataPath()
    this.stateFile = path.join(this.dataDir, 'web-proxy-state.json')
    this.rendererStateFile = path.join(this.dataDir, 'renderer-state.json')
    this.rendererBackupDir = path.join(this.dataDir, 'renderer-state-backups')
    this.dbFile = path.join(this.dataDir, 'kiro-state.sqlite')
    this.uiLogsFile = path.join(this.dataDir, 'web-ui-recent-logs.json')
    this.packageJsonPath = path.resolve(process.cwd(), 'package.json')

    fs.mkdirSync(this.dataDir, { recursive: true })
    fs.mkdirSync(this.rendererBackupDir, { recursive: true })
    this.stateDatabase = new StateDatabase(this.dbFile)
    proxyLogStore.initialize(this.dataDir)
    proxyLogger.configure({ enabled: process.env.KIRO_WEB_PROXY_LOG === 'true' })

    this.state = this.loadState()
    this.proxyServer = new ProxyServer(this.state.proxyConfig, {
      onRequest: () => {
        // Browser runtime polls `recentRequests` from proxy status, so no extra bridge is needed here.
      },
      onResponse: () => {
        // Browser runtime polls `recentRequests` from proxy status, so no extra bridge is needed here.
      },
      onError: (error) => {
        proxyLogger.error('WebProxy', 'Proxy server error', error.message)
      },
      onTokenRefresh: async (account) => {
        const stored = this.state.accounts.find((item) => item.id === account.id)
        if (!stored) {
          return { success: false, error: 'Account not found' }
        }

        const result = await refreshTokenByMethod(stored)
        if (!result.success || !result.accessToken) {
          return { success: false, error: result.error || 'Token refresh failed' }
        }

        stored.credentials.accessToken = result.accessToken
        stored.credentials.refreshToken = result.refreshToken || stored.credentials.refreshToken
        stored.credentials.expiresAt = result.expiresIn
          ? Date.now() + result.expiresIn * 1000
          : stored.credentials.expiresAt
        stored.lastCheckedAt = Date.now()
        this.saveState()

        return {
          success: true,
          accessToken: stored.credentials.accessToken,
          refreshToken: stored.credentials.refreshToken,
          expiresAt: stored.credentials.expiresAt
        }
      },
      onAccountUpdate: (account) => {
        const stored = this.state.accounts.find((item) => item.id === account.id)
        if (!stored) {
          return
        }

        stored.credentials.accessToken = account.accessToken
        stored.credentials.refreshToken = account.refreshToken || stored.credentials.refreshToken
        stored.credentials.expiresAt = account.expiresAt
        stored.lastCheckedAt = Date.now()
        this.saveState()
      }
    })

    this.hydrateRendererState({
      force: true,
      persistState: true
    })

    if (this.state.proxyConfig.enabled) {
      this.syncProxyAccounts()
      this.proxyServer
        .start()
        .catch((error) => proxyLogger.error('WebProxy', 'Failed to auto-start proxy', error))
    }
  }

  getMeta(): { authRequired: boolean } {
    return { authRequired: Boolean(process.env.KIRO_WEB_ADMIN_TOKEN) }
  }

  isAuthorized(token?: string | null): boolean {
    const requiredToken = process.env.KIRO_WEB_ADMIN_TOKEN
    if (!requiredToken) {
      return true
    }

    return token === requiredToken
  }

  getState(): PublicStateView {
    const config = this.proxyServer.isRunning() ? this.proxyServer.getConfig() : this.state.proxyConfig

    return {
      accounts: this.state.accounts.map((account) => this.toPublicAccount(account)),
      proxy: {
        running: this.proxyServer.isRunning(),
        config,
        address: `http://${config.host}:${config.port}`,
        eligibleAccounts: this.getEligibleAccounts().length
      }
    }
  }

  async handleRendererCall(payload: RendererCallPayload): Promise<unknown> {
    const method = payload.method
    const params = payload.params || {}

    switch (method) {
      case 'getAppVersion':
        return this.getPackageVersion()
      case 'loadAccounts':
        return this.loadRendererState()
      case 'saveAccounts':
        this.saveRendererState(params.data, {
          allowEmptyAccounts: params.allowEmptyAccounts === true
        })
        return null
      case 'refreshAccountToken':
        return this.refreshRendererAccount(params.account as BackgroundAccountLike)
      case 'checkAccountStatus':
        return this.checkRendererAccount(params.account as BackgroundAccountLike)
      case 'backgroundBatchRefresh':
        return this.backgroundRefresh(
          (params.accounts as BackgroundAccountLike[]) || [],
          Number(params.concurrency || 10),
          params.syncInfo !== false
        )
      case 'backgroundBatchCheck':
        return this.backgroundCheck(
          (params.accounts as BackgroundAccountLike[]) || [],
          Number(params.concurrency || 10)
        )
      case 'verifyAccountCredentials':
        return this.verifyRendererCredentials(params.credentials as RendererCredentialsLike)
      case 'proxyGetStatus':
        return this.getProxyStatus()
      case 'proxyStart':
        return this.proxyStart((params.config as Partial<ProxyConfig>) || {})
      case 'proxyStop':
        return this.proxyStop()
      case 'proxyUpdateConfig':
        return this.proxyUpdateConfig((params.config as Partial<ProxyConfig>) || {})
      case 'proxySyncAccounts':
        return this.proxySyncAccounts((params.accounts as RendererAccountLike[]) || [])
      case 'proxyGetAccounts':
        return this.proxyGetAccounts()
      case 'proxyResetPool':
        return this.proxyResetPool()
      case 'proxyResetAccountState':
        return this.proxyResetAccountState(String(params.accountId || ''))
      case 'proxyResetCredits':
        return this.proxyResetCredits()
      case 'proxyResetTokens':
        return this.proxyResetTokens()
      case 'proxyResetRequestStats':
        return this.proxyResetRequestStats()
      case 'proxyGetLogs':
        return this.proxyGetLogs(Number(params.count || 500))
      case 'proxyClearLogs':
        return this.proxyClearLogs()
      case 'proxyGetLogsCount':
        return this.proxyGetLogsCount()
      case 'proxyRefreshModels':
        return this.proxyRefreshModels()
      case 'proxyGetModels':
        return this.proxyGetModels()
      case 'accountGetModels':
        return this.accountGetModels(
          String(params.accessToken || ''),
          params.region ? String(params.region) : undefined,
          params.profileArn ? String(params.profileArn) : undefined,
          params.accountId ? String(params.accountId) : undefined
        )
      case 'accountGetSubscriptions':
        return this.accountGetSubscriptions(
          String(params.accessToken || ''),
          params.region ? String(params.region) : undefined,
          params.accountId ? String(params.accountId) : undefined
        )
      case 'accountGetSubscriptionUrl':
        return this.accountGetSubscriptionUrl(
          String(params.accessToken || ''),
          params.subscriptionType ? String(params.subscriptionType) : undefined,
          params.region ? String(params.region) : undefined,
          params.accountId ? String(params.accountId) : undefined
        )
      case 'proxyLoadLogs':
        return this.proxyLoadRecentLogs()
      case 'proxySaveLogs':
        return this.proxySaveRecentLogs((params.logs as UiRecentLog[]) || [])
      case 'proxyGetApiKeys':
        return this.proxyGetApiKeys()
      case 'proxyAddApiKey':
        return this.proxyAddApiKey(
          (params.apiKey || {}) as {
            name?: string
            key?: string
            format?: 'sk' | 'simple' | 'token'
            creditsLimit?: number
          }
        )
      case 'proxyUpdateApiKey':
        return this.proxyUpdateApiKey(String(params.id || ''), (params.updates || {}) as Record<string, unknown>)
      case 'proxyDeleteApiKey':
        return this.proxyDeleteApiKey(String(params.id || ''))
      case 'proxyResetApiKeyUsage':
        return this.proxyResetApiKeyUsage(String(params.id || ''))
      default:
        throw new Error(`Unsupported renderer method: ${method || 'unknown'}`)
    }
  }

  async importContent(content: string, formatHint?: string): Promise<ImportResult> {
    const candidates = this.parseImportContent(content, formatHint)
    const result: ImportResult = { success: 0, failed: 0, updated: 0, errors: [] }

    for (const candidate of candidates) {
      try {
        const existing = this.findAccount(candidate.email, candidate.provider)
        if (existing) {
          existing.nickname = candidate.nickname || existing.nickname
          existing.credentials.refreshToken = candidate.refreshToken
          existing.credentials.clientId = candidate.clientId
          existing.credentials.clientSecret = candidate.clientSecret
          existing.credentials.region = candidate.region || existing.credentials.region
          existing.credentials.provider = normalizeProvider(candidate.provider)
          existing.credentials.authMethod = normalizeAuthMethod(
            candidate.provider,
            candidate.authMethod
          )
          existing.credentials.accessToken = candidate.accessToken || ''
          existing.credentials.expiresAt = candidate.accessToken ? Date.now() + 3600 * 1000 : undefined
          existing.status = candidate.accessToken ? 'active' : 'unknown'
          existing.lastError = undefined
          result.updated++
        } else {
          this.state.accounts.push(
            buildStoredAccountFromImport({
              id: crypto.randomUUID(),
              ...candidate
            })
          )
          result.success++
        }
      } catch (error) {
        result.failed++
        result.errors.push({
          message: error instanceof Error ? error.message : 'Failed to import row'
        })
      }
    }

    this.saveState()
    this.syncProxyAccounts()
    return result
  }

  async verifyAccount(id: string): Promise<StoredAccount> {
    const account = this.requireAccount(id)

    try {
      const result = await verifyStoredAccount(account)
      account.email = result.email
      account.userId = result.userId
      account.credentials.accessToken = result.accessToken
      account.credentials.refreshToken = result.refreshToken
      account.credentials.expiresAt = result.expiresAt
      account.subscription = result.subscription
      account.usage = result.usage
      account.status = 'active'
      account.lastError = undefined
      account.lastCheckedAt = Date.now()
      this.saveState()
      this.syncProxyAccounts()
      return account
    } catch (error) {
      account.status = 'error'
      account.lastError = error instanceof Error ? error.message : 'Verification failed'
      account.lastCheckedAt = Date.now()
      this.saveState()
      throw error
    }
  }

  async verifyAll(): Promise<{ success: number; failed: number; errors: Array<{ id: string; message: string }> }> {
    const result = { success: 0, failed: 0, errors: [] as Array<{ id: string; message: string }> }

    for (const account of this.state.accounts) {
      try {
        await this.verifyAccount(account.id)
        result.success++
      } catch (error) {
        result.failed++
        result.errors.push({
          id: account.id,
          message: error instanceof Error ? error.message : 'Verification failed'
        })
      }
    }

    this.syncProxyAccounts()
    return result
  }

  async deleteAccount(id: string): Promise<void> {
    this.state.accounts = this.state.accounts.filter((account) => account.id !== id)
    this.saveState()
    this.syncProxyAccounts()
  }

  async startProxy(config?: Partial<ProxyConfig>): Promise<void> {
    if (config) {
      await this.updateProxyConfig(config)
    }

    if (this.proxyServer.isRunning()) {
      await this.proxyServer.stop()
    }

    this.state.proxyConfig.enabled = true
    this.proxyServer.updateConfig(this.state.proxyConfig)
    this.syncProxyAccounts()
    await this.proxyServer.start()
    this.saveState()
  }

  async stopProxy(): Promise<void> {
    this.state.proxyConfig.enabled = false
    if (this.proxyServer.isRunning()) {
      await this.proxyServer.stop()
    }
    this.saveState()
  }

  async updateProxyConfig(config: Partial<ProxyConfig>): Promise<ProxyConfig> {
    this.state.proxyConfig = {
      ...this.state.proxyConfig,
      ...config
    }
    this.proxyServer.updateConfig(this.state.proxyConfig)
    this.saveState()
    return this.state.proxyConfig
  }

  private getPackageVersion(): string {
    if (this.packageVersionCache) {
      return this.packageVersionCache
    }

    try {
      const pkg = JSON.parse(fs.readFileSync(this.packageJsonPath, 'utf8')) as { version?: string }
      this.packageVersionCache = pkg.version || '0.0.0'
    } catch {
      this.packageVersionCache = '0.0.0'
    }

    return this.packageVersionCache
  }

  private loadRendererState(): RendererStoreData | null {
    return this.hydrateRendererState({
      syncProxy: this.state.proxyConfig.enabled || this.proxyServer.isRunning()
    })
  }

  private saveRendererState(data: unknown, options?: { allowEmptyAccounts?: boolean }): void {
    const parsed = this.normalizeRendererStateData(data)
    if (!parsed) {
      throw new Error('Invalid renderer state payload')
    }

    const snapshot = this.readRendererStateSnapshot()
    const existingCount = Math.max(
      this.state.accounts.length,
      this.getRendererAccountCount(this.rendererStateCache),
      this.getRendererAccountCount(snapshot.data)
    )
    const nextCount = this.getRendererAccountCount(parsed)
    const allowEmptyAccounts = options?.allowEmptyAccounts === true

    if (nextCount === 0 && existingCount > 0 && !allowEmptyAccounts) {
      throw new Error('Refusing to overwrite existing renderer accounts with an empty account set')
    }

    this.stateDatabase.saveRendererState(parsed as PersistedRendererState)
    this.writeRendererStateFile(parsed)

    this.hydrateRendererState({
      force: true,
      nextData: parsed,
      syncProxy: this.state.proxyConfig.enabled || this.proxyServer.isRunning(),
      persistState: true,
      allowEmptyAccounts
    })
  }

  private hydrateRendererState(options: {
    force?: boolean
    syncProxy?: boolean
    persistState?: boolean
    nextData?: RendererStoreData | null
    allowEmptyAccounts?: boolean
  } = {}): RendererStoreData | null {
    const { force = false, syncProxy = false, persistState = false, allowEmptyAccounts = false } = options
    let data = options.nextData
    let mtimeMs: number | null = null

    if (typeof data === 'undefined') {
      const snapshot = this.readRendererStateSnapshot()
      mtimeMs = snapshot.updatedAt

      if (!force && this.rendererStateCacheLoaded && this.rendererStateMtimeMs === mtimeMs) {
        return this.rendererStateCache
      }

      data = snapshot.data
    } else {
      mtimeMs = Date.now()
    }

    let safeData = this.normalizeRendererStateData(data)
    const existingCount = this.state.accounts.length
    const nextCount = this.getRendererAccountCount(safeData)

    if (!allowEmptyAccounts && existingCount > 0 && nextCount === 0) {
      const restored = this.restoreRendererStateFromBackup() || this.buildRendererStateFromStoredAccounts(safeData)
      if (restored) {
        safeData = restored
        this.stateDatabase.saveRendererState(restored as PersistedRendererState)
        this.writeRendererStateFile(restored, false)
        mtimeMs = Date.now()
      }
    }

    if (safeData && !fs.existsSync(this.rendererStateFile)) {
      this.writeRendererStateFile(safeData, false)
      mtimeMs = Date.now()
    }

    this.rendererStateCache = safeData
    this.rendererStateMtimeMs = mtimeMs
    this.rendererStateCacheLoaded = true

    if (safeData?.accounts && typeof safeData.accounts === 'object') {
      this.state.accounts = this.convertRendererAccountRecord(safeData.accounts)
      if (persistState) {
        this.saveState()
      }
      if (syncProxy) {
        this.syncProxyAccounts()
      }
    }

    return safeData
  }

  private async verifyRendererCredentials(credentials: RendererCredentialsLike): Promise<{
    success: boolean
    data?: {
      email: string
      userId: string
      accessToken: string
      refreshToken: string
      expiresIn?: number
      subscriptionType: string
      subscriptionTitle: string
      subscription?: {
        rawType?: string
        managementTarget?: string
        upgradeCapability?: string
        overageCapability?: string
      }
      usage: {
        current: number
        limit: number
        baseLimit?: number
        baseCurrent?: number
        freeTrialLimit?: number
        freeTrialCurrent?: number
        freeTrialExpiry?: string
        bonuses?: Array<{ code: string; name: string; current: number; limit: number; expiresAt?: string }>
        nextResetDate?: string
        resourceDetail?: {
          displayName?: string
          displayNamePlural?: string
          resourceType?: string
          currency?: string
          unit?: string
          overageRate?: number
          overageCap?: number
          overageEnabled?: boolean
        }
      }
      daysRemaining?: number
      expiresAt?: number
    }
    error?: string
  }> {
    try {
      const account = this.buildStoredAccountFromCredentials(credentials)
      const result = await verifyStoredAccount(account)
      const expiresIn =
        result.expiresAt !== undefined ? Math.max(0, Math.floor((result.expiresAt - Date.now()) / 1000)) : undefined

      return {
        success: true,
        data: {
          email: result.email,
          userId: result.userId || '',
          accessToken: result.accessToken,
          refreshToken: result.refreshToken,
          expiresIn,
          subscriptionType: result.subscription.type,
          subscriptionTitle: result.subscription.title || result.subscription.type,
          subscription: {
            rawType: result.subscription.rawType,
            managementTarget: result.subscription.managementTarget,
            upgradeCapability: result.subscription.upgradeCapability,
            overageCapability: result.subscription.overageCapability
          },
          usage: {
            ...result.usage
          },
          daysRemaining: result.subscription.daysRemaining,
          expiresAt: result.subscription.expiresAt
        }
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Credential verification failed'
      }
    }
  }

  private async refreshRendererAccount(accountLike: BackgroundAccountLike): Promise<{
    success: boolean
    data?: {
      accessToken: string
      refreshToken?: string
      expiresIn: number
    }
    error?: { message: string }
  }> {
    try {
      const account = this.buildStoredAccountFromBackground(accountLike)
      const result = await refreshTokenByMethod(account)
      if (!result.success || !result.accessToken) {
        return { success: false, error: { message: result.error || 'Token refresh failed' } }
      }

      return {
        success: true,
        data: {
          accessToken: result.accessToken,
          refreshToken: result.refreshToken,
          expiresIn: result.expiresIn || 3600
        }
      }
    } catch (error) {
      return {
        success: false,
        error: { message: error instanceof Error ? error.message : 'Token refresh failed' }
      }
    }
  }

  private async checkRendererAccount(accountLike: BackgroundAccountLike): Promise<{
    success: boolean
    data?: {
      status: string
      email?: string
      userId?: string
      idp?: string
      subscriptionTitle?: string
      usage?: {
        current: number
        limit: number
        percentUsed: number
        lastUpdated: number
        baseLimit?: number
        baseCurrent?: number
        freeTrialLimit?: number
        freeTrialCurrent?: number
        freeTrialExpiry?: string
        bonuses?: Array<{ code: string; name: string; current: number; limit: number; expiresAt?: string }>
        nextResetDate?: string
        resourceDetail?: {
          displayName?: string
          displayNamePlural?: string
          resourceType?: string
          currency?: string
          unit?: string
          overageRate?: number
          overageCap?: number
          overageEnabled?: boolean
        }
      }
      subscription?: {
        type: string
        title?: string
        rawType?: string
        expiresAt?: number
        daysRemaining?: number
        upgradeCapability?: string
        overageCapability?: string
        managementTarget?: string
      }
      newCredentials?: {
        accessToken: string
        refreshToken?: string
        expiresAt?: number
      }
    }
    error?: { message: string; isBanned?: boolean }
  }> {
    try {
      const account = this.buildStoredAccountFromBackground(accountLike)
      const result = await verifyStoredAccount(account, {
        allowRefresh: accountLike.needsTokenRefresh !== false
      })

      return {
        success: true,
        data: {
          status: 'active',
          email: result.email,
          userId: result.userId,
          idp: account.credentials.provider,
          subscriptionTitle: result.subscription.title,
          usage: {
            ...result.usage,
            lastUpdated: Date.now()
          },
          subscription: result.subscription,
          newCredentials: {
            accessToken: result.accessToken,
            refreshToken: result.refreshToken,
            expiresAt: result.expiresAt
          }
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Status check failed'
      const lowerMessage = message.toLowerCase()
      return {
        success: false,
        error: {
          message,
          isBanned: lowerMessage.includes('403') || lowerMessage.includes('423') || lowerMessage.includes('suspended')
        }
      }
    }
  }

  private toDesktopStatusPayload(
    payload: NonNullable<Awaited<ReturnType<WebProxyService['checkRendererAccount']>>['data']>,
    options: { includeNewCredentials: boolean }
  ): {
    usage: NonNullable<typeof payload.usage> | undefined
    subscription: NonNullable<typeof payload.subscription> | undefined
    userInfo: { email?: string; userId?: string } | undefined
    status: string
    errorMessage?: string
    newCredentials?: { accessToken: string; refreshToken?: string; expiresAt?: number }
    idp?: string
    subscriptionTitle?: string
  } {
    return {
      usage: payload.usage,
      subscription: payload.subscription,
      userInfo: payload.email || payload.userId
        ? {
            email: payload.email,
            userId: payload.userId
          }
        : undefined,
      status: payload.status,
      errorMessage: undefined,
      newCredentials: options.includeNewCredentials ? payload.newCredentials : undefined,
      idp: payload.idp,
      subscriptionTitle: payload.subscriptionTitle
    }
  }

  private toBackgroundStatusFromError(message: string): {
    status: 'expired' | 'error'
    errorMessage: string
    needsRefresh?: boolean
  } {
    const normalized = message.toLowerCase()
    if (normalized.includes('401')) {
      return {
        status: 'expired',
        errorMessage: message,
        needsRefresh: true
      }
    }

    return {
      status: 'error',
      errorMessage: message
    }
  }

  private async backgroundRefresh(
    accounts: BackgroundAccountLike[],
    concurrency: number,
    syncInfo: boolean
  ): Promise<{
    success: boolean
    completed: number
    successCount: number
    failedCount: number
    results: Array<{ id: string; success: boolean; data?: unknown; error?: string }>
  }>{
    return this.runConcurrent(accounts, concurrency, async (account) => {
      const credentials = this.getNormalizedCredentials(account)
      let accessToken = credentials.accessToken
      let refreshToken = credentials.refreshToken
      let expiresIn: number | undefined

      if (account.needsTokenRefresh !== false || !accessToken) {
        const refreshResult = await this.refreshRendererAccount(account)
        if (!refreshResult.success || !refreshResult.data?.accessToken) {
          return {
            id: String(account.id || ''),
            success: false,
            error: refreshResult.error?.message || 'Token refresh failed'
          }
        }

        accessToken = refreshResult.data.accessToken
        refreshToken = refreshResult.data.refreshToken || refreshToken
        expiresIn = refreshResult.data.expiresIn
      }

      if (!accessToken) {
        return {
          id: String(account.id || ''),
          success: false,
          error: 'Missing access token'
        }
      }

      if (!syncInfo) {
        return {
          id: String(account.id || ''),
          success: true,
          data: {
            accessToken,
            refreshToken,
            expiresIn
          }
        }
      }

      const result = await this.checkRendererAccount({
        ...account,
        needsTokenRefresh: false,
        credentials: {
          ...credentials,
          accessToken,
          refreshToken,
          expiresAt: expiresIn ? Date.now() + expiresIn * 1000 : credentials.expiresAt
        }
      })
      const payload = result.data
      return {
        id: String(account.id || ''),
        success: true,
        data: payload
          ? {
              accessToken: payload.newCredentials?.accessToken || accessToken,
              refreshToken: payload.newCredentials?.refreshToken || refreshToken,
              expiresIn: payload.newCredentials?.expiresAt
                ? Math.max(0, Math.floor((payload.newCredentials.expiresAt - Date.now()) / 1000))
                : expiresIn,
              ...this.toDesktopStatusPayload(payload, { includeNewCredentials: true })
            }
          : {
              accessToken,
              refreshToken,
              expiresIn,
              ...this.toBackgroundStatusFromError(result.error?.message || 'Status check failed')
            }
      }
    })
  }

  private async backgroundCheck(accounts: BackgroundAccountLike[], concurrency: number): Promise<{
    success: boolean
    completed: number
    successCount: number
    failedCount: number
    results: Array<{ id: string; success: boolean; data?: unknown; error?: string }>
  }> {
    return this.runConcurrent(accounts, concurrency, async (account) => {
      const credentials = this.getNormalizedCredentials(account)
      if (!credentials.accessToken) {
        return {
          id: String(account.id || ''),
          success: false,
          error: 'Missing access token'
        }
      }

      const result = await this.checkRendererAccount({
        ...account,
        needsTokenRefresh: false
      })
      return {
        id: String(account.id || ''),
        success: true,
        data: result.data
          ? this.toDesktopStatusPayload(result.data, { includeNewCredentials: false })
          : this.toBackgroundStatusFromError(result.error?.message || 'Status check failed'),
        error: undefined
      }
    })
  }

  private async getProxyStatus(): Promise<{
    running: boolean
    config: ProxyConfig
    stats: ReturnType<ProxyServer['getStats']>
    sessionStats: ReturnType<ProxyServer['getSessionStats']>
  }> {
    return {
      running: this.proxyServer.isRunning(),
      config: this.proxyServer.isRunning() ? this.proxyServer.getConfig() : this.state.proxyConfig,
      stats: this.proxyServer.getStats(),
      sessionStats: this.proxyServer.getSessionStats()
    }
  }

  private async proxyStart(config: Partial<ProxyConfig>): Promise<{ success: boolean; port?: number; error?: string }> {
    try {
      await this.startProxy(config)
      return { success: true, port: this.state.proxyConfig.port }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to start proxy'
      }
    }
  }

  private async proxyStop(): Promise<{ success: boolean; error?: string }> {
    try {
      await this.stopProxy()
      return { success: true }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to stop proxy'
      }
    }
  }

  private async proxyUpdateConfig(config: Partial<ProxyConfig>): Promise<{ success: boolean; config?: ProxyConfig; error?: string }> {
    try {
      const updated = await this.updateProxyConfig(config)
      return { success: true, config: updated }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to update proxy config'
      }
    }
  }

  private async proxySyncAccounts(accounts: RendererAccountLike[]): Promise<{ success: boolean; accountCount: number; error?: string }> {
    try {
      this.state.accounts = accounts.map((account) => this.convertRendererAccount(account))
      this.saveState()
      this.syncProxyAccounts()
      return { success: true, accountCount: this.getEligibleAccounts().length }
    } catch (error) {
      return {
        success: false,
        accountCount: this.getEligibleAccounts().length,
        error: error instanceof Error ? error.message : 'Failed to sync accounts'
      }
    }
  }

  private proxyGetAccounts(): { accounts: ProxyAccount[]; availableCount: number; rateLimitedCount: number } {
    const pool = this.proxyServer.getAccountPool()
    return {
      accounts: pool.getAllAccounts(),
      availableCount: pool.availableCount,
      rateLimitedCount: pool.rateLimitedCount
    }
  }

  private proxyResetPool(): { success: boolean; error?: string } {
    this.proxyServer.getAccountPool().reset()
    return { success: true }
  }

  private proxyResetAccountState(accountId: string): { success: boolean; error?: string } {
    this.proxyServer.getAccountPool().resetAccountState(accountId)
    return { success: true }
  }

  private proxyResetCredits(): { success: boolean } {
    this.proxyServer.resetTotalCredits()
    return { success: true }
  }

  private proxyResetTokens(): { success: boolean } {
    this.proxyServer.resetTotalTokens()
    return { success: true }
  }

  private proxyResetRequestStats(): { success: boolean } {
    this.proxyServer.resetRequestStats()
    return { success: true }
  }

  private proxyGetLogs(count: number): Array<{
    timestamp: string
    level: string
    category: string
    message: string
    data?: unknown
  }> {
    return proxyLogStore.getLast(count)
  }

  private proxyClearLogs(): { success: boolean } {
    proxyLogStore.clear()
    return { success: true }
  }

  private proxyGetLogsCount(): number {
    return proxyLogStore.count()
  }

  private async proxyRefreshModels(): Promise<{ success: boolean; error?: string }> {
    try {
      this.proxyServer.clearModelCache()
      await this.proxyServer.getAvailableModels()
      return { success: true }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to refresh models'
      }
    }
  }

  private async proxyGetModels(): Promise<{
    success: boolean
    error?: string
    models: Array<{
      id: string
      name: string
      description: string
      inputTypes?: string[]
      maxInputTokens?: number | null
      maxOutputTokens?: number | null
      rateMultiplier?: number
      rateUnit?: string
    }>
    fromCache?: boolean
  }> {
    try {
      const result = await this.proxyServer.getAvailableModels()
      return {
        success: true,
        models: result.models,
        fromCache: result.fromCache
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get models',
        models: []
      }
    }
  }

  private async accountGetModels(accessToken: string, region?: string, profileArn?: string, accountId?: string): Promise<{
    success: boolean
    error?: string
    models: Array<{
      id: string
      name: string
      description: string
      inputTypes?: string[]
      maxInputTokens?: number | null
      maxOutputTokens?: number | null
      rateMultiplier?: number
      rateUnit?: string
    }>
  }> {
    try {
      const proxyAccount = await this.resolveProxyAccountForRequest({
        accountId,
        accessToken,
        region,
        profileArn,
        fallbackId: 'web-account-models'
      })
      const models = await fetchKiroModels(proxyAccount)

      return {
        success: true,
        models: models.map((model) => ({
          id: model.modelId,
          name: model.modelName,
          description: model.description,
          inputTypes: model.supportedInputTypes,
          maxInputTokens: model.tokenLimits?.maxInputTokens,
          maxOutputTokens: model.tokenLimits?.maxOutputTokens,
          rateMultiplier: model.rateMultiplier,
          rateUnit: model.rateUnit
        }))
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get account models',
        models: []
      }
    }
  }

  private async accountGetSubscriptions(accessToken: string, region?: string, accountId?: string): Promise<{
    success: boolean
    error?: string
    plans: Array<{
      name: string
      qSubscriptionType: string
      description: { title: string; billingInterval: string; featureHeader: string; features: string[] }
      pricing: { amount: number; currency: string }
    }>
    disclaimer?: string[]
  }> {
    try {
      const proxyAccount = await this.resolveProxyAccountForRequest({
        accountId,
        accessToken,
        region,
        fallbackId: 'web-account-subscriptions'
      })
      const result = await fetchAvailableSubscriptions(proxyAccount)

      if (result.subscriptionPlans) {
        return {
          success: true,
          plans: result.subscriptionPlans,
          disclaimer: result.disclaimer
        }
      }

      return { success: false, error: 'No subscription plans returned', plans: [] }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get subscriptions',
        plans: []
      }
    }
  }

  private async accountGetSubscriptionUrl(
    accessToken: string,
    subscriptionType?: string,
    region?: string,
    accountId?: string
  ): Promise<{
    success: boolean
    error?: string
    url?: string
    status?: string
  }> {
    try {
      const proxyAccount = await this.resolveProxyAccountForRequest({
        accountId,
        accessToken,
        region,
        fallbackId: 'web-account-subscription-url'
      })
      const result = await fetchSubscriptionToken(proxyAccount, subscriptionType)

      if (result.encodedVerificationUrl) {
        return { success: true, url: result.encodedVerificationUrl, status: result.status }
      }

      return { success: false, error: result.message || 'No subscription URL returned' }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get subscription URL'
      }
    }
  }

  private proxyLoadRecentLogs(): { success: boolean; logs: UiRecentLog[] } {
    return {
      success: true,
      logs: this.readJsonFile<UiRecentLog[]>(this.uiLogsFile, [])
    }
  }

  private proxySaveRecentLogs(logs: UiRecentLog[]): { success: boolean; error?: string } {
    try {
      fs.writeFileSync(this.uiLogsFile, JSON.stringify(logs, null, 2), 'utf8')
      return { success: true }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to save logs'
      }
    }
  }

  private proxyGetApiKeys(): { success: boolean; apiKeys: ApiKey[]; error?: string } {
    return {
      success: true,
      apiKeys: this.state.proxyConfig.apiKeys || []
    }
  }

  private proxyAddApiKey(input: {
    name?: string
    key?: string
    format?: 'sk' | 'simple' | 'token'
    creditsLimit?: number
  }): { success: boolean; apiKey?: ApiKey; error?: string } {
    if (!input.name?.trim()) {
      return { success: false, error: 'API key name is required' }
    }

    const format = input.format || 'sk'
    const apiKey: ApiKey = {
      id: crypto.randomUUID(),
      name: input.name.trim(),
      key: input.key || this.generateApiKey(format),
      format,
      enabled: true,
      createdAt: Date.now(),
      creditsLimit: input.creditsLimit && input.creditsLimit > 0 ? input.creditsLimit : undefined,
      usage: createEmptyApiKeyUsage()
    }

    const nextKeys = [...(this.state.proxyConfig.apiKeys || []), apiKey]
    this.state.proxyConfig.apiKeys = nextKeys
    this.proxyServer.updateConfig({ apiKeys: nextKeys })
    this.saveState()

    return { success: true, apiKey }
  }

  private proxyUpdateApiKey(
    id: string,
    updates: {
      name?: string
      key?: string
      enabled?: boolean
      creditsLimit?: number | null
    }
  ): { success: boolean; apiKey?: ApiKey; error?: string } {
    const apiKeys = [...(this.state.proxyConfig.apiKeys || [])]
    const index = apiKeys.findIndex((item) => item.id === id)
    if (index < 0) {
      return { success: false, error: 'API key not found' }
    }

    const current = apiKeys[index]
    const next: ApiKey = {
      ...current,
      name: typeof updates.name === 'string' ? updates.name : current.name,
      key: typeof updates.key === 'string' ? updates.key : current.key,
      enabled: typeof updates.enabled === 'boolean' ? updates.enabled : current.enabled,
      creditsLimit:
        updates.creditsLimit === null
          ? undefined
          : typeof updates.creditsLimit === 'number'
            ? updates.creditsLimit
            : current.creditsLimit
    }

    apiKeys[index] = next
    this.state.proxyConfig.apiKeys = apiKeys
    this.proxyServer.updateConfig({ apiKeys })
    this.saveState()

    return { success: true, apiKey: next }
  }

  private proxyDeleteApiKey(id: string): { success: boolean; error?: string } {
    const apiKeys = [...(this.state.proxyConfig.apiKeys || [])]
    const nextKeys = apiKeys.filter((item) => item.id !== id)
    if (nextKeys.length === apiKeys.length) {
      return { success: false, error: 'API key not found' }
    }

    this.state.proxyConfig.apiKeys = nextKeys
    this.proxyServer.updateConfig({ apiKeys: nextKeys })
    this.saveState()
    return { success: true }
  }

  private proxyResetApiKeyUsage(id: string): { success: boolean; error?: string } {
    const apiKeys = [...(this.state.proxyConfig.apiKeys || [])]
    const index = apiKeys.findIndex((item) => item.id === id)
    if (index < 0) {
      return { success: false, error: 'API key not found' }
    }

    apiKeys[index] = {
      ...apiKeys[index],
      usage: createEmptyApiKeyUsage(),
      usageHistory: []
    }

    this.state.proxyConfig.apiKeys = apiKeys
    this.proxyServer.updateConfig({ apiKeys })
    this.saveState()
    return { success: true }
  }

  private generateApiKey(format: 'sk' | 'simple' | 'token'): string {
    const randomText = (length: number): string => {
      const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
      return Array.from({ length }, () => chars[Math.floor(Math.random() * chars.length)]).join('')
    }

    if (format === 'simple') {
      return `PROXY_KEY_${randomText(32).toUpperCase()}`
    }

    if (format === 'token') {
      return `PROXY_KEY:${randomText(32)}`
    }

    return `sk-${randomText(48)}`
  }

  private buildStoredAccountFromCredentials(credentials: RendererCredentialsLike): StoredAccount {
    const provider = normalizeProvider(credentials.provider)

    return {
      id: crypto.randomUUID(),
      email: `web-${Date.now()}@placeholder.local`,
      machineId: generateMachineId(),
      status: 'unknown',
      createdAt: Date.now(),
      credentials: {
        accessToken: credentials.accessToken || '',
        refreshToken: credentials.refreshToken || '',
        clientId: credentials.clientId,
        clientSecret: credentials.clientSecret,
        region: credentials.region || 'us-east-1',
        authMethod: normalizeAuthMethod(provider, credentials.authMethod),
        provider,
        expiresAt: credentials.expiresAt
      },
      usage: {
        current: 0,
        limit: 0,
        percentUsed: 0
      },
      subscription: {
        type: 'Free'
      }
    }
  }

  private getNormalizedCredentials(
    account: Pick<
      BackgroundAccountLike & RendererAccountLike,
      | 'credentials'
      | 'accessToken'
      | 'refreshToken'
      | 'clientId'
      | 'clientSecret'
      | 'region'
      | 'authMethod'
      | 'provider'
      | 'expiresAt'
    >
  ): RendererCredentialsLike {
    return {
      ...(account.credentials || {}),
      accessToken: account.credentials?.accessToken || account.accessToken,
      refreshToken: account.credentials?.refreshToken || account.refreshToken,
      clientId: account.credentials?.clientId || account.clientId,
      clientSecret: account.credentials?.clientSecret || account.clientSecret,
      region: account.credentials?.region || account.region,
      authMethod: account.credentials?.authMethod || account.authMethod,
      provider: account.credentials?.provider || account.provider,
      expiresAt: account.credentials?.expiresAt || account.expiresAt
    }
  }

  private buildStoredAccountFromBackground(account: BackgroundAccountLike): StoredAccount {
    const credentials = this.getNormalizedCredentials(account)
    const provider = normalizeProvider(credentials.provider || account.idp)

    return {
      id: String(account.id || crypto.randomUUID()),
      email: account.email || `${account.id || 'account'}@placeholder.local`,
      nickname: account.nickname,
      userId: account.userId,
      profileArn: account.profileArn,
      machineId: account.machineId || generateMachineId(),
      status: this.normalizeStoredStatus(account.status, Boolean(credentials.accessToken)),
      lastError: account.lastError,
      createdAt: account.createdAt || Date.now(),
      lastCheckedAt: account.lastCheckedAt,
      credentials: {
        accessToken: credentials.accessToken || '',
        refreshToken: credentials.refreshToken || '',
        clientId: credentials.clientId,
        clientSecret: credentials.clientSecret,
        region: credentials.region || 'us-east-1',
        authMethod: normalizeAuthMethod(provider, credentials.authMethod),
        provider,
        expiresAt: credentials.expiresAt
      },
      usage: {
        current: account.usage?.current || 0,
        limit: account.usage?.limit || 0,
        percentUsed:
          typeof account.usage?.percentUsed === 'number'
            ? account.usage.percentUsed
            : account.usage?.limit
              ? (account.usage.current || 0) / account.usage.limit
              : 0,
        baseLimit: account.usage?.baseLimit,
        baseCurrent: account.usage?.baseCurrent,
        freeTrialLimit: account.usage?.freeTrialLimit,
        freeTrialCurrent: account.usage?.freeTrialCurrent,
        freeTrialExpiry: account.usage?.freeTrialExpiry,
        bonuses: account.usage?.bonuses,
        nextResetDate: account.usage?.nextResetDate,
        resourceDetail: account.usage?.resourceDetail
      },
      subscription: {
        type: account.subscription?.type || 'Free',
        title: account.subscription?.title,
        rawType: account.subscription?.rawType,
        expiresAt: account.subscription?.expiresAt,
        daysRemaining: account.subscription?.daysRemaining,
        managementTarget: account.subscription?.managementTarget,
        upgradeCapability: account.subscription?.upgradeCapability,
        overageCapability: account.subscription?.overageCapability
      }
    }
  }

  private convertRendererAccountRecord(accounts: Record<string, RendererAccountLike>): StoredAccount[] {
    return Object.entries(accounts).map(([id, account]) => this.convertRendererAccount({ ...account, id }))
  }

  private convertRendererAccount(account: RendererAccountLike): StoredAccount {
    const credentials = this.getNormalizedCredentials(account)
    const provider = normalizeProvider(credentials.provider || account.idp)
    const usage = account.usage || {}
    const subscription = account.subscription || {}

    return {
      id: String(account.id || crypto.randomUUID()),
      email: account.email || `${account.id || 'account'}@placeholder.local`,
      nickname: account.nickname,
      userId: account.userId,
      profileArn: account.profileArn,
      machineId: account.machineId || generateMachineId(),
      status: this.normalizeStoredStatus(account.status, Boolean(credentials.accessToken)),
      lastError: account.lastError,
      createdAt: account.createdAt || Date.now(),
      lastCheckedAt: account.lastCheckedAt,
      credentials: {
        accessToken: credentials.accessToken || '',
        refreshToken: credentials.refreshToken || '',
        clientId: credentials.clientId,
        clientSecret: credentials.clientSecret,
        region: credentials.region || 'us-east-1',
        authMethod: normalizeAuthMethod(provider, credentials.authMethod),
        provider,
        expiresAt: credentials.expiresAt
      },
      usage: {
        current: usage.current || 0,
        limit: usage.limit || 0,
        percentUsed:
          typeof usage.percentUsed === 'number'
            ? usage.percentUsed
            : usage.limit
              ? (usage.current || 0) / usage.limit
              : 0,
        baseLimit: usage.baseLimit,
        baseCurrent: usage.baseCurrent,
        freeTrialLimit: usage.freeTrialLimit,
        freeTrialCurrent: usage.freeTrialCurrent,
        freeTrialExpiry: usage.freeTrialExpiry,
        bonuses: usage.bonuses,
        nextResetDate: usage.nextResetDate,
        resourceDetail: usage.resourceDetail
      },
      subscription: {
        type: subscription.type || 'Free',
        title: subscription.title,
        rawType: subscription.rawType,
        expiresAt: subscription.expiresAt,
        daysRemaining: subscription.daysRemaining,
        managementTarget: subscription.managementTarget,
        upgradeCapability: subscription.upgradeCapability,
        overageCapability: subscription.overageCapability
      }
    }
  }

  private normalizeStoredStatus(status: string | undefined, hasAccessToken: boolean): StoredAccount['status'] {
    if (status === 'active' || status === 'expired' || status === 'error' || status === 'unknown') {
      return status
    }
    return hasAccessToken ? 'active' : 'unknown'
  }

  private canRefreshStoredAccount(account: StoredAccount): boolean {
    const credentials = account.credentials
    if (!credentials.refreshToken) {
      return false
    }

    if (credentials.authMethod === 'social') {
      return true
    }

    return Boolean(credentials.clientId && credentials.clientSecret)
  }

  private needsStoredAccountRefresh(account: StoredAccount): boolean {
    if (!account.credentials.accessToken) {
      return true
    }

    if (!account.credentials.expiresAt) {
      return false
    }

    const refreshBeforeMs = (this.state.proxyConfig.tokenRefreshBeforeExpiry || 300) * 1000
    return Date.now() + refreshBeforeMs >= account.credentials.expiresAt
  }

  private async refreshStoredAccountCredentials(account: StoredAccount): Promise<void> {
    const result = await refreshTokenByMethod(account)
    if (!result.success || !result.accessToken) {
      throw new Error(result.error || 'Token refresh failed')
    }

    account.credentials.accessToken = result.accessToken
    account.credentials.refreshToken = result.refreshToken || account.credentials.refreshToken
    account.credentials.expiresAt = result.expiresIn
      ? Date.now() + result.expiresIn * 1000
      : account.credentials.expiresAt
    account.status = 'active'
    account.lastError = undefined
    account.lastCheckedAt = Date.now()
    this.saveState()
    this.syncProxyAccounts()
  }

  private findStoredAccountForRequest(input: {
    accountId?: string
    accessToken?: string
    region?: string
    profileArn?: string
  }): StoredAccount | undefined {
    if (input.accountId) {
      const matchedById = this.state.accounts.find((account) => account.id === input.accountId)
      if (matchedById) {
        return matchedById
      }
    }

    if (input.accessToken) {
      const matchedByToken = this.state.accounts.find(
        (account) => account.credentials.accessToken === input.accessToken
      )
      if (matchedByToken) {
        return matchedByToken
      }
    }

    return this.state.accounts.find((account) => {
      if (input.profileArn && account.profileArn !== input.profileArn) {
        return false
      }

      if (input.region && account.credentials.region !== input.region) {
        return false
      }

      return Boolean(account.credentials.accessToken || this.canRefreshStoredAccount(account))
    })
  }

  private async resolveProxyAccountForRequest(input: {
    accountId?: string
    accessToken?: string
    region?: string
    profileArn?: string
    fallbackId: string
  }): Promise<ProxyAccount> {
    const stored = this.findStoredAccountForRequest(input)
    if (stored) {
      if (this.needsStoredAccountRefresh(stored)) {
        if (!this.canRefreshStoredAccount(stored)) {
          if (!stored.credentials.accessToken) {
            throw new Error('Account is missing access token and cannot be refreshed')
          }
        } else {
          await this.refreshStoredAccountCredentials(stored)
        }
      }

      return toProxyAccount(stored)
    }

    if (!input.accessToken) {
      throw new Error('Account access token is missing')
    }

    return {
      id: input.fallbackId,
      accessToken: input.accessToken,
      region: input.region || 'us-east-1',
      profileArn: input.profileArn
    }
  }

  private async runConcurrent<T, TResult extends { success: boolean }>(
    items: T[],
    concurrency: number,
    handler: (item: T) => Promise<TResult>
  ): Promise<{
    success: boolean
    completed: number
    successCount: number
    failedCount: number
    results: TResult[]
  }> {
    const workerCount = Math.max(1, Math.min(concurrency || 1, items.length || 1))
    const results: TResult[] = []
    let cursor = 0

    const workers = Array.from({ length: workerCount }, async () => {
      while (cursor < items.length) {
        const index = cursor++
        results[index] = await handler(items[index])
      }
    })

    await Promise.all(workers)

    const successCount = results.filter((item) => item.success).length
    const failedCount = results.length - successCount

    return {
      success: failedCount === 0,
      completed: results.length,
      successCount,
      failedCount,
      results
    }
  }

  private syncProxyAccounts(): void {
    const pool = this.proxyServer.getAccountPool()
    pool.clear()

    for (const account of this.getEligibleAccounts()) {
      pool.addAccount(toProxyAccount(account))
    }
  }

  private getEligibleAccounts(): StoredAccount[] {
    return this.state.accounts.filter(
      (account) =>
        account.status !== 'error' &&
        (Boolean(account.credentials.accessToken) || this.canRefreshStoredAccount(account))
    )
  }

  private normalizeRendererStateData(data: unknown): RendererStoreData | null {
    return data && typeof data === 'object' ? (data as RendererStoreData) : null
  }

  private readRendererStateSnapshot(): { data: RendererStoreData | null; updatedAt: number | null } {
    const snapshot = this.stateDatabase.loadRendererState(this.rendererStateFile)
    return {
      data: this.normalizeRendererStateData(snapshot.data),
      updatedAt: snapshot.updatedAt
    }
  }

  private getRendererAccountCount(data: RendererStoreData | null | undefined): number {
    if (!data?.accounts || typeof data.accounts !== 'object') {
      return 0
    }

    return Object.keys(data.accounts).length
  }

  private buildRendererStateFromStoredAccounts(base?: RendererStoreData | null): RendererStoreData | null {
    if (this.state.accounts.length === 0) {
      return base ?? null
    }

    return {
      ...(base || {}),
      accounts: Object.fromEntries(
        this.state.accounts.map((account) => [
          account.id,
          {
            id: account.id,
            email: account.email,
            nickname: account.nickname,
            userId: account.userId,
            idp: account.credentials.provider,
            profileArn: account.profileArn,
            machineId: account.machineId,
            status: account.status,
            lastError: account.lastError,
            createdAt: account.createdAt,
            lastCheckedAt: account.lastCheckedAt,
            credentials: {
              accessToken: account.credentials.accessToken,
              refreshToken: account.credentials.refreshToken,
              clientId: account.credentials.clientId,
              clientSecret: account.credentials.clientSecret,
              region: account.credentials.region,
              authMethod: account.credentials.authMethod,
              provider: account.credentials.provider,
              expiresAt: account.credentials.expiresAt
            },
            usage: {
              current: account.usage.current,
              limit: account.usage.limit,
              percentUsed: account.usage.percentUsed,
              baseLimit: account.usage.baseLimit,
              baseCurrent: account.usage.baseCurrent,
              freeTrialLimit: account.usage.freeTrialLimit,
              freeTrialCurrent: account.usage.freeTrialCurrent,
              freeTrialExpiry: account.usage.freeTrialExpiry,
              bonuses: account.usage.bonuses,
              nextResetDate: account.usage.nextResetDate,
              resourceDetail: account.usage.resourceDetail
            },
            subscription: {
              type: account.subscription.type,
              title: account.subscription.title,
              rawType: account.subscription.rawType,
              expiresAt: account.subscription.expiresAt,
              daysRemaining: account.subscription.daysRemaining,
              managementTarget: account.subscription.managementTarget,
              upgradeCapability: account.subscription.upgradeCapability,
              overageCapability: account.subscription.overageCapability
            }
          }
        ])
      )
    }
  }

  private getRendererBackupFiles(): string[] {
    try {
      return fs
        .readdirSync(this.rendererBackupDir)
        .filter((file) => file.startsWith('renderer-state-') && file.endsWith('.json'))
        .sort()
        .reverse()
    } catch {
      return []
    }
  }

  private restoreRendererStateFromBackup(): RendererStoreData | null {
    for (const file of this.getRendererBackupFiles()) {
      const candidate = this.readJsonFile<RendererStoreData | null>(path.join(this.rendererBackupDir, file), null)
      if (this.getRendererAccountCount(candidate) > 0) {
        return candidate
      }
    }

    return null
  }

  private createRendererStateBackup(): void {
    if (!fs.existsSync(this.rendererStateFile)) {
      return
    }

    const backupPath = path.join(this.rendererBackupDir, `renderer-state-${Date.now()}.json`)
    fs.copyFileSync(this.rendererStateFile, backupPath)

    const backups = this.getRendererBackupFiles()
    for (const staleFile of backups.slice(WebProxyService.MAX_RENDERER_BACKUPS)) {
      try {
        fs.unlinkSync(path.join(this.rendererBackupDir, staleFile))
      } catch {
        // ignore backup cleanup failures
      }
    }
  }

  private writeJsonAtomic(targetPath: string, value: unknown): void {
    const tempPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`
    fs.writeFileSync(tempPath, JSON.stringify(value, null, 2), 'utf8')
    fs.renameSync(tempPath, targetPath)
  }

  private writeRendererStateFile(data: RendererStoreData, createBackup = true): void {
    if (createBackup) {
      this.createRendererStateBackup()
    }
    this.writeJsonAtomic(this.rendererStateFile, data)
  }

  private loadState(): WebProxyState {
    const defaults: WebProxyState = {
      version: 1,
      accounts: [],
      proxyConfig: {
        enabled: false,
        host: process.env.KIRO_PROXY_HOST || '0.0.0.0',
        port: Number(process.env.KIRO_PROXY_PORT || 5580),
        apiKey: process.env.KIRO_PROXY_API_KEY || '',
        enableMultiAccount: true,
        selectedAccountIds: [],
        logRequests: true,
        maxConcurrent: 10,
        maxQueueSize: 50,
        maxRequestBodyBytes: 2 * 1024 * 1024,
        requestTimeoutMs: 180000,
        maxInFlightPerAccount: 1,
        maxRetries: 3,
        retryDelayMs: 1000,
        tokenRefreshBeforeExpiry: 300,
        autoStart: false
      }
    }

    const envProxyConfig: Partial<ProxyConfig> = {}
    if (process.env.KIRO_PROXY_HOST) {
      envProxyConfig.host = process.env.KIRO_PROXY_HOST
    }
    if (process.env.KIRO_PROXY_PORT) {
      envProxyConfig.port = Number(process.env.KIRO_PROXY_PORT)
    }
    if (process.env.KIRO_PROXY_API_KEY !== undefined) {
      envProxyConfig.apiKey = process.env.KIRO_PROXY_API_KEY
    }

    const parsed = this.stateDatabase.loadProxyState(this.stateFile)
    return {
      version: 1,
      accounts: Array.isArray(parsed?.accounts) ? parsed.accounts : [],
      proxyConfig: {
        ...defaults.proxyConfig,
        ...(parsed?.proxyConfig || {}),
        ...envProxyConfig
      }
    }
  }

  private saveState(): void {
    this.stateDatabase.saveProxyState(this.state)
    this.writeJsonAtomic(this.stateFile, this.state)
  }

  private readJsonFile<T>(targetPath: string, fallback: T): T {
    try {
      if (!fs.existsSync(targetPath)) {
        return fallback
      }

      return JSON.parse(fs.readFileSync(targetPath, 'utf8')) as T
    } catch {
      return fallback
    }
  }

  private toPublicAccount(account: StoredAccount): PublicAccountView {
    return {
      id: account.id,
      email: account.email,
      nickname: account.nickname,
      userId: account.userId,
      provider: account.credentials.provider,
      authMethod: account.credentials.authMethod,
      region: account.credentials.region,
      status: account.status,
      lastError: account.lastError,
      createdAt: account.createdAt,
      lastCheckedAt: account.lastCheckedAt,
      accessTokenReady: Boolean(account.credentials.accessToken),
      refreshTokenReady: Boolean(account.credentials.refreshToken),
      subscription: account.subscription,
      usage: account.usage
    }
  }

  private requireAccount(id: string): StoredAccount {
    const account = this.state.accounts.find((item) => item.id === id)
    if (!account) {
      throw new Error('Account not found')
    }

    return account
  }

  private findAccount(email: string, provider?: string): StoredAccount | undefined {
    const normalizedProvider = normalizeProvider(provider)
    return this.state.accounts.find(
      (account) =>
        account.email.toLowerCase() === email.toLowerCase() &&
        account.credentials.provider === normalizedProvider
    )
  }

  private parseImportContent(content: string, formatHint?: string): ImportCandidate[] {
    const trimmed = content.trim()
    if (!trimmed) {
      return []
    }

    if (formatHint === 'json' || trimmed.startsWith('[') || trimmed.startsWith('{')) {
      return this.parseJson(trimmed)
    }

    if (formatHint === 'txt') {
      return this.parseTxt(trimmed)
    }

    return this.parseCsv(trimmed)
  }

  private parseJson(content: string): ImportCandidate[] {
    const parsed = JSON.parse(content) as unknown
    const list = Array.isArray(parsed)
      ? parsed
      : typeof parsed === 'object' && parsed && Array.isArray((parsed as { accounts?: unknown[] }).accounts)
        ? (parsed as { accounts: unknown[] }).accounts
        : []

    return list
      .map((item) => item as Record<string, unknown>)
      .map((item) => ({
        email: String(item.email || ''),
        nickname: item.nickname ? String(item.nickname) : undefined,
        provider: item.provider ? String(item.provider) : item.idp ? String(item.idp) : undefined,
        authMethod: item.authMethod ? String(item.authMethod) : undefined,
        refreshToken: String(item.refreshToken || item.RefreshToken || ''),
        clientId: item.clientId ? String(item.clientId) : item.ClientId ? String(item.ClientId) : undefined,
        clientSecret: item.clientSecret
          ? String(item.clientSecret)
          : item.ClientSecret
            ? String(item.ClientSecret)
            : undefined,
        region: item.region ? String(item.region) : item.Region ? String(item.Region) : undefined,
        accessToken: item.accessToken ? String(item.accessToken) : undefined
      }))
      .filter((item) => item.email && item.refreshToken)
  }

  private parseTxt(content: string): ImportCandidate[] {
    return content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => {
        const parts = line.includes('|') ? line.split('|') : line.split(',')
        return {
          email: (parts[0] || '').trim(),
          refreshToken: (parts[1] || '').trim(),
          nickname: (parts[2] || '').trim() || undefined,
          provider: (parts[3] || '').trim() || undefined
        }
      })
      .filter((item) => item.email && item.refreshToken)
  }

  private parseCsv(content: string): ImportCandidate[] {
    const lines = content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)

    if (!lines.length) {
      return []
    }

    const rows = lines.map((line) => this.parseCsvLine(line))
    const firstRow = rows[0]
    const hasHeader = firstRow.some((value) =>
      ['邮箱', 'email', 'refreshtoken', 'clientid', '登录方式', 'provider'].includes(value.toLowerCase())
    )

    if (!hasHeader) {
      return rows
        .map((cols) => ({
          email: cols[0] || '',
          nickname: cols[1] || undefined,
          provider: cols[2] || undefined,
          refreshToken: cols[3] || '',
          clientId: cols[4] || undefined,
          clientSecret: cols[5] || undefined,
          region: cols[6] || undefined
        }))
        .filter((item) => item.email && item.refreshToken)
    }

    const headerMap = new Map<string, number>()
    firstRow.forEach((value, index) => {
      headerMap.set(value.trim().toLowerCase(), index)
    })

    const read = (row: string[], ...keys: string[]): string | undefined => {
      for (const key of keys) {
        const index = headerMap.get(key)
        if (index !== undefined && row[index]) {
          return row[index]
        }
      }
      return undefined
    }

    return rows
      .slice(1)
      .map((row) => ({
        email: read(row, '邮箱', 'email') || '',
        nickname: read(row, '昵称', 'nickname'),
        provider: read(row, '登录方式', 'provider', 'idp'),
        refreshToken: read(row, 'refreshtoken', 'refresh_token') || '',
        clientId: read(row, 'clientid', 'client_id'),
        clientSecret: read(row, 'clientsecret', 'client_secret'),
        region: read(row, 'region'),
        accessToken: read(row, 'accesstoken', 'access_token')
      }))
      .filter((item) => item.email && item.refreshToken)
  }

  private parseCsvLine(line: string): string[] {
    const result: string[] = []
    let current = ''
    let inQuotes = false

    for (let index = 0; index < line.length; index++) {
      const char = line[index]
      if (char === '"') {
        if (inQuotes && line[index + 1] === '"') {
          current += '"'
          index++
        } else {
          inQuotes = !inQuotes
        }
      } else if (char === ',' && !inQuotes) {
        result.push(current.trim())
        current = ''
      } else {
        current += char
      }
    }

    result.push(current.trim())
    return result
  }
}
