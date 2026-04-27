import crypto from 'crypto'
import type { ProxyAccount } from '../main/proxy'
import type { StoredAccount } from './types'

const KIRO_AUTH_ENDPOINT = 'https://prod.us-east-1.auth.desktop.kiro.dev'
const KIRO_REST_API_ENDPOINTS: Record<string, string> = {
  'us-east-1': 'https://q.us-east-1.amazonaws.com',
  'eu-central-1': 'https://q.eu-central-1.amazonaws.com'
}
const KIRO_VERSION = '0.6.18'

interface OidcRefreshResult {
  success: boolean
  accessToken?: string
  refreshToken?: string
  expiresIn?: number
  error?: string
}

interface UsageLimitsResponse {
  usageBreakdownList?: Array<{
    type?: string
    resourceType?: string
    displayName?: string
    displayNamePlural?: string
    currentUsage?: number
    currentUsageWithPrecision?: number
    usageLimit?: number
    usageLimitWithPrecision?: number
    currency?: string
    unit?: string
    overageRate?: number
    overageCap?: number
    bonuses?: Array<{
      bonusCode?: string
      displayName?: string
      usageLimit?: number
      usageLimitWithPrecision?: number
      currentUsage?: number
      currentUsageWithPrecision?: number
      expiresAt?: string | number
      status?: string
    }>
    freeTrialInfo?: {
      usageLimit?: number
      usageLimitWithPrecision?: number
      currentUsage?: number
      currentUsageWithPrecision?: number
      freeTrialStatus?: string
      freeTrialExpiry?: string | number
    }
    freeTrialUsage?: {
      usageLimit?: number
      usageLimitWithPrecision?: number
      currentUsage?: number
      currentUsageWithPrecision?: number
      freeTrialStatus?: string
      freeTrialExpiry?: string
    }
  }>
  nextDateReset?: number | string
  subscriptionInfo?: {
    subscriptionTitle?: string
    type?: string
    subscriptionManagementTarget?: string
    upgradeCapability?: string
    overageCapability?: string
  }
  overageConfiguration?: {
    overageEnabled?: boolean
  }
  userInfo?: {
    email?: string
    userId?: string
  }
}

export interface VerificationResult {
  email: string
  userId?: string
  accessToken: string
  refreshToken: string
  expiresAt?: number
  subscription: StoredAccount['subscription']
  usage: StoredAccount['usage']
}

export function generateMachineId(): string {
  return crypto.randomBytes(32).toString('hex')
}

export function normalizeProvider(provider?: string): StoredAccount['credentials']['provider'] {
  const normalized = (provider || 'BuilderId').toLowerCase()

  if (normalized === 'github') return 'Github'
  if (normalized === 'google') return 'Google'
  if (normalized === 'enterprise') return 'Enterprise'
  return 'BuilderId'
}

export function normalizeAuthMethod(
  provider?: string,
  authMethod?: string
): StoredAccount['credentials']['authMethod'] {
  if ((authMethod || '').toLowerCase() === 'social') {
    return 'social'
  }

  const normalizedProvider = (provider || '').toLowerCase()
  if (normalizedProvider === 'github' || normalizedProvider === 'google') {
    return 'social'
  }

  return 'idc'
}

