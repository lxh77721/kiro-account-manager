import type { ProxyConfig } from '../main/proxy'

export type WebAccountStatus = 'active' | 'expired' | 'error' | 'unknown'

export interface StoredAccountCredentials {
  accessToken: string
  refreshToken: string
  clientId?: string
  clientSecret?: string
  region: string
  authMethod: 'social' | 'idc'
  provider: 'BuilderId' | 'Enterprise' | 'Github' | 'Google'
  expiresAt?: number
}

export interface StoredAccountResourceDetail {
  resourceType?: string
  displayName?: string
  displayNamePlural?: string
  currency?: string
  unit?: string
  overageRate?: number
  overageCap?: number
  overageEnabled?: boolean
}

export interface StoredAccountUsage {
  current: number
  limit: number
  percentUsed: number
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
  resourceDetail?: StoredAccountResourceDetail
}

export interface StoredAccountSubscription {
  type: 'Free' | 'Pro' | 'Pro_Plus' | 'Enterprise' | 'Teams'
  title?: string
  rawType?: string
  expiresAt?: number
  daysRemaining?: number
  managementTarget?: string
  upgradeCapability?: string
  overageCapability?: string
}

export interface StoredAccount {
  id: string
  email: string
  nickname?: string
  userId?: string
  profileArn?: string
  machineId: string
  status: WebAccountStatus
  lastError?: string
  createdAt: number
  lastCheckedAt?: number
  credentials: StoredAccountCredentials
  usage: StoredAccountUsage
  subscription: StoredAccountSubscription
}

export interface WebProxyState {
  version: 1
  accounts: StoredAccount[]
  proxyConfig: ProxyConfig
}

export interface ImportCandidate {
  email: string
  nickname?: string
  provider?: string
  authMethod?: string
  refreshToken: string
  clientId?: string
  clientSecret?: string
  region?: string
  accessToken?: string
}

export interface PublicAccountView {
  id: string
  email: string
  nickname?: string
  userId?: string
  provider: StoredAccountCredentials['provider']
  authMethod: StoredAccountCredentials['authMethod']
  region: string
  status: WebAccountStatus
  lastError?: string
  createdAt: number
  lastCheckedAt?: number
  accessTokenReady: boolean
  refreshTokenReady: boolean
  subscription: StoredAccountSubscription
  usage: StoredAccountUsage
}

export interface PublicStateView {
  accounts: PublicAccountView[]
  proxy: {
    running: boolean
    config: ProxyConfig
    address: string
    eligibleAccounts: number
  }
}
