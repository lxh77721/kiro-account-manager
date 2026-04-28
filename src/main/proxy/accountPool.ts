import type { ProxyAccount, AccountStats } from './types'

export interface AccountPoolConfig {
  cooldownMs: number
  maxErrorCount: number
  quotaResetMs: number
  maxInFlightPerAccount: number
}

const DEFAULT_CONFIG: AccountPoolConfig = {
  cooldownMs: 60000,
  maxErrorCount: 3,
  quotaResetMs: 3600000,
  maxInFlightPerAccount: 1
}

export class AccountPool {
  private accounts: Map<string, ProxyAccount> = new Map()
  private accountStats: Map<string, AccountStats> = new Map()
  private currentIndex: number = 0
  private config: AccountPoolConfig

  constructor(config: Partial<AccountPoolConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  updateConfig(config: Partial<AccountPoolConfig>): void {
    this.config = {
      ...this.config,
      ...config,
      maxInFlightPerAccount: Math.max(1, config.maxInFlightPerAccount ?? this.config.maxInFlightPerAccount)
    }
  }

  addAccount(account: ProxyAccount): void {
    this.accounts.set(account.id, {
      ...account,
      isAvailable: true,
      requestCount: 0,
      errorCount: 0,
      inFlightCount: 0,
      lastUsed: 0,
      cooldownUntil: undefined,
      cooldownReason: undefined
    })
    this.accountStats.set(account.id, {
      requests: 0,
      tokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      errors: 0,
      lastUsed: 0,
      avgResponseTime: 0,
      totalResponseTime: 0
    })
    console.log(`[AccountPool] Added account: ${account.email || account.id}`)
  }

  removeAccount(accountId: string): void {
    this.accounts.delete(accountId)
    this.accountStats.delete(accountId)
    console.log(`[AccountPool] Removed account: ${accountId}`)
  }

  updateAccount(accountId: string, updates: Partial<ProxyAccount>): void {
    const account = this.accounts.get(accountId)
    if (!account) {
      return
    }

    this.accounts.set(accountId, {
      ...account,
      ...updates
    })
  }

  getNextAccount(): ProxyAccount | null {
    return this.findNextAccount()
  }

  acquireNextAccount(): ProxyAccount | null {
    return this.acquireAccount(this.findNextAccount())
  }

  getAccount(accountId: string): ProxyAccount | null {
    return this.accounts.get(accountId) || null
  }

  acquireAccountById(accountId: string): ProxyAccount | null {
    return this.acquireAccount(this.accounts.get(accountId) || null)
  }

  isAccountAvailable(accountId: string): boolean {
    const account = this.accounts.get(accountId)
    if (!account) {
      return false
    }

    return this.isAccountAvailableAt(account, Date.now())
  }

  getFirstAvailableAccount(): ProxyAccount | null {
    return this.findFirstAvailableAccount()
  }

  acquireFirstAvailableAccount(): ProxyAccount | null {
    return this.acquireAccount(this.findFirstAvailableAccount())
  }

  getNextAvailableAccount(excludeAccountId: string): ProxyAccount | null {
    return this.findNextAvailableExcluding(excludeAccountId)
  }

  acquireNextAvailableAccount(excludeAccountId: string): ProxyAccount | null {
    return this.acquireAccount(this.findNextAvailableExcluding(excludeAccountId))
  }

  releaseAccount(accountId: string): void {
    const account = this.accounts.get(accountId)
    if (!account) {
      return
    }

    this.accounts.set(accountId, {
      ...account,
      inFlightCount: Math.max(0, (account.inFlightCount || 0) - 1)
    })
  }

  getAllAccounts(): ProxyAccount[] {
    return Array.from(this.accounts.values())
  }

  private canRefreshAccount(account: ProxyAccount): boolean {
    if (!account.refreshToken) {
      return false
    }

    if (account.authMethod === 'social') {
      return true
    }

    return Boolean(account.clientId && account.clientSecret)
  }

  private isRateLimited(account: ProxyAccount): boolean {
    return account.cooldownReason === 'quota'
  }

  private isAccountAvailableAt(account: ProxyAccount, now: number): boolean {
    if (this.isRateLimited(account)) {
      return false
    }

    if ((account.inFlightCount || 0) >= this.config.maxInFlightPerAccount) {
      return false
    }

    if (account.cooldownUntil && account.cooldownUntil > now) {
      return false
    }

    if ((account.errorCount || 0) >= this.config.maxErrorCount) {
      return false
    }

    if (!account.accessToken && !this.canRefreshAccount(account)) {
      return false
    }

    if (account.expiresAt && account.expiresAt < now && !this.canRefreshAccount(account)) {
      return false
    }

    return account.isAvailable !== false
  }

  private findNextAccount(): ProxyAccount | null {
    const accountList = Array.from(this.accounts.values())
    if (accountList.length === 0) {
      return null
    }

    const now = Date.now()
    let attempts = 0
    const maxAttempts = accountList.length

    while (attempts < maxAttempts) {
      const account = accountList[this.currentIndex]
      this.currentIndex = (this.currentIndex + 1) % accountList.length

      if (this.isAccountAvailableAt(account, now)) {
        return account
      }

      attempts++
    }

    return null
  }

  private findFirstAvailableAccount(): ProxyAccount | null {
    const now = Date.now()

    for (const account of this.accounts.values()) {
      if (this.isAccountAvailableAt(account, now)) {
        return account
      }
    }

    return null
  }

  private findNextAvailableExcluding(excludeAccountId: string): ProxyAccount | null {
    if (this.accounts.size <= 1) {
      return null
    }

    const now = Date.now()
    for (const account of this.accounts.values()) {
      if (account.id !== excludeAccountId && this.isAccountAvailableAt(account, now)) {
        return account
      }
    }

    return null
  }

  private acquireAccount(account: ProxyAccount | null): ProxyAccount | null {
    if (!account) {
      return null
    }

    const current = this.accounts.get(account.id)
    if (!current || !this.isAccountAvailableAt(current, Date.now())) {
      return null
    }

    const leasedAccount = {
      ...current,
      inFlightCount: (current.inFlightCount || 0) + 1
    }
    this.accounts.set(current.id, leasedAccount)
    return leasedAccount
  }

  recordSuccess(accountId: string, tokens: number = 0): void {
    const account = this.accounts.get(accountId)
    if (account) {
      this.accounts.set(accountId, {
        ...account,
        requestCount: (account.requestCount || 0) + 1,
        errorCount: 0,
        lastUsed: Date.now(),
        isAvailable: true,
        cooldownUntil: undefined,
        cooldownReason: undefined
      })
    }

    const stats = this.accountStats.get(accountId)
    if (stats) {
      this.accountStats.set(accountId, {
        ...stats,
        requests: stats.requests + 1,
        tokens: stats.tokens + tokens,
        lastUsed: Date.now()
      })
    }
  }

  recordError(accountId: string, isQuotaError: boolean = false): void {
    const account = this.accounts.get(accountId)
    if (!account) return

    const errorCount = (account.errorCount || 0) + 1
    const now = Date.now()

    let cooldownUntil = account.cooldownUntil
    let isAvailable = account.isAvailable !== false
    let cooldownReason: ProxyAccount['cooldownReason'] = account.cooldownReason

    if (isQuotaError) {
      cooldownUntil = now + this.config.quotaResetMs
      cooldownReason = 'quota'
      isAvailable = false
      console.log(
        `[AccountPool] Account ${account.email || accountId} moved to rate-limited pool (estimated quota reset ${new Date(cooldownUntil).toISOString()}, manual restore required)`
      )
    } else if (errorCount >= this.config.maxErrorCount) {
      cooldownUntil = now + this.config.cooldownMs
      cooldownReason = 'error'
      console.log(`[AccountPool] Account ${account.email || accountId} too many errors, cooldown until ${new Date(cooldownUntil).toISOString()}`)
    } else {
      cooldownReason = cooldownUntil && cooldownUntil > now ? 'error' : undefined
    }

    this.accounts.set(accountId, {
      ...account,
      errorCount,
      cooldownUntil,
      cooldownReason,
      isAvailable,
      lastUsed: now
    })

    const stats = this.accountStats.get(accountId)
    if (stats) {
      this.accountStats.set(accountId, {
        ...stats,
        errors: stats.errors + 1,
        lastUsed: now
      })
    }
  }

  markNeedsRefresh(accountId: string): void {
    const account = this.accounts.get(accountId)
    if (account) {
      this.accounts.set(accountId, {
        ...account,
        isAvailable: false
      })
    }
  }

  getStats(): { accounts: Map<string, AccountStats>; total: { requests: number; tokens: number; errors: number } } {
    let totalRequests = 0
    let totalTokens = 0
    let totalErrors = 0

    for (const stats of this.accountStats.values()) {
      totalRequests += stats.requests
      totalTokens += stats.tokens
      totalErrors += stats.errors
    }

    return {
      accounts: new Map(this.accountStats),
      total: {
        requests: totalRequests,
        tokens: totalTokens,
        errors: totalErrors
      }
    }
  }

  reset(): void {
    for (const [id, account] of this.accounts) {
      this.accounts.set(id, {
        ...account,
        isAvailable: true,
        errorCount: 0,
        cooldownUntil: undefined,
        cooldownReason: undefined
      })
    }
    this.currentIndex = 0
  }

  resetAccountState(accountId: string): boolean {
    const account = this.accounts.get(accountId)
    if (!account) {
      return false
    }

    this.accounts.set(accountId, {
      ...account,
      isAvailable: true,
      errorCount: 0,
      cooldownUntil: undefined,
      cooldownReason: undefined
    })

    return true
  }

  clear(): void {
    this.accounts.clear()
    this.accountStats.clear()
    this.currentIndex = 0
  }

  get size(): number {
    return this.accounts.size
  }

  get availableCount(): number {
    const now = Date.now()
    let count = 0
    for (const account of this.accounts.values()) {
      if (this.isAccountAvailableAt(account, now)) {
        count++
      }
    }
    return count
  }

  get rateLimitedCount(): number {
    let count = 0

    for (const account of this.accounts.values()) {
      if (this.isRateLimited(account)) {
        count++
      }
    }

    return count
  }
}