export function buildStoredAccountFromImport(input: {
  id: string
  email: string
  nickname?: string
  refreshToken: string
  clientId?: string
  clientSecret?: string
  region?: string
  provider?: string
  authMethod?: string
  accessToken?: string
}): StoredAccount {
  const provider = normalizeProvider(input.provider)
  const authMethod = normalizeAuthMethod(provider, input.authMethod)
  const now = Date.now()

  return {
    id: input.id,
    email: input.email,
    nickname: input.nickname,
    machineId: generateMachineId(),
    status: input.accessToken ? 'active' : 'unknown',
    createdAt: now,
    credentials: {
      accessToken: input.accessToken || '',
      refreshToken: input.refreshToken,
      clientId: input.clientId,
      clientSecret: input.clientSecret,
      region: input.region || 'us-east-1',
      authMethod,
      provider,
      expiresAt: input.accessToken ? now + 3600 * 1000 : undefined
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

export function toProxyAccount(account: StoredAccount): ProxyAccount {
  return {
    id: account.id,
    email: account.email,
    accessToken: account.credentials.accessToken,
    refreshToken: account.credentials.refreshToken,
    clientId: account.credentials.clientId,
    clientSecret: account.credentials.clientSecret,
    region: account.credentials.region,
    authMethod: account.credentials.authMethod,
    provider: account.credentials.provider,
    profileArn: account.profileArn,
    expiresAt: account.credentials.expiresAt,
    machineId: account.machineId
  }
}

function getRestApiBase(ssoRegion?: string): string {
  if (!ssoRegion) return KIRO_REST_API_ENDPOINTS['us-east-1']
  if (KIRO_REST_API_ENDPOINTS[ssoRegion]) return KIRO_REST_API_ENDPOINTS[ssoRegion]
  if (ssoRegion.startsWith('eu-')) return KIRO_REST_API_ENDPOINTS['eu-central-1']
  return KIRO_REST_API_ENDPOINTS['us-east-1']
}

function getFallbackRestApiBase(ssoRegion?: string): string {
  const primary = getRestApiBase(ssoRegion)
  return primary === KIRO_REST_API_ENDPOINTS['eu-central-1']
    ? KIRO_REST_API_ENDPOINTS['us-east-1']
    : KIRO_REST_API_ENDPOINTS['eu-central-1']
}

function getKiroUserAgent(machineId?: string): string {
  const suffix = machineId ? `KiroIDE-${KIRO_VERSION}-${machineId}` : `KiroIDE-${KIRO_VERSION}`
  return `aws-sdk-js/1.0.18 ua/2.1 os/windows lang/js md/nodejs#20.16.0 api/codewhispererstreaming#1.0.18 m/E ${suffix}`
}

function getKiroAmzUserAgent(machineId?: string): string {
  const suffix = machineId ? `KiroIDE ${KIRO_VERSION} ${machineId}` : `KiroIDE-${KIRO_VERSION}`
  return `aws-sdk-js/1.0.18 ${suffix}`
}

function normalizeResetDate(value: number | string | undefined): string | undefined {
  if (value === undefined || value === null) {
    return undefined
  }

  if (typeof value === 'number') {
    return new Date(value * 1000).toISOString()
  }

  return value
}

async function refreshOidcToken(
  refreshToken: string,
  clientId: string,
  clientSecret: string,
  region = 'us-east-1'
): Promise<OidcRefreshResult> {
  const response = await fetch(`https://oidc.${region}.amazonaws.com/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientId,
      clientSecret,
      refreshToken,
      grantType: 'refresh_token'
    })
  })

  if (!response.ok) {
    const errorText = await response.text()
    return { success: false, error: `HTTP ${response.status}: ${errorText}` }
  }

  const data = (await response.json()) as {
    accessToken?: string
    refreshToken?: string
    expiresIn?: number
  }

  return {
    success: true,
    accessToken: data.accessToken,
    refreshToken: data.refreshToken || refreshToken,
    expiresIn: data.expiresIn
  }
}

async function refreshSocialToken(
  refreshToken: string,
  machineId?: string
): Promise<OidcRefreshResult> {
  const response = await fetch(`${KIRO_AUTH_ENDPOINT}/refreshToken`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': getKiroUserAgent(machineId)
    },
    body: JSON.stringify({ refreshToken })
  })

  if (!response.ok) {
    const errorText = await response.text()
    return { success: false, error: `HTTP ${response.status}: ${errorText}` }
  }

  const data = (await response.json()) as {
    accessToken?: string
    refreshToken?: string
    expiresIn?: number
  }

  return {
    success: true,
    accessToken: data.accessToken,
    refreshToken: data.refreshToken || refreshToken,
    expiresIn: data.expiresIn
  }
}

export async function refreshTokenByMethod(account: StoredAccount): Promise<OidcRefreshResult> {
  const { refreshToken, clientId, clientSecret, region, authMethod } = account.credentials

  if (!refreshToken) {
    return { success: false, error: 'Missing refresh token' }
  }

  if (authMethod === 'social') {
    return refreshSocialToken(refreshToken, account.machineId)
  }

  if (!clientId || !clientSecret) {
    return { success: false, error: 'Missing clientId/clientSecret' }
  }

  return refreshOidcToken(refreshToken, clientId, clientSecret, region)
}

async function fetchRestApi(
  baseUrl: string,
  requestPath: string,
  accessToken: string,
  machineId?: string
): Promise<Response> {
  return fetch(`${baseUrl}${requestPath}`, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${accessToken}`,
      'User-Agent': getKiroUserAgent(machineId),
      'x-amz-user-agent': getKiroAmzUserAgent(machineId)
    }
  })
}

async function getUsageLimitsRest(
  accessToken: string,
  profileArn?: string,
  accountMachineId?: string,
  ssoRegion?: string
): Promise<UsageLimitsResponse> {
  const params = new URLSearchParams({
    origin: 'AI_EDITOR',
    resourceType: 'AGENTIC_REQUEST',
    isEmailRequired: 'true'
  })

  if (profileArn) {
    params.set('profileArn', profileArn)
  }

  const requestPath = `/getUsageLimits?${params.toString()}`
  let response = await fetchRestApi(
    getRestApiBase(ssoRegion),
    requestPath,
    accessToken,
    accountMachineId
  )

  if (response.status === 403) {
    response = await fetchRestApi(
      getFallbackRestApiBase(ssoRegion),
      requestPath,
      accessToken,
      accountMachineId
    )
  }

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`HTTP ${response.status}: ${errorText}`)
  }

  return (await response.json()) as UsageLimitsResponse
}

function parseSubscriptionTitle(title?: string): StoredAccount['subscription']['type'] {
  const value = (title || 'Free').toUpperCase()

  if (value.includes('PRO+') || value.includes('PRO_PLUS') || value.includes('PROPLUS')) {
    return 'Pro_Plus'
  }
  if (value.includes('POWER') || value.includes('ENTERPRISE')) {
    return 'Enterprise'
  }
  if (value.includes('TEAMS')) {
    return 'Teams'
  }
  if (value.includes('PRO')) {
    return 'Pro'
  }

  return 'Free'
}

function canRefreshStoredAccount(account: StoredAccount): boolean {
  const { refreshToken, authMethod, clientId, clientSecret } = account.credentials
  if (!refreshToken) {
    return false
  }

  if (authMethod === 'social') {
    return true
  }

  return Boolean(clientId && clientSecret)
}

async function refreshStoredAccount(account: StoredAccount): Promise<{
  accessToken: string
  refreshToken: string
  expiresAt?: number
}> {
  const refreshResult = await refreshTokenByMethod(account)
  if (!refreshResult.success || !refreshResult.accessToken) {
    throw new Error(refreshResult.error || 'Token refresh failed')
  }

  return {
    accessToken: refreshResult.accessToken,
    refreshToken: refreshResult.refreshToken || account.credentials.refreshToken,
    expiresAt: refreshResult.expiresIn
      ? Date.now() + refreshResult.expiresIn * 1000
      : account.credentials.expiresAt
  }
}

export async function verifyStoredAccount(
  account: StoredAccount,
  options: { allowRefresh?: boolean } = {}
): Promise<VerificationResult> {
  const allowRefresh = options.allowRefresh !== false
  let accessToken = account.credentials.accessToken
  let refreshToken = account.credentials.refreshToken
  let expiresAt = account.credentials.expiresAt

  if (!accessToken) {
    if (!allowRefresh || !canRefreshStoredAccount(account)) {
      throw new Error('Missing access token')
    }

    const refreshed = await refreshStoredAccount(account)
    accessToken = refreshed.accessToken
    refreshToken = refreshed.refreshToken
    expiresAt = refreshed.expiresAt
  }

  let usageResult: UsageLimitsResponse
  try {
    usageResult = await getUsageLimitsRest(
      accessToken,
      account.profileArn,
      account.machineId,
      account.credentials.region
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Usage request failed'
    const shouldRetryWithRefresh =
      allowRefresh && canRefreshStoredAccount(account) && message.includes('401')

    if (!shouldRetryWithRefresh) {
      throw error
    }

    const refreshed = await refreshStoredAccount(account)
    accessToken = refreshed.accessToken
    refreshToken = refreshed.refreshToken
    expiresAt = refreshed.expiresAt
    usageResult = await getUsageLimitsRest(
      accessToken,
      account.profileArn,
      account.machineId,
      account.credentials.region
    )
  }

  const email = usageResult.userInfo?.email || account.email
  const userId = usageResult.userInfo?.userId
  const subscriptionTitle = usageResult.subscriptionInfo?.subscriptionTitle || 'Free'
  const subscriptionType = parseSubscriptionTitle(subscriptionTitle)
  const creditUsage = usageResult.usageBreakdownList?.find(
    (item) => item.resourceType === 'CREDIT' || item.displayName === 'Credits'
  )
  const baseLimit = creditUsage?.usageLimitWithPrecision ?? creditUsage?.usageLimit ?? 0
  const baseCurrent = creditUsage?.currentUsageWithPrecision ?? creditUsage?.currentUsage ?? 0

  let freeTrialLimit = 0
  let freeTrialCurrent = 0
  let freeTrialExpiry: string | undefined
  const freeTrial = creditUsage?.freeTrialInfo || creditUsage?.freeTrialUsage
  if (freeTrial?.freeTrialStatus === 'ACTIVE') {
    freeTrialLimit = freeTrial.usageLimitWithPrecision ?? freeTrial.usageLimit ?? 0
    freeTrialCurrent = freeTrial.currentUsageWithPrecision ?? freeTrial.currentUsage ?? 0
    freeTrialExpiry =
      typeof freeTrial.freeTrialExpiry === 'number'
        ? new Date(freeTrial.freeTrialExpiry * 1000).toISOString()
        : freeTrial.freeTrialExpiry
  }

  const bonuses =
    creditUsage?.bonuses
      ?.filter((bonus) => bonus.status === 'ACTIVE')
      .map((bonus) => ({
        code: bonus.bonusCode || '',
        name: bonus.displayName || '',
        current: bonus.currentUsageWithPrecision ?? bonus.currentUsage ?? 0,
        limit: bonus.usageLimitWithPrecision ?? bonus.usageLimit ?? 0,
        expiresAt:
          typeof bonus.expiresAt === 'number'
            ? new Date(bonus.expiresAt * 1000).toISOString()
            : bonus.expiresAt
      })) || []

  const totalLimit = baseLimit + freeTrialLimit + bonuses.reduce((sum, bonus) => sum + bonus.limit, 0)
  const totalUsed = baseCurrent + freeTrialCurrent + bonuses.reduce((sum, bonus) => sum + bonus.current, 0)
  const nextResetDate = normalizeResetDate(usageResult.nextDateReset)
  const subscriptionExpiresAt = nextResetDate ? new Date(nextResetDate).getTime() : undefined
  const daysRemaining =
    subscriptionExpiresAt !== undefined
      ? Math.max(0, Math.ceil((subscriptionExpiresAt - Date.now()) / (1000 * 60 * 60 * 24)))
      : undefined
  const resourceDetail = creditUsage
    ? {
        resourceType: creditUsage.resourceType,
        displayName: creditUsage.displayName,
        displayNamePlural: creditUsage.displayNamePlural,
        currency: creditUsage.currency,
        unit: creditUsage.unit,
        overageRate: creditUsage.overageRate,
        overageCap: creditUsage.overageCap,
        overageEnabled: usageResult.overageConfiguration?.overageEnabled ?? false
      }
    : undefined

  return {
    email,
    userId,
    accessToken,
    refreshToken,
    expiresAt,
    subscription: {
      type: subscriptionType,
      title: subscriptionTitle,
      rawType: usageResult.subscriptionInfo?.type,
      expiresAt: subscriptionExpiresAt,
      daysRemaining,
      managementTarget: usageResult.subscriptionInfo?.subscriptionManagementTarget,
      upgradeCapability: usageResult.subscriptionInfo?.upgradeCapability,
      overageCapability: usageResult.subscriptionInfo?.overageCapability
    },
    usage: {
      current: totalUsed,
      limit: totalLimit,
      percentUsed: totalLimit > 0 ? totalUsed / totalLimit : 0,
      baseLimit,
      baseCurrent,
      freeTrialLimit,
      freeTrialCurrent,
      freeTrialExpiry,
      bonuses,
      nextResetDate,
      resourceDetail
    }
  }
}
