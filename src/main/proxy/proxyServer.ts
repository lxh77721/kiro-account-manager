// Kiro Proxy HTTP/HTTPS 鏈嶅姟鍣?
import http from 'http'
import https from 'https'
import fs from 'fs'
import { v4 as uuidv4 } from 'uuid'
import type {
  OpenAIChatRequest,
  ClaudeRequest,
  ProxyConfig,
  ProxyStats,
  ProxyAccount,
  TokenRefreshCallback
} from './types'
import { AccountPool } from './accountPool'
import { callKiroApiStream, callKiroApi, fetchKiroModels, type KiroModel } from './kiroApi'
import { proxyLogger } from './logger'
import { getKProxyService, generateDeviceId } from '../kproxy'
import {
  openaiToKiro,
  claudeToKiro,
  kiroToOpenaiResponse,
  kiroToClaudeResponse,
  createOpenaiStreamChunk,
  createClaudeStreamEvent
} from './translator'

export interface ProxyServerEvents {
  onRequest?: (info: { path: string; method: string; accountId?: string }) => void
  onResponse?: (info: { path: string; model?: string; status: number; tokens?: number; inputTokens?: number; outputTokens?: number; credits?: number; error?: string }) => void
  onError?: (error: Error) => void
  onConfigChanged?: (config: ProxyConfig) => void  // API Key 鐢ㄩ噺鏇存柊鏃惰Е鍙?
  onStatusChange?: (running: boolean, port: number) => void
  onTokenRefresh?: TokenRefreshCallback
  onAccountUpdate?: (account: ProxyAccount) => void
  onCreditsUpdate?: (totalCredits: number) => void
  onTokensUpdate?: (inputTokens: number, outputTokens: number) => void
  onRequestStatsUpdate?: (totalRequests: number, successRequests: number, failedRequests: number) => void
}

export class ProxyServer {
  private server: http.Server | https.Server | null = null
  private accountPool: AccountPool
  private config: ProxyConfig
  private stats: ProxyStats
  private sessionStats: { totalRequests: number; successRequests: number; failedRequests: number; startTime: number }
  private events: ProxyServerEvents
  private refreshingTokens: Set<string> = new Set() // 闃叉骞跺彂鍒锋柊
  private isHttps: boolean = false
  private activeRequests: number = 0
  private pendingRequestQueue: Array<() => void> = []

  constructor(config: Partial<ProxyConfig> = {}, events: ProxyServerEvents = {}) {
    this.config = this.normalizeConfig({
      enabled: false,
      port: 5580,
      host: '127.0.0.1',
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
      tokenRefreshBeforeExpiry: 300, // 5鍒嗛挓鎻愬墠鍒锋柊
      autoStart: false, // 鏄惁鑷姩鍚姩
      ...config
    } as ProxyConfig)
    this.accountPool = new AccountPool({
      maxInFlightPerAccount: this.config.maxInFlightPerAccount || 1
    })
    this.stats = {
      totalRequests: 0,
      successRequests: 0,
      failedRequests: 0,
      totalTokens: 0,
      totalCredits: 0,
      inputTokens: 0,
      outputTokens: 0,
      startTime: Date.now(),
      accountStats: new Map(),
      endpointStats: new Map(),
      modelStats: new Map(),
      recentRequests: []
    }
    this.sessionStats = {
      totalRequests: 0,
      successRequests: 0,
      failedRequests: 0,
      startTime: 0
    }
    this.events = events
  }

  private normalizeConfig(config: ProxyConfig): ProxyConfig {
    const maxConcurrent = Math.max(1, config.maxConcurrent || 10)

    return {
      ...config,
      maxConcurrent,
      maxQueueSize: Math.max(0, config.maxQueueSize ?? 50),
      maxRequestBodyBytes: Math.max(1024, config.maxRequestBodyBytes ?? 2 * 1024 * 1024),
      requestTimeoutMs: Math.max(1000, config.requestTimeoutMs ?? 180000),
      maxInFlightPerAccount: Math.max(1, config.maxInFlightPerAccount ?? 1)
    }
  }

  private createHttpError(statusCode: number, message: string): Error & { statusCode: number; accountStateHandled?: boolean } {
    return Object.assign(new Error(message), { statusCode })
  }

  private createAbortError(statusCode: number, message: string): Error & { statusCode: number; accountStateHandled: boolean } {
    return Object.assign(new Error(message), {
      statusCode,
      accountStateHandled: true
    })
  }

  private isAbortLikeError(error: unknown): boolean {
    if (!(error instanceof Error)) {
      return false
    }

    const normalized = `${error.name} ${error.message}`.toLowerCase()
    return normalized.includes('abort') || normalized.includes('client disconnected') || normalized.includes('timed out')
  }

  private getAbortedRequestError(
    signal?: AbortSignal,
    fallbackError?: Error
  ): (Error & { statusCode?: number; accountStateHandled?: boolean }) | null {
    if (signal?.aborted) {
      const reason = signal.reason
      if (reason instanceof Error) {
        return Object.assign(reason, {
          statusCode: (reason as Error & { statusCode?: number }).statusCode || (reason.message.toLowerCase().includes('timed out') ? 408 : 499),
          accountStateHandled: true
        })
      }

      const message = typeof reason === 'string' && reason ? reason : (fallbackError?.message || 'Request aborted')
      return this.createAbortError(message.toLowerCase().includes('timed out') ? 408 : 499, message)
    }

    if (this.isAbortLikeError(fallbackError)) {
      const message = fallbackError?.message || 'Request aborted'
      return this.createAbortError(message.toLowerCase().includes('timed out') ? 408 : 499, message)
    }

    return null
  }

  private acquireRequestSlot(): Promise<(() => void) | null> {
    if (this.activeRequests < this.config.maxConcurrent) {
      this.activeRequests++
      return Promise.resolve(this.createRequestSlotRelease())
    }

    if (this.pendingRequestQueue.length >= (this.config.maxQueueSize || 0)) {
      return Promise.resolve(null)
    }

    return new Promise((resolve) => {
      this.pendingRequestQueue.push(() => resolve(this.createRequestSlotRelease()))
    })
  }

  private createRequestSlotRelease(): () => void {
    let released = false

    return () => {
      if (released) {
        return
      }

      released = true
      const next = this.pendingRequestQueue.shift()
      if (next) {
        next()
        return
      }

      this.activeRequests = Math.max(0, this.activeRequests - 1)
    }
  }

  private createRequestAbortController(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): { controller: AbortController; cleanup: () => void } {
    const controller = new AbortController()
    const abortWith = (error: Error & { statusCode?: number; accountStateHandled?: boolean }) => {
      if (!controller.signal.aborted) {
        controller.abort(error)
      }
    }

    const onAborted = () => abortWith(this.createAbortError(499, 'Client disconnected'))
    const onClosed = () => {
      if (!res.writableEnded) {
        abortWith(this.createAbortError(499, 'Client disconnected'))
      }
    }

    req.on('aborted', onAborted)
    res.on('close', onClosed)

    const timeoutMs = this.config.requestTimeoutMs || 180000
    const timer = setTimeout(() => {
      abortWith(this.createAbortError(408, `Request timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    const cleanup = () => {
      clearTimeout(timer)
      req.off('aborted', onAborted)
      res.off('close', onClosed)
    }

    return { controller, cleanup }
  }

  private parseJsonBody<T>(body: string, message: string): T {
    try {
      return JSON.parse(body) as T
    } catch {
      throw this.createHttpError(400, message)
    }
  }

  private releaseLeasedAccount(leasedAccountIds: Set<string>, accountId?: string): void {
    if (!accountId || !leasedAccountIds.has(accountId)) {
      return
    }

    leasedAccountIds.delete(accountId)
    this.accountPool.releaseAccount(accountId)
  }

  private releaseLeasedAccounts(leasedAccountIds: Set<string>): void {
    for (const accountId of Array.from(leasedAccountIds)) {
      this.accountPool.releaseAccount(accountId)
      leasedAccountIds.delete(accountId)
    }
  }

  private isQuotaLikeErrorMessage(message: string | undefined | null): boolean {
    const normalized = (message || '').toLowerCase()
    return (
      normalized.includes('402') ||
      normalized.includes('429') ||
      normalized.includes('quota') ||
      normalized.includes('throttlingexception') ||
      normalized.includes('reached the limit')
    )
  }

  private isAuthLikeErrorMessage(message: string | undefined | null): boolean {
    const normalized = (message || '').toLowerCase()
    return (
      normalized.includes('401') ||
      normalized.includes('403') ||
      normalized.includes('auth')
    )
  }

  private getAccountLogLabel(account: Pick<ProxyAccount, 'id' | 'email'>): string {
    return account.email || account.id
  }

  private logAccountSwitch(
    reason: string,
    fromAccount: Pick<ProxyAccount, 'id' | 'email'>,
    toAccount: Pick<ProxyAccount, 'id' | 'email'>,
    data?: Record<string, unknown>
  ): void {
    proxyLogger.warn(
      'AccountSwitch',
      `Switched account: ${this.getAccountLogLabel(fromAccount)} -> ${this.getAccountLogLabel(toAccount)} (${reason})`,
      {
        reason,
        fromAccountId: fromAccount.id,
        fromEmail: fromAccount.email,
        toAccountId: toAccount.id,
        toEmail: toAccount.email,
        ...data
      }
    )
  }

  private logSwitchUnavailable(
    reason: string,
    account: Pick<ProxyAccount, 'id' | 'email'>,
    data?: Record<string, unknown>
  ): void {
    proxyLogger.warn(
      'AccountSelection',
      `Unable to switch away from ${this.getAccountLogLabel(account)} (${reason})`,
      {
        reason,
        accountId: account.id,
        email: account.email,
        ...data
      }
    )
  }

  private markAccountRateLimited(currentAccount: ProxyAccount, errMsg: string): void {
    this.accountPool.recordError(currentAccount.id, true)
    this.events.onAccountUpdate?.(this.accountPool.getAccount(currentAccount.id) || currentAccount)
    proxyLogger.warn('ProxyServer', `Quota/throttle detected for ${this.getAccountLogLabel(currentAccount)}`, {
      accountId: currentAccount.id,
      email: currentAccount.email,
      error: errMsg,
      action: 'moved_to_rate_limited_pool'
    })
  }

  private getQuotaFallbackAccount(currentAccount: ProxyAccount, errMsg: string): ProxyAccount | null {
    this.markAccountRateLimited(currentAccount, errMsg)
    return null
  }

  private async getAuthFallbackAccount(
    currentAccount: ProxyAccount,
    errMsg: string,
    leasedAccountIds: Set<string> = new Set()
  ): Promise<ProxyAccount | null> {
    proxyLogger.warn('ProxyServer', `Auth error detected for ${this.getAccountLogLabel(currentAccount)}`, {
      accountId: currentAccount.id,
      email: currentAccount.email,
      error: errMsg
    })

    const refreshed = await this.refreshToken(currentAccount)
    if (refreshed) {
      return this.accountPool.getAccount(currentAccount.id) || currentAccount
    }

    if (!this.config.enableMultiAccount) {
      this.logSwitchUnavailable('auth_refresh_failed_no_alternative_account', currentAccount, {
        error: errMsg
      })
      return null
    }

    if (leasedAccountIds.size === 0) {
      this.logSwitchUnavailable('auth_refresh_failed_no_tracked_lease', currentAccount, {
        error: errMsg
      })
      return null
    }

    const nextAccount = this.accountPool.acquireNextAvailableAccount(currentAccount.id)
    if (nextAccount && nextAccount.id !== currentAccount.id) {
      leasedAccountIds.add(nextAccount.id)
      this.logAccountSwitch('auth_refresh_failed', currentAccount, nextAccount, {
        error: errMsg
      })
      this.releaseLeasedAccount(leasedAccountIds, currentAccount.id)
      return this.prepareAccountForUse(nextAccount, leasedAccountIds, new Set([currentAccount.id]))
    }

    this.logSwitchUnavailable('auth_refresh_failed_no_alternative_account', currentAccount, {
      error: errMsg
    })
    return null
  }

  // 鍚姩鏈嶅姟鍣?
  async start(): Promise<void> {
    if (this.server) {
      console.log('[ProxyServer] Server already running')
      return
    }

    return new Promise((resolve, reject) => {
      const requestHandler = (req: http.IncomingMessage, res: http.ServerResponse) => 
        this.handleRequest(req, res)

      // 妫€鏌ユ槸鍚﹀惎鐢?TLS
      if (this.config.tls?.enabled) {
        try {
          const tlsOptions = this.getTlsOptions()
          this.server = https.createServer(tlsOptions, requestHandler)
          this.isHttps = true
        } catch (error) {
          reject(new Error(`TLS configuration error: ${(error as Error).message}`))
          return
        }
      } else {
        this.server = http.createServer(requestHandler)
        this.isHttps = false
      }

      this.server.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'EADDRINUSE') {
          console.error(`[ProxyServer] Port ${this.config.port} is already in use`)
          reject(new Error(`Port ${this.config.port} is already in use`))
        } else {
          console.error('[ProxyServer] Server error:', error)
          reject(error)
        }
        this.events.onError?.(error)
      })

      // 鏈嶅姟鍣ㄥ叧闂椂灏濊瘯鑷姩閲嶅惎
      this.server.on('close', () => {
        if (this.config.autoStart && this.config.enabled) {
          console.log('[ProxyServer] Server closed unexpectedly, attempting restart in 3s...')
          setTimeout(() => {
            if (this.config.autoStart && !this.isRunning()) {
              console.log('[ProxyServer] Auto-restarting...')
              this.start().catch(err => {
                console.error('[ProxyServer] Auto-restart failed:', err)
              })
            }
          }, 3000)
        }
      })

      const protocol = this.isHttps ? 'https' : 'http'
      this.server.listen(this.config.port, this.config.host, () => {
        proxyLogger.info('ProxyServer', `Started on ${protocol}://${this.config.host}:${this.config.port}`)
        this.stats.startTime = Date.now()
        // 閲嶇疆浼氳瘽缁熻
        this.sessionStats = {
          totalRequests: 0,
          successRequests: 0,
          failedRequests: 0,
          startTime: Date.now()
        }
        this.events.onStatusChange?.(true, this.config.port)
        resolve()
      })
    })
  }

  // 鑾峰彇 TLS 閰嶇疆閫夐」
  private getTlsOptions(): https.ServerOptions {
    const tls = this.config.tls!
    
    let cert: string
    let key: string

    // 浼樺厛浣跨敤鐩存帴鎻愪緵鐨?PEM 鍐呭
    if (tls.cert && tls.key) {
      cert = tls.cert
      key = tls.key
    } else if (tls.certPath && tls.keyPath) {
      // 浠庢枃浠惰鍙?
      cert = fs.readFileSync(tls.certPath, 'utf8')
      key = fs.readFileSync(tls.keyPath, 'utf8')
    } else {
      throw new Error('TLS enabled but no certificate/key provided')
    }

    return { cert, key }
  }

  // 鍋滄鏈嶅姟鍣?
  async stop(): Promise<void> {
    if (!this.server) {
      return
    }

    return new Promise((resolve) => {
      this.server!.close(() => {
        proxyLogger.info('ProxyServer', 'Stopped')
        this.server = null
        this.events.onStatusChange?.(false, this.config.port)
        resolve()
      })
    })
  }

  // 鏇存柊閰嶇疆
  updateConfig(config: Partial<ProxyConfig>): void {
    this.config = this.normalizeConfig({ ...this.config, ...config } as ProxyConfig)
    this.accountPool.updateConfig({
      maxInFlightPerAccount: this.config.maxInFlightPerAccount
    })
  }

  // 鑾峰彇閰嶇疆
  getConfig(): ProxyConfig {
    return { ...this.config }
  }

  // 鑾峰彇缁熻淇℃伅
  getStats(): ProxyStats {
    // 杩斿洖鍙簭鍒楀寲鐨勭粺璁′俊鎭紙Map 瀵硅薄鍦?IPC 涓棤娉曟纭簭鍒楀寲锛?
    return {
      totalRequests: this.stats.totalRequests,
      successRequests: this.stats.successRequests,
      failedRequests: this.stats.failedRequests,
      totalTokens: this.stats.totalTokens,
      totalCredits: this.stats.totalCredits,
      inputTokens: this.stats.inputTokens,
      outputTokens: this.stats.outputTokens,
      startTime: this.stats.startTime,
      accountStats: this.stats.accountStats,
      endpointStats: this.stats.endpointStats,
      modelStats: this.stats.modelStats,
      recentRequests: this.stats.recentRequests
    }
  }

  // 鑾峰彇璐﹀彿姹?
  getAccountPool(): AccountPool {
    return this.accountPool
  }

  // 璁剧疆鍒濆绱 credits锛堢敤浜庝粠鎸佷箙鍖栧瓨鍌ㄦ仮澶嶏級
  setTotalCredits(credits: number): void {
    this.stats.totalCredits = credits
  }

  // 閲嶇疆绱 credits
  resetTotalCredits(): void {
    this.stats.totalCredits = 0
    this.events.onCreditsUpdate?.(0)
  }

  // 璁剧疆鍒濆绱 tokens锛堢敤浜庝粠鎸佷箙鍖栧瓨鍌ㄦ仮澶嶏級
  setTotalTokens(inputTokens: number, outputTokens: number): void {
    this.stats.inputTokens = inputTokens
    this.stats.outputTokens = outputTokens
    this.stats.totalTokens = inputTokens + outputTokens
  }

  // 閲嶇疆绱 tokens
  resetTotalTokens(): void {
    this.stats.inputTokens = 0
    this.stats.outputTokens = 0
    this.stats.totalTokens = 0
  }

  // 璁剧疆璇锋眰缁熻锛堢敤浜庝粠鎸佷箙鍖栧瓨鍌ㄦ仮澶嶏級
  setRequestStats(totalRequests: number, successRequests: number, failedRequests: number): void {
    this.stats.totalRequests = totalRequests
    this.stats.successRequests = successRequests
    this.stats.failedRequests = failedRequests
  }

  // 閲嶇疆璇锋眰缁熻
  resetRequestStats(): void {
    this.stats.totalRequests = 0
    this.stats.successRequests = 0
    this.stats.failedRequests = 0
    this.notifyRequestStatsUpdate()
  }

  // 閫氱煡璇锋眰缁熻鏇存柊
  private notifyRequestStatsUpdate(): void {
    this.events.onRequestStatsUpdate?.(
      this.stats.totalRequests,
      this.stats.successRequests,
      this.stats.failedRequests
    )
  }

  // 璁板綍璇锋眰鎴愬姛
  private recordRequestSuccess(): void {
    this.stats.successRequests++
    this.sessionStats.successRequests++
    this.notifyRequestStatsUpdate()
  }

  // 璁板綍璇锋眰澶辫触
  private recordRequestFailed(): void {
    this.stats.failedRequests++
    this.sessionStats.failedRequests++
    this.notifyRequestStatsUpdate()
  }

  // 璁板綍鏂拌姹?
  private recordNewRequest(): void {
    this.stats.totalRequests++
    this.sessionStats.totalRequests++
    this.notifyRequestStatsUpdate()
  }

  // 鑾峰彇浼氳瘽缁熻锛堝綋鍓嶆湇鍔¤繍琛屾湡闂寸殑缁熻锛?
  getSessionStats(): { totalRequests: number; successRequests: number; failedRequests: number; startTime: number } {
    return { ...this.sessionStats }
  }

  // 鏄惁杩愯涓?
  isRunning(): boolean {
    return this.server !== null
  }

  // 娓呴櫎妯″瀷缂撳瓨锛屽己鍒朵笅娆¤姹傞噸鏂拌幏鍙?
  clearModelCache(): void {
    this.modelCache = null
    console.log('[ProxyServer] Model cache cleared')
  }

  // 鑾峰彇鍙敤妯″瀷鍒楄〃
  async getAvailableModels(): Promise<{ models: Array<{ id: string; name: string; description: string; inputTypes?: string[]; maxInputTokens?: number | null; maxOutputTokens?: number | null; rateMultiplier?: number; rateUnit?: string }>; fromCache: boolean }> {
    const now = Date.now()
    
    // 妫€鏌ョ紦瀛?
    if (this.modelCache && (now - this.modelCache.timestamp) < this.MODEL_CACHE_TTL) {
      return {
        models: this.modelCache.models.map(m => ({
          id: m.modelId,
          name: m.modelName,
          description: m.description,
          inputTypes: m.supportedInputTypes,
          maxInputTokens: m.tokenLimits?.maxInputTokens,
          maxOutputTokens: m.tokenLimits?.maxOutputTokens,
          rateMultiplier: m.rateMultiplier,
          rateUnit: m.rateUnit
        })),
        fromCache: true
      }
    }

    // 浣跨敤涓庤姹傚鐞嗙浉鍚岀殑璐﹀彿閫夋嫨閫昏緫
    const leasedAccountIds = new Set<string>()
    const account = await this.getAvailableAccount(leasedAccountIds)
    if (!account) {
      return { models: [], fromCache: false }
    }

    try {
      const kiroModels = await fetchKiroModels(account)
      if (kiroModels.length > 0) {
        this.modelCache = { models: kiroModels, timestamp: now }
      }
      return {
        models: kiroModels.map(m => ({
          id: m.modelId,
          name: m.modelName,
          description: m.description,
          inputTypes: m.supportedInputTypes,
          maxInputTokens: m.tokenLimits?.maxInputTokens,
          maxOutputTokens: m.tokenLimits?.maxOutputTokens,
          rateMultiplier: m.rateMultiplier,
          rateUnit: m.rateUnit
        })),
        fromCache: false
      }
    } catch (error) {
      console.error('[ProxyServer] Failed to fetch models:', error)
      return { models: [], fromCache: false }
    } finally {
      this.releaseLeasedAccounts(leasedAccountIds)
    }
  }

  // 妫€鏌?Token 鏄惁闇€瑕佸埛鏂?
  private isTokenExpiringSoon(account: ProxyAccount): boolean {
    if (!account.expiresAt) return false
    const refreshBeforeMs = (this.config.tokenRefreshBeforeExpiry || 300) * 1000
    return Date.now() + refreshBeforeMs >= account.expiresAt
  }

  private needsTokenRefresh(account: ProxyAccount): boolean {
    return !account.accessToken || this.isTokenExpiringSoon(account)
  }

  // 鍒锋柊 Token
  private async refreshToken(account: ProxyAccount): Promise<boolean> {
    if (!this.events.onTokenRefresh) {
      console.warn('[ProxyServer] No token refresh callback configured')
      return false
    }

    // 闃叉骞跺彂鍒锋柊
    if (this.refreshingTokens.has(account.id)) {
      console.log(`[ProxyServer] Token refresh already in progress for ${account.email || account.id}`)
      // 绛夊緟鍒锋柊瀹屾垚
      await new Promise(resolve => setTimeout(resolve, 1000))
      return !this.needsTokenRefresh(this.accountPool.getAccount(account.id) || account)
    }

    this.refreshingTokens.add(account.id)
    console.log(`[ProxyServer] Refreshing token for ${account.email || account.id}`)

    try {
      const result = await this.events.onTokenRefresh(account)
      if (result.success && result.accessToken) {
        // 鏇存柊璐﹀彿姹犱腑鐨?Token
        this.accountPool.updateAccount(account.id, {
          accessToken: result.accessToken,
          refreshToken: result.refreshToken || account.refreshToken,
          expiresAt: result.expiresAt
        })
        // 閫氱煡澶栭儴鏇存柊
        this.events.onAccountUpdate?.({
          ...account,
          accessToken: result.accessToken,
          refreshToken: result.refreshToken || account.refreshToken,
          expiresAt: result.expiresAt
        })
        console.log(`[ProxyServer] Token refreshed for ${account.email || account.id}`)
        return true
      } else {
        console.error(`[ProxyServer] Token refresh failed for ${account.email || account.id}: ${result.error}`)
        this.accountPool.markNeedsRefresh(account.id)
        return false
      }
    } catch (error) {
      console.error(`[ProxyServer] Token refresh error for ${account.email || account.id}:`, error)
      this.accountPool.markNeedsRefresh(account.id)
      return false
    } finally {
      this.refreshingTokens.delete(account.id)
    }
  }

  private async prepareAccountForUse(
    account: ProxyAccount,
    leasedAccountIds: Set<string> = new Set(),
    attemptedAccountIds: Set<string> = new Set()
  ): Promise<ProxyAccount | null> {
    if (attemptedAccountIds.has(account.id)) {
      this.releaseLeasedAccount(leasedAccountIds, account.id)
      return null
    }

    attemptedAccountIds.add(account.id)
    this.syncKProxyDeviceId(account)

    if (!this.needsTokenRefresh(account)) {
      return account
    }

    const refreshed = await this.refreshToken(account)
    if (refreshed) {
      return this.accountPool.getAccount(account.id) || account
    }

    if (!this.config.enableMultiAccount) {
      return null
    }

    const nextAccount = this.accountPool.acquireNextAvailableAccount(account.id)
    if (!nextAccount) {
      this.logSwitchUnavailable('token_refresh_failed_no_fallback_account', account)
      return null
    }

    leasedAccountIds.add(nextAccount.id)
    this.logAccountSwitch('token_refresh_failed', account, nextAccount)
    this.releaseLeasedAccount(leasedAccountIds, account.id)

    return this.prepareAccountForUse(nextAccount, leasedAccountIds, attemptedAccountIds)
  }

  // 鑾峰彇鍙敤璐﹀彿锛堝寘鍚?Token 鍒锋柊妫€鏌ワ級
  private async getAvailableAccount(leasedAccountIds: Set<string> = new Set()): Promise<ProxyAccount | null> {
    let account: ProxyAccount | null
    
    // 妫€鏌ユ槸鍚﹀惎鐢ㄥ璐﹀彿杞
    if (this.config.enableMultiAccount) {
      account = this.accountPool.acquireNextAccount()
      if (account) {
        leasedAccountIds.add(account.id)
      }
    } else {
      // 绂佺敤澶氳处鍙疯疆璇㈡椂锛屼紭鍏堜娇鐢ㄦ寚瀹氱殑璐﹀彿
      if (this.config.selectedAccountIds && this.config.selectedAccountIds.length > 0) {
        // 浣跨敤鎸囧畾鐨勭涓€涓处鍙?
        const selectedAccountId = this.config.selectedAccountIds[0]
        const selectedAccount = this.accountPool.getAccount(selectedAccountId)
        if (!selectedAccount) {
          console.log(`[ProxyServer] Selected account ${this.config.selectedAccountIds[0]} not found, using first available`)
          account = this.accountPool.acquireFirstAvailableAccount()
          if (account) {
            leasedAccountIds.add(account.id)
          }
        } else if (!this.accountPool.isAccountAvailable(selectedAccountId)) {
          this.logSwitchUnavailable('selected_account_unavailable', selectedAccount, {
            cooldownReason: selectedAccount.cooldownReason,
            cooldownUntil: selectedAccount.cooldownUntil
          })

          if (this.config.autoSwitchOnQuotaExhausted && selectedAccount.cooldownReason === 'quota') {
            const nextAccount = this.accountPool.acquireNextAvailableAccount(selectedAccountId)
            if (nextAccount && nextAccount.id !== selectedAccountId) {
              leasedAccountIds.add(nextAccount.id)
              this.logAccountSwitch('quota_exhausted', selectedAccount, nextAccount, {
                selectedAccountId
              })
              account = nextAccount
              this.config.selectedAccountIds = [nextAccount.id]
              this.events.onAccountUpdate?.(nextAccount)
            } else {
              account = null
            }
          } else {
            account = null
          }
        } else {
          account = this.accountPool.acquireAccountById(selectedAccountId)
          if (account) {
            leasedAccountIds.add(account.id)
          }
        }
      } else {
        // 娌℃湁鎸囧畾璐﹀彿锛屼娇鐢ㄧ涓€涓彲鐢ㄨ处鍙?
        account = this.accountPool.acquireFirstAvailableAccount()
        if (account) {
          leasedAccountIds.add(account.id)
        }
      }
    }
    
    if (!account) return null

    return this.prepareAccountForUse(account, leasedAccountIds)
  }

  // 鍚屾 K-Proxy 璁惧 ID锛堟牴鎹处鍙疯嚜鍔ㄥ垏鎹級
  private syncKProxyDeviceId(account: ProxyAccount): void {
    const kproxyService = getKProxyService()
    if (!kproxyService || !kproxyService.isRunning()) {
      return // K-Proxy 鏈垵濮嬪寲鎴栨湭杩愯
    }

    // 灏濊瘯鍒囨崲鍒拌处鍙风粦瀹氱殑璁惧 ID
    const switched = kproxyService.switchToAccount(account.id)
    
    if (!switched) {
      // 璐﹀彿娌℃湁缁戝畾璁惧 ID锛岃嚜鍔ㄧ敓鎴愬苟缁戝畾
      const newDeviceId = generateDeviceId()
      kproxyService.addDeviceIdMapping({
        accountId: account.id,
        deviceId: newDeviceId,
        description: account.email || `Account ${account.id.substring(0, 8)}`,
        createdAt: Date.now()
      })
      kproxyService.setDeviceId(newDeviceId)
      proxyLogger.info('ProxyServer', `Auto-generated device ID for account ${account.email || account.id.substring(0, 8)}`)
    } else {
      proxyLogger.debug('ProxyServer', `Switched to device ID for account ${account.email || account.id.substring(0, 8)}`)
    }
  }

  // 甯﹂噸璇曠殑 API 璋冪敤
  private async callWithRetry<T>(
    account: ProxyAccount,
    apiCall: (acc: ProxyAccount, endpointIndex: number) => Promise<T>,
    _path: string // 鐢ㄤ簬鏃ュ織
  ): Promise<{ result: T; account: ProxyAccount }> {
    const maxRetries = this.config.maxRetries || 3
    const retryDelay = this.config.retryDelayMs || 1000
    let lastError: Error | null = null
    let currentAccount = account
    let endpointIndex = 0

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const result = await apiCall(currentAccount, endpointIndex)
        return { result, account: currentAccount }
      } catch (error) {
        lastError = error as Error
        const abortedError = this.getAbortedRequestError(undefined, lastError)
        if (abortedError) {
          lastError = abortedError
          break
        }
        const errMsg = lastError.message || ''

        console.log(`[ProxyServer] API call failed (attempt ${attempt + 1}/${maxRetries}): ${errMsg}`)

        // 401/403: 灏濊瘯鍒锋柊 Token
        if (this.isAuthLikeErrorMessage(errMsg)) {
          console.log('[ProxyServer] Auth error, attempting token refresh')
          const refreshed = await this.refreshToken(currentAccount)
          if (refreshed) {
            currentAccount = this.accountPool.getAccount(currentAccount.id) || currentAccount
            continue
          }
          // 鍒锋柊澶辫触锛屽彧鍦ㄥ惎鐢ㄥ璐﹀彿鏃跺垏鎹㈣处鍙?
          this.logSwitchUnavailable('auth_refresh_failed_no_alternative_account', currentAccount, {
            error: errMsg
          })
        }

        // 402/429: 棰濆害鑰楀敖锛屽垏鎹㈢鐐规垨璐﹀彿
        if (this.isQuotaLikeErrorMessage(errMsg)) {
          console.log('[ProxyServer] Quota/throttle error, moving current account to the rate-limited pool')
          this.markAccountRateLimited(currentAccount, errMsg)
          Object.assign(lastError as Error & { accountId?: string; accountStateHandled?: boolean; statusCode?: number }, {
            accountId: currentAccount.id,
            accountStateHandled: true,
            statusCode: 429
          })
          break
        }

        // 5xx: 閲嶈瘯
        if (errMsg.includes('500') || errMsg.includes('502') || errMsg.includes('503') || errMsg.includes('504')) {
          console.log('[ProxyServer] Server error, retrying')
          await new Promise(resolve => setTimeout(resolve, retryDelay * (attempt + 1)))
          endpointIndex = (endpointIndex + 1) % 2
          continue
        }

        // 鍏朵粬閿欒锛屼笉閲嶈瘯
        break
      }
    }

    throw lastError || new Error('Unknown error')
  }

  // 楠岃瘉 API Key 骞惰繑鍥炲尮閰嶇殑 Key锛堢敤浜庣粺璁★級
  private validateApiKey(req: http.IncomingMessage): { valid: boolean; apiKey?: import('./types').ApiKey; reason?: string } {
    // 濡傛灉娌℃湁閰嶇疆浠讳綍 API Key锛屽垯璺宠繃楠岃瘉
    const hasApiKeys = this.config.apiKeys && this.config.apiKeys.length > 0
    const hasLegacyKey = !!this.config.apiKey
    if (!hasApiKeys && !hasLegacyKey) return { valid: true }

    // 浠?Authorization 澶存垨 X-Api-Key 澶磋幏鍙?API Key
    const authHeader = req.headers['authorization'] || ''
    const apiKeyHeader = (req.headers['x-api-key'] as string) || ''

    let providedKey = ''
    // Bearer token 鏍煎紡
    if (authHeader.startsWith('Bearer ')) {
      providedKey = authHeader.slice(7)
    }
    // 鐩存帴 API Key 鏍煎紡
    if (!providedKey && apiKeyHeader) {
      providedKey = apiKeyHeader
    }

    if (!providedKey) return { valid: false }

    // 妫€鏌ュ API Key
    if (hasApiKeys) {
      const matchedKey = this.config.apiKeys!.find(k => k.enabled && k.key === providedKey)
      if (matchedKey) {
        // 妫€鏌ラ搴﹂檺鍒?
        if (matchedKey.creditsLimit && matchedKey.usage.totalCredits >= matchedKey.creditsLimit) {
          return { valid: false, reason: 'Credits limit exceeded' }
        }
        return { valid: true, apiKey: matchedKey }
      }
    }

    // 鍏煎鏃х殑鍗?API Key
    if (hasLegacyKey && providedKey === this.config.apiKey) {
      return { valid: true }
    }

    return { valid: false }
  }

  // 璁板綍 API Key 鐢ㄩ噺
  recordApiKeyUsage(apiKeyId: string, credits: number, inputTokens: number, outputTokens: number, model?: string, path?: string): void {
    if (!this.config.apiKeys) return
    const apiKey = this.config.apiKeys.find(k => k.id === apiKeyId)
    if (!apiKey) return

    const today = new Date().toISOString().split('T')[0]
    const now = Date.now()
    
    // 鏇存柊鎬昏
    apiKey.usage.totalRequests++
    apiKey.usage.totalCredits += credits
    apiKey.usage.totalInputTokens += inputTokens
    apiKey.usage.totalOutputTokens += outputTokens
    apiKey.lastUsedAt = now

    // 鏇存柊鏃ョ粺璁?
    if (!apiKey.usage.daily[today]) {
      apiKey.usage.daily[today] = { requests: 0, credits: 0, inputTokens: 0, outputTokens: 0 }
    }
    apiKey.usage.daily[today].requests++
    apiKey.usage.daily[today].credits += credits
    apiKey.usage.daily[today].inputTokens += inputTokens
    apiKey.usage.daily[today].outputTokens += outputTokens

    // 鏇存柊妯″瀷缁熻
    if (model) {
      if (!apiKey.usage.byModel) {
        apiKey.usage.byModel = {}
      }
      if (!apiKey.usage.byModel[model]) {
        apiKey.usage.byModel[model] = { requests: 0, credits: 0, inputTokens: 0, outputTokens: 0 }
      }
      apiKey.usage.byModel[model].requests++
      apiKey.usage.byModel[model].credits += credits
      apiKey.usage.byModel[model].inputTokens += inputTokens
      apiKey.usage.byModel[model].outputTokens += outputTokens
    }

    // 娣诲姞鐢ㄩ噺鍘嗗彶璁板綍锛堜繚鐣欐渶杩?100 鏉★級
    if (!apiKey.usageHistory) {
      apiKey.usageHistory = []
    }
    apiKey.usageHistory.unshift({
      timestamp: now,
      model: model || 'unknown',
      inputTokens,
      outputTokens,
      credits,
      path: path || 'unknown'
    })
    if (apiKey.usageHistory.length > 100) {
      apiKey.usageHistory = apiKey.usageHistory.slice(0, 100)
    }

    // 瑙﹀彂閰嶇疆淇濆瓨浜嬩欢
    this.events.onConfigChanged?.(this.config)
  }

  // 搴旂敤妯″瀷鏄犲皠
  private applyModelMapping(requestedModel: string, apiKeyId?: string): string {
    const mappings = this.config.modelMappings
    if (!mappings || mappings.length === 0) return requestedModel

    // 鎸変紭鍏堢骇鎺掑簭锛堟暟瀛楄秺灏忎紭鍏堢骇瓒婇珮锛?
    const sortedMappings = [...mappings].sort((a, b) => a.priority - b.priority)

    for (const rule of sortedMappings) {
      // 妫€鏌ヨ鍒欐槸鍚﹀惎鐢?
      if (!rule.enabled) continue

      // 妫€鏌ユ槸鍚﹂€傜敤浜庡綋鍓?API Key
      if (rule.apiKeyIds && rule.apiKeyIds.length > 0 && apiKeyId) {
        if (!rule.apiKeyIds.includes(apiKeyId)) continue
      }

      // 妫€鏌ユ簮妯″瀷鏄惁鍖归厤锛堟敮鎸侀€氶厤绗?*锛?
      const sourcePattern = rule.sourceModel.replace(/\*/g, '.*')
      const regex = new RegExp(`^${sourcePattern}$`, 'i')
      if (!regex.test(requestedModel)) continue

      // 鍖归厤鎴愬姛锛屾牴鎹被鍨嬮€夋嫨鐩爣妯″瀷
      const validTargets = rule.targetModels.filter(t => t.trim())
      if (validTargets.length === 0) continue

      let targetModel: string

      if (rule.type === 'loadbalance' && validTargets.length > 1) {
        // 璐熻浇鍧囪　锛氭牴鎹潈閲嶉殢鏈洪€夋嫨
        const weights = rule.weights || validTargets.map(() => 1)
        const totalWeight = weights.reduce((a, b) => a + b, 0)
        let random = Math.random() * totalWeight
        let selectedIndex = 0
        for (let i = 0; i < weights.length; i++) {
          random -= weights[i]
          if (random <= 0) {
            selectedIndex = i
            break
          }
        }
        targetModel = validTargets[selectedIndex]
      } else {
        // replace 鎴?alias锛氱洿鎺ヤ娇鐢ㄧ涓€涓洰鏍?
        targetModel = validTargets[0]
      }

      proxyLogger.info('ProxyServer', `Model mapping applied: ${requestedModel} -> ${targetModel} (rule: ${rule.name}, type: ${rule.type})`)
      return targetModel
    }

    return requestedModel
  }

  // 澶勭悊璇锋眰
  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const path = req.url || '/'
    const method = req.method || 'GET'

    // CORS 棰勬
    if (method === 'OPTIONS') {
      this.setCorsHeaders(res)
      res.writeHead(204)
      res.end()
      return
    }

    this.setCorsHeaders(res)

    // API Key 楠岃瘉锛堝仴搴锋鏌ョ鐐归櫎澶栵級
    if (path !== '/health' && path !== '/') {
      const authResult = this.validateApiKey(req)
      if (!authResult.valid) {
        const errorMsg = authResult.reason || 'Invalid or missing API key'
        const statusCode = authResult.reason === 'Credits limit exceeded' ? 429 : 401
        this.sendError(res, statusCode, errorMsg)
        return
      }
      // 灏嗗尮閰嶇殑 API Key 瀛樺偍鍒拌姹傚璞′腑锛岀敤浜庡悗缁粺璁?
      ;(req as unknown as { matchedApiKey?: import('./types').ApiKey }).matchedApiKey = authResult.apiKey
    }

    // 璁板綍璇锋眰
    if (this.config.logRequests) {
      proxyLogger.info('ProxyServer', `${method} ${path}`)
    }

    try {
      // 璺敱锛堢Щ闄ゆ煡璇㈠弬鏁帮級
      const pathWithoutQuery = path.split('?')[0]
      
      if (pathWithoutQuery === '/v1/models' || pathWithoutQuery === '/models') {
        await this.handleModels(res)
      } else if (pathWithoutQuery === '/v1/chat/completions' || pathWithoutQuery === '/chat/completions') {
        await this.handleOpenAIChat(req, res)
      } else if (pathWithoutQuery === '/v1/messages' || pathWithoutQuery === '/messages' || pathWithoutQuery === '/anthropic/v1/messages') {
        await this.handleClaudeMessages(req, res)
      } else if (pathWithoutQuery === '/v1/messages/count_tokens' || pathWithoutQuery === '/messages/count_tokens') {
        // Claude Code token 璁℃暟绔偣 - 杩斿洖妯℃嫙鍝嶅簲
        this.handleCountTokens(req, res)
      } else if (pathWithoutQuery === '/api/event_logging/batch') {
        // Claude Code 閬ユ祴绔偣 - 鐩存帴杩斿洖 200 OK
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ status: 'ok' }))
      } else if (pathWithoutQuery === '/health' || pathWithoutQuery === '/') {
        this.handleHealth(res)
      } else if (pathWithoutQuery.startsWith('/admin/')) {
        // 绠＄悊 API 绔偣
        await this.handleAdminApi(req, res, pathWithoutQuery)
      } else {
        // 璁板綍鏈煡璺緞浠ヤ究璋冭瘯
        console.log(`[ProxyServer] Unknown path: ${path} (method: ${method})`)
        this.sendError(res, 404, `Not Found: ${pathWithoutQuery}`)
      }
    } catch (error) {
      const requestError = error as Error & { statusCode?: number }
      const statusCode = requestError.statusCode || (this.isAbortLikeError(requestError) ? 499 : 500)
      if (statusCode !== 499) {
        console.error('[ProxyServer] Request error:', error)
      }
      if (statusCode !== 499) {
        this.sendError(res, statusCode, requestError.message)
      }
      this.events.onError?.(error as Error)
    }
  }

  // 绠＄悊 API 绔偣
  private async handleAdminApi(req: http.IncomingMessage, res: http.ServerResponse, path: string): Promise<void> {
    const method = req.method || 'GET'

    // 绠＄悊 API 闇€瑕?API Key 楠岃瘉
    const authResult = this.validateApiKey(req)
    if (!authResult.valid) {
      this.sendError(res, 401, 'Admin API requires authentication')
      return
    }

    if (path === '/admin/stats' && method === 'GET') {
      // 鑾峰彇璇︾粏缁熻
      this.handleAdminStats(res)
    } else if (path === '/admin/accounts' && method === 'GET') {
      // 鑾峰彇璐﹀彿鍒楄〃
      this.handleAdminAccounts(res)
    } else if (path === '/admin/config' && method === 'GET') {
      // 鑾峰彇閰嶇疆
      this.handleAdminConfig(res)
    } else if (path === '/admin/config' && method === 'POST') {
      // 鏇存柊閰嶇疆
      const body = await this.readBody(req)
      const newConfig = this.parseJsonBody<Partial<ProxyConfig>>(body, 'Invalid proxy config')
      this.updateConfig(newConfig)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ success: true, config: this.getConfig() }))
    } else if (path === '/admin/logs' && method === 'GET') {
      // 鑾峰彇鏈€杩戞棩蹇?
      this.handleAdminLogs(res)
    } else {
      this.sendError(res, 404, 'Admin endpoint not found')
    }
  }

  // 绠＄悊 API - 璇︾粏缁熻
  private handleAdminStats(res: http.ServerResponse): void {
    const stats = this.getStats()
    const accountStats: Record<string, unknown> = {}
    stats.accountStats.forEach((v, k) => { accountStats[k] = v })

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      totalRequests: stats.totalRequests,
      successRequests: stats.successRequests,
      failedRequests: stats.failedRequests,
      totalTokens: stats.totalTokens,
      inputTokens: stats.inputTokens,
      outputTokens: stats.outputTokens,
      activeRequests: this.activeRequests,
      queuedRequests: this.pendingRequestQueue.length,
      accounts: this.accountPool.size,
      availableAccounts: this.accountPool.availableCount,
      rateLimitedAccounts: this.accountPool.rateLimitedCount,
      uptime: Date.now() - stats.startTime,
      startTime: stats.startTime,
      accountStats,
      recentRequests: stats.recentRequests.slice(-50)
    }))
  }

  // 绠＄悊 API - 璐﹀彿鍒楄〃
  private handleAdminAccounts(res: http.ServerResponse): void {
    const accounts = this.accountPool.getAllAccounts().map(acc => ({
      id: acc.id,
      email: acc.email,
      isAvailable: this.accountPool.isAccountAvailable(acc.id),
      lastUsed: acc.lastUsed,
      requestCount: acc.requestCount || 0,
      errorCount: acc.errorCount || 0,
      cooldownUntil: acc.cooldownUntil,
      cooldownReason: acc.cooldownReason,
      expiresAt: acc.expiresAt,
      authMethod: acc.authMethod
    }))

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      total: accounts.length,
      available: accounts.filter(a => a.isAvailable).length,
      rateLimited: accounts.filter(a => a.cooldownReason === 'quota').length,
      accounts
    }))
  }

  // 绠＄悊 API - 閰嶇疆
  private handleAdminConfig(res: http.ServerResponse): void {
    const config = this.getConfig()
    // 闅愯棌鏁忔劅淇℃伅
    const safeConfig = {
      ...config,
      apiKey: config.apiKey ? '***' : undefined,
      tls: config.tls ? { enabled: config.tls.enabled } : undefined
    }

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(safeConfig))
  }

  // 绠＄悊 API - 鏃ュ織
  private handleAdminLogs(res: http.ServerResponse): void {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      recentRequests: this.stats.recentRequests.slice(-100)
    }))
  }

  // 璁剧疆 CORS 澶?
  private setCorsHeaders(res: http.ServerResponse): void {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Api-Key, anthropic-version, anthropic-beta, x-api-key, x-stainless-os, x-stainless-lang, x-stainless-package-version, x-stainless-runtime, x-stainless-runtime-version, x-stainless-arch')
    res.setHeader('Access-Control-Expose-Headers', 'x-request-id, x-ratelimit-limit-requests, x-ratelimit-limit-tokens, x-ratelimit-remaining-requests, x-ratelimit-remaining-tokens, x-ratelimit-reset-requests, x-ratelimit-reset-tokens')
  }

  // 鍋ュ悍妫€鏌?
  private handleHealth(res: http.ServerResponse): void {
    const stats = this.getStats()
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      status: 'ok',
      version: '1.0.0',
      accounts: this.accountPool.size,
      availableAccounts: this.accountPool.availableCount,
      rateLimitedAccounts: this.accountPool.rateLimitedCount,
      activeRequests: this.activeRequests,
      queuedRequests: this.pendingRequestQueue.length,
      stats: {
        totalRequests: stats.totalRequests,
        successRequests: stats.successRequests,
        failedRequests: stats.failedRequests,
        totalTokens: stats.totalTokens,
        uptime: Date.now() - stats.startTime
      }
    }))
  }

  // Claude Code token 璁℃暟锛堟ā鎷熷搷搴旓級
  private async handleCountTokens(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const body = await this.readBody(req)
      const request = this.parseJsonBody<any>(body, 'Invalid request body')
      // 绠€鍗曚及绠?token 鏁伴噺锛堟瘡4涓瓧绗︾害1涓猼oken锛?
      let totalChars = 0
      if (request.messages) {
        for (const msg of request.messages) {
          if (typeof msg.content === 'string') {
            totalChars += msg.content.length
          } else if (Array.isArray(msg.content)) {
            for (const part of msg.content) {
              if (part.type === 'text' && part.text) {
                totalChars += part.text.length
              }
            }
          }
        }
      }
      if (request.system) {
        totalChars += typeof request.system === 'string' ? request.system.length : JSON.stringify(request.system).length
      }
      const estimatedTokens = Math.ceil(totalChars / 4)
      
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ input_tokens: estimatedTokens }))
    } catch (error) {
      this.sendError(res, 400, 'Invalid request body')
    }
  }

  // 妯″瀷鍒楄〃缂撳瓨
  private modelCache: { models: KiroModel[]; timestamp: number } | null = null
  private readonly MODEL_CACHE_TTL = 5 * 60 * 1000 // 5 鍒嗛挓缂撳瓨

  // 妯″瀷鍒楄〃
  private async handleModels(res: http.ServerResponse): Promise<void> {
    const now = Date.now()
    
    // Kiro 瀹樻柟妯″瀷锛堜笌 UI 淇濇寔涓€鑷达級
    const kiroOfficialModels = [
      { id: 'auto', object: 'model', created: now, owned_by: 'kiro-api', description: 'Auto select best model' },
      { id: 'claude-sonnet-4.5', object: 'model', created: now, owned_by: 'kiro-api', description: 'The latest Claude Sonnet model' },
      { id: 'claude-sonnet-4', object: 'model', created: now, owned_by: 'kiro-api', description: 'Hybrid reasoning and coding' },
      { id: 'claude-haiku-4.5', object: 'model', created: now, owned_by: 'kiro-api', description: 'The latest Claude Haiku model' },
      { id: 'claude-opus-4.5', object: 'model', created: now, owned_by: 'kiro-api', description: 'The most powerful model' }
    ]

    // 棰勮妯″瀷锛圙PT 鍏煎鍒悕锛?
    const presetModels = [
      { id: 'gpt-4o', object: 'model', created: now, owned_by: 'kiro-proxy' },
      { id: 'gpt-4', object: 'model', created: now, owned_by: 'kiro-proxy' },
      { id: 'gpt-4-turbo', object: 'model', created: now, owned_by: 'kiro-proxy' },
      { id: 'gpt-3.5-turbo', object: 'model', created: now, owned_by: 'kiro-proxy' }
    ]

    // 灏濊瘯浠?Kiro API 鑾峰彇鍔ㄦ€佹ā鍨?
    let kiroModels: KiroModel[] = []
    
    // 妫€鏌ョ紦瀛?
    if (this.modelCache && (now - this.modelCache.timestamp) < this.MODEL_CACHE_TTL) {
      kiroModels = this.modelCache.models
    } else {
      // 鑾峰彇涓€涓彲鐢ㄨ处鍙锋潵璇锋眰妯″瀷鍒楄〃
      const leasedAccountIds = new Set<string>()
      const account = await this.getAvailableAccount(leasedAccountIds)
      if (account) {
        try {
          kiroModels = await fetchKiroModels(account)
          if (kiroModels.length > 0) {
            this.modelCache = { models: kiroModels, timestamp: now }
            proxyLogger.info('ProxyServer', `Fetched ${kiroModels.length} models from Kiro API`)
          }
        } catch (error) {
          console.error('[ProxyServer] Failed to fetch Kiro models:', error)
        } finally {
          this.releaseLeasedAccounts(leasedAccountIds)
        }
      }
    }

    // 杞崲 Kiro 妯″瀷涓?OpenAI 鏍煎紡锛堜繚鎸佸師濮?modelId锛?
    const dynamicModels = kiroModels.map(m => ({
      id: m.modelId,
      object: 'model' as const,
      created: now,
      owned_by: 'kiro-api',
      description: m.description,
      model_name: m.modelName
    }))

    // 鍚堝苟妯″瀷鍒楄〃锛屽幓閲?
    const modelIds = new Set<string>()
    const allModels: Array<{ id: string; object: string; created: number; owned_by: string; description?: string; model_name?: string }> = []
    
    // 1. 鍏堟坊鍔?Kiro 瀹樻柟妯″瀷锛堜笌 UI 淇濇寔涓€鑷达級
    for (const m of kiroOfficialModels) {
      if (!modelIds.has(m.id)) {
        modelIds.add(m.id)
        allModels.push(m)
      }
    }
    
    // 2. 娣诲姞鍔ㄦ€佹ā鍨嬶紙浠?API 鑾峰彇鐨勶紝鍙兘鏈夐澶栨ā鍨嬶級
    for (const m of dynamicModels) {
      if (!modelIds.has(m.id)) {
        modelIds.add(m.id)
        allModels.push(m)
      }
    }
    
    // 3. 娣诲姞 GPT 鍏煎鍒悕
    for (const m of presetModels) {
      if (!modelIds.has(m.id)) {
        modelIds.add(m.id)
        allModels.push(m)
      }
    }

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ object: 'list', data: allModels }))
  }

  // 澶勭悊 OpenAI Chat Completions 璇锋眰
  private async handleOpenAIChat(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const path = '/v1/chat/completions'
    const matchedApiKey = (req as unknown as { matchedApiKey?: import('./types').ApiKey }).matchedApiKey
    const leasedAccountIds = new Set<string>()
    let request: OpenAIChatRequest | null = null
    let account: ProxyAccount | null = null
    let startTime = Date.now()

    this.recordNewRequest()
    this.events.onRequest?.({ path, method: 'POST' })

    const releaseRequestSlot = await this.acquireRequestSlot()
    if (!releaseRequestSlot) {
      this.recordRequestFailed()
      this.sendError(res, 503, 'Server is busy, request queue is full')
      this.events.onResponse?.({ path, status: 503, error: 'Server is busy, request queue is full' })
      this.recordRequest({ path, success: false, error: 'Server is busy, request queue is full' })
      return
    }

    const { controller, cleanup } = this.createRequestAbortController(req, res)

    try {
      const body = await this.readBody(req, controller.signal)
      request = this.parseJsonBody<OpenAIChatRequest>(body, 'Invalid request body')

      request.model = this.applyModelMapping(request.model, matchedApiKey?.id)
      const modelThinkingEnabled = this.config.modelThinkingMode?.[request.model]
      const thinkingEnabled = modelThinkingEnabled || (req.headers['anthropic-beta'] as string || '').toLowerCase().includes('thinking')

      account = await this.getAvailableAccount(leasedAccountIds)
      if (!account) {
        this.recordRequestFailed()
        this.sendError(res, 503, 'No available accounts')
        this.events.onResponse?.({ path, model: request.model, status: 503, error: 'No available accounts' })
        this.recordRequest({ path, model: request.model, success: false, error: 'No available accounts' })
        return
      }

      this.events.onRequest?.({ path, method: 'POST', accountId: account.id })
      startTime = Date.now()

      const processedRequest = this.config.disableTools
        ? { ...request, tools: undefined, tool_choice: undefined }
        : request

      let kiroPayload = openaiToKiro(processedRequest, account.profileArn)

      if (thinkingEnabled) {
        const thinkingPrompt = `<thinking_mode>enabled</thinking_mode>\n<max_thinking_length>200000</max_thinking_length>\n\n`
        const currentMessage = kiroPayload.conversationState?.currentMessage?.userInputMessage
        if (currentMessage && typeof currentMessage.content === 'string') {
          currentMessage.content = thinkingPrompt + currentMessage.content
        }
        proxyLogger.info('ProxyServer', 'Thinking mode enabled for request')
      }

      if (this.config.logRequests) {
        const userInput = kiroPayload.conversationState.currentMessage?.userInputMessage
        const contentLength = typeof userInput?.content === 'string' ? userInput.content.length : 0
        const toolsCount = userInput?.userInputMessageContext?.tools?.length || 0
        const historyLength = kiroPayload.conversationState.history?.length || 0
        const hasImages = (userInput?.images?.length || 0) > 0

        proxyLogger.info('ProxyServer', `OpenAI API: ${request.model}`, {
          model: request.model,
          stream: request.stream,
          contentLength,
          toolsCount,
          historyLength,
          hasImages,
          accountId: account.id
        })
      }

      if (request.stream) {
        await this.handleOpenAIStream(res, account, kiroPayload, request.model, startTime, 0, undefined, false, matchedApiKey, controller.signal, leasedAccountIds)
      } else {
        const { result, account: usedAccount } = await this.callWithRetry(
          account,
          async (acc) => callKiroApi(acc, openaiToKiro(processedRequest, acc.profileArn), controller.signal),
          path
        )
        const response = kiroToOpenaiResponse(result.content, result.toolUses, result.usage, request.model)

        this.recordRequestSuccess()
        this.stats.totalTokens += result.usage.inputTokens + result.usage.outputTokens
        this.stats.inputTokens += result.usage.inputTokens
        this.stats.outputTokens += result.usage.outputTokens
        this.accountPool.recordSuccess(usedAccount.id, result.usage.inputTokens + result.usage.outputTokens)

        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(response))
        this.events.onResponse?.({ path, model: request.model, status: 200, tokens: result.usage.inputTokens + result.usage.outputTokens, inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens })
        this.recordRequest({ path, model: request.model, accountId: usedAccount.id, inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens, responseTime: Date.now() - startTime, success: true })
        if (matchedApiKey) {
          this.recordApiKeyUsage(matchedApiKey.id, result.usage.credits || 0, result.usage.inputTokens, result.usage.outputTokens, request.model, path)
        }
      }
    } catch (error) {
      this.handleApiError(res, account || { id: 'unknown' }, error as Error, path, request?.model, startTime)
    } finally {
      cleanup()
      this.releaseLeasedAccounts(leasedAccountIds)
      releaseRequestSlot()
    }
  }

  // 澶勭悊 OpenAI 娴佸紡鍝嶅簲
  private async handleOpenAIStream(
    res: http.ServerResponse,
    account: ProxyAccount,
    kiroPayload: ReturnType<typeof openaiToKiro>,
    model: string,
    startTime: number,
    currentRound: number = 0,
    streamId?: string,
    headersSent: boolean = false,
    matchedApiKey?: import('./types').ApiKey,
    signal?: AbortSignal,
    leasedAccountIds: Set<string> = new Set()
  ): Promise<void> {
    const id = streamId || `chatcmpl-${uuidv4()}`
    let toolCallIndex = 0
    const pendingToolCalls: Map<string, { index: number; name: string; arguments: string }> = new Map()
    let collectedContent = ''
    let hasLoggedThinkingFormat = false
    let streamInitialized = headersSent
    // 鐢ㄤ簬妫€娴嬫櫘閫氬搷搴斾腑鐨?<thinking> 鏍囩
    let textBuffer = ''
    let inThinkingBlock = false

    // 鍙戦€佸垵濮?chunk锛堜粎棣栬疆锛?
    const ensureStreamInitialized = () => {
      if (streamInitialized) {
        return
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      })

      if (currentRound === 0) {
        const initialChunk = createOpenaiStreamChunk(id, model, { role: 'assistant' })
        res.write(`data: ${JSON.stringify(initialChunk)}\n\n`)
      }

      streamInitialized = true
    }

    // 澶勭悊鏂囨湰杈撳嚭锛屾娴嬪苟杞崲 <thinking> 鏍囩
    const processText = (text: string, forceFlush = false) => {
      const format = this.config.thinkingOutputFormat || 'reasoning_content'
      textBuffer += text
      
      while (true) {
        if (!inThinkingBlock) {
          // 鏌ユ壘 <thinking> 寮€濮嬫爣绛?
          const thinkingStart = textBuffer.indexOf('<thinking>')
          if (thinkingStart !== -1) {
            // 杈撳嚭 thinking 鏍囩涔嬪墠鐨勫唴瀹?
            if (thinkingStart > 0) {
              const beforeThinking = textBuffer.substring(0, thinkingStart)
              collectedContent += beforeThinking
              ensureStreamInitialized()
              const chunk = createOpenaiStreamChunk(id, model, { content: beforeThinking })
              res.write(`data: ${JSON.stringify(chunk)}\n\n`)
            }
            textBuffer = textBuffer.substring(thinkingStart + 10) // 绉婚櫎 <thinking>
            inThinkingBlock = true
            if (!hasLoggedThinkingFormat) {
              proxyLogger.info('ProxyServer', `Detected <thinking> tag, output format: ${format}`)
              hasLoggedThinkingFormat = true
            }
          } else if (forceFlush || textBuffer.length > 50) {
            // 娌℃湁鎵惧埌鏍囩锛屽畨鍏ㄨ緭鍑猴紙淇濈暀鍙兘鐨勯儴鍒嗘爣绛撅紝闇€瑕佽冻澶熼暱浠ユ娴?</thinking>锛?
            const safeLength = forceFlush ? textBuffer.length : Math.max(0, textBuffer.length - 15)
            if (safeLength > 0) {
              const safeText = textBuffer.substring(0, safeLength)
              collectedContent += safeText
              ensureStreamInitialized()
              const chunk = createOpenaiStreamChunk(id, model, { content: safeText })
              res.write(`data: ${JSON.stringify(chunk)}\n\n`)
              textBuffer = textBuffer.substring(safeLength)
            }
            break
          } else {
            break
          }
        } else {
          // 鍦?thinking 鍧楀唴锛屾煡鎵?</thinking> 缁撴潫鏍囩
          const thinkingEnd = textBuffer.indexOf('</thinking>')
          if (thinkingEnd !== -1) {
            // 杈撳嚭 thinking 鍐呭
            const thinkingContent = textBuffer.substring(0, thinkingEnd)
            if (thinkingContent) {
              ensureStreamInitialized()
              if (format === 'thinking') {
                const chunk = createOpenaiStreamChunk(id, model, { content: `<thinking>${thinkingContent}</thinking>` })
                res.write(`data: ${JSON.stringify(chunk)}\n\n`)
              } else if (format === 'think') {
                const chunk = createOpenaiStreamChunk(id, model, { content: `<think>${thinkingContent}</think>` })
                res.write(`data: ${JSON.stringify(chunk)}\n\n`)
              } else {
                const chunk = createOpenaiStreamChunk(id, model, { reasoning_content: thinkingContent })
                res.write(`data: ${JSON.stringify(chunk)}\n\n`)
              }
            }
            textBuffer = textBuffer.substring(thinkingEnd + 11) // 绉婚櫎 </thinking>
            inThinkingBlock = false
          } else if (forceFlush) {
            // 寮哄埗鍒锋柊锛氳緭鍑哄墿浣欏唴瀹癸紙鏈棴鍚堢殑 thinking 鍧楋級
            if (textBuffer) {
              ensureStreamInitialized()
              if (format === 'thinking') {
                const chunk = createOpenaiStreamChunk(id, model, { content: `<thinking>${textBuffer}</thinking>` })
                res.write(`data: ${JSON.stringify(chunk)}\n\n`)
              } else if (format === 'think') {
                const chunk = createOpenaiStreamChunk(id, model, { content: `<think>${textBuffer}</think>` })
                res.write(`data: ${JSON.stringify(chunk)}\n\n`)
              } else {
                const chunk = createOpenaiStreamChunk(id, model, { reasoning_content: textBuffer })
                res.write(`data: ${JSON.stringify(chunk)}\n\n`)
              }
              textBuffer = ''
            }
            break
          } else {
            break
          }
        }
      }
    }

    return new Promise((resolve) => {
      callKiroApiStream(
        account as any,
        kiroPayload,
        (text, toolUse, isThinking) => {
          if (text) {
            if (isThinking) {
              // reasoningContentEvent 鐨勬€濊€冨唴瀹?
              const format = this.config.thinkingOutputFormat || 'reasoning_content'
              if (!hasLoggedThinkingFormat) {
                proxyLogger.info('ProxyServer', `Thinking output format (reasoningContentEvent): ${format}`)
                hasLoggedThinkingFormat = true
              }
              ensureStreamInitialized()
              if (format === 'thinking') {
                const chunk = createOpenaiStreamChunk(id, model, { content: `<thinking>${text}</thinking>` })
                res.write(`data: ${JSON.stringify(chunk)}\n\n`)
              } else if (format === 'think') {
                const chunk = createOpenaiStreamChunk(id, model, { content: `<think>${text}</think>` })
                res.write(`data: ${JSON.stringify(chunk)}\n\n`)
              } else {
                const chunk = createOpenaiStreamChunk(id, model, { reasoning_content: text })
                res.write(`data: ${JSON.stringify(chunk)}\n\n`)
              }
            } else {
              // 鏅€氭枃鏈紝妫€娴?<thinking> 鏍囩
              processText(text)
            }
          }
          if (toolUse) {
            ensureStreamInitialized()
            const idx = toolCallIndex++
            pendingToolCalls.set(toolUse.toolUseId, {
              index: idx,
              name: toolUse.name,
              arguments: JSON.stringify(toolUse.input)
            })
            // 鍙戦€?tool_call chunk
            const toolChunk = createOpenaiStreamChunk(id, model, {
              tool_calls: [{
                index: idx,
                id: toolUse.toolUseId,
                type: 'function',
                function: {
                  name: toolUse.name,
                  arguments: JSON.stringify(toolUse.input)
                }
              }]
            })
            res.write(`data: ${JSON.stringify(toolChunk)}\n\n`)
          }
        },
        async (usage) => {
          // 鍒锋柊缂撳啿鍖轰腑鍓╀綑鐨勫唴瀹?
          processText('', true)
          
          this.recordRequestSuccess()
          this.stats.totalTokens += usage.inputTokens + usage.outputTokens
          this.stats.inputTokens += usage.inputTokens
          this.stats.outputTokens += usage.outputTokens
          this.stats.totalCredits += usage.credits || 0
          this.events.onCreditsUpdate?.(this.stats.totalCredits)
          this.events.onTokensUpdate?.(this.stats.inputTokens, this.stats.outputTokens)
          this.accountPool.recordSuccess(account.id, usage.inputTokens + usage.outputTokens)
          this.events.onResponse?.({ path: '/v1/chat/completions', model, status: 200, tokens: usage.inputTokens + usage.outputTokens, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, credits: usage.credits })
          this.recordRequest({ path: '/v1/chat/completions', model, accountId: account.id, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, credits: usage.credits, responseTime: Date.now() - startTime, success: true })
          // 璁板綍 API Key 鐢ㄩ噺
          if (matchedApiKey) {
            this.recordApiKeyUsage(matchedApiKey.id, usage.credits || 0, usage.inputTokens, usage.outputTokens, model, '/v1/chat/completions')
          }

          // 妫€鏌ユ槸鍚﹂渶瑕佽嚜鍔ㄧ户缁?
          const maxRounds = this.config.autoContinueRounds || 0
          const hasToolCalls = pendingToolCalls.size > 0
          const shouldContinue = hasToolCalls && maxRounds > 0 && currentRound < maxRounds

          if (shouldContinue) {
            console.log(`[ProxyServer] Auto-continue round ${currentRound + 1}/${maxRounds}`)
            
            // 鏋勯€犵户缁姹傦細娣诲姞 assistant 鍝嶅簲銆佸伐鍏风粨鏋滃拰缁х画娑堟伅
            const toolResults = Array.from(pendingToolCalls.entries()).map(([toolId]) => ({
              toolUseId: toolId,
              content: [{ text: 'Done. Continue with the next step.' }]
            }))

            // 鑾峰彇鍘熷娑堟伅鐨?modelId 鍜?origin
            const originalMsg = kiroPayload.conversationState?.currentMessage?.userInputMessage
            const modelId = originalMsg?.modelId || 'anthropic.claude-sonnet-4-20250514-v1:0'
            const origin = originalMsg?.origin || 'CHAT'

            // 鏋勯€犳柊鐨?Kiro payload
            const continuePayload = {
              ...kiroPayload,
              conversationState: {
                ...kiroPayload.conversationState,
                currentMessage: {
                  userInputMessage: {
                    content: 'Continue.',
                    userInputMessageContext: {},
                    modelId,
                    origin
                  }
                },
                history: [
                  ...(kiroPayload.conversationState?.history || []),
                  // 娣诲姞 assistant 鍝嶅簲
                  {
                    assistantResponseMessage: {
                      content: collectedContent || 'I will continue with the task.',
                      ...(pendingToolCalls.size > 0 ? {
                        toolUses: Array.from(pendingToolCalls.entries()).map(([toolId, toolData]) => ({
                          toolUseId: toolId,
                          name: toolData.name,
                          input: JSON.parse(toolData.arguments)
                        }))
                      } : {})
                    }
                  },
                  // 娣诲姞宸ュ叿缁撴灉锛堜綔涓?user 娑堟伅锛?
                  ...(toolResults.length > 0 ? [{
                    userInputMessage: {
                      content: 'Tool results provided.',
                      modelId,
                      origin,
                      userInputMessageContext: {
                        toolResults
                      }
                    }
                  }] : [])
                ]
              }
            } as typeof kiroPayload

            // 閫掑綊璋冪敤缁х画娴佸紡杈撳嚭
            try {
              await this.handleOpenAIStream(res, account, continuePayload, model, startTime, currentRound + 1, id, true, matchedApiKey, signal, leasedAccountIds)
            } catch (error) {
              console.error('[ProxyServer] Auto-continue error:', error)
            }
            resolve()
          } else {
            // 鍙戦€佺粨鏉?chunk锛堝寘鍚畬鏁?usage 淇℃伅锛?
            const finishReason = hasToolCalls ? 'tool_calls' : 'stop'
            const usageInfo: {
              prompt_tokens: number
              completion_tokens: number
              total_tokens: number
              prompt_tokens_details?: { cached_tokens?: number }
              completion_tokens_details?: { reasoning_tokens?: number }
            } = {
              prompt_tokens: usage.inputTokens,
              completion_tokens: usage.outputTokens,
              total_tokens: usage.inputTokens + usage.outputTokens
            }
            // 娣诲姞 cache tokens 璇︽儏
            if (usage.cacheReadTokens && usage.cacheReadTokens > 0) {
              usageInfo.prompt_tokens_details = { cached_tokens: usage.cacheReadTokens }
            }
            // 娣诲姞 reasoning tokens 璇︽儏
            if (usage.reasoningTokens && usage.reasoningTokens > 0) {
              usageInfo.completion_tokens_details = { reasoning_tokens: usage.reasoningTokens }
            }
            const finalChunk = createOpenaiStreamChunk(id, model, {}, finishReason, usageInfo)
            ensureStreamInitialized()
            res.write(`data: ${JSON.stringify(finalChunk)}\n\n`)
            res.write('data: [DONE]\n\n')
            res.end()
            resolve()
          }
        },
        (error) => {
          console.error('[ProxyServer] Stream error:', error)
          void (async () => {
            const errMsg = error.message || ''
            const abortedError = this.getAbortedRequestError(signal, error)

            if (abortedError) {
              this.recordRequestFailed()
              const abortStatus = abortedError.statusCode || 499
              if (abortStatus !== 499 && !res.destroyed && !res.writableEnded) {
                ensureStreamInitialized()
                res.write(`data: ${JSON.stringify({ error: { message: abortedError.message } })}\n\n`)
                res.end()
              }
              this.events.onResponse?.({ path: '/v1/chat/completions', model, status: abortStatus, error: abortedError.message })
              this.recordRequest({ path: '/v1/chat/completions', model, accountId: account.id, responseTime: Date.now() - startTime, success: false, error: abortedError.message })
              resolve()
              return
            }

            if (!streamInitialized) {
              let retryAccount: ProxyAccount | null = null

              if (this.isAuthLikeErrorMessage(errMsg)) {
                retryAccount = await this.getAuthFallbackAccount(account, errMsg, leasedAccountIds)
              } else if (this.isQuotaLikeErrorMessage(errMsg)) {
                retryAccount = this.getQuotaFallbackAccount(account, errMsg)
              }

              if (retryAccount) {
                await this.handleOpenAIStream(
                  res,
                  retryAccount,
                  {
                    ...kiroPayload,
                    profileArn: retryAccount.profileArn
                  },
                  model,
                  startTime,
                  currentRound,
                  streamId,
                  false,
                  matchedApiKey,
                  signal,
                  leasedAccountIds
                )
                resolve()
                return
              }
            }

            ensureStreamInitialized()
            res.write(`data: ${JSON.stringify({ error: { message: error.message } })}\n\n`)
            res.end()

            this.recordRequestFailed()
            const isQuotaError = this.isQuotaLikeErrorMessage(error.message)
            if (!isQuotaError) {
              this.accountPool.recordError(account.id, false)
            }
            this.events.onResponse?.({ path: '/v1/chat/completions', model, status: isQuotaError ? 429 : 500, error: error.message })
            this.recordRequest({ path: '/v1/chat/completions', model, accountId: account.id, responseTime: Date.now() - startTime, success: false, error: error.message })
            resolve()
          })()
        },
        signal
      )
    })
  }

  // 澶勭悊 Claude Messages 璇锋眰
  private async handleClaudeMessages(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const path = '/v1/messages'
    const matchedApiKey = (req as unknown as { matchedApiKey?: import('./types').ApiKey }).matchedApiKey
    const leasedAccountIds = new Set<string>()
    let request: ClaudeRequest | null = null
    let account: ProxyAccount | null = null
    let startTime = Date.now()

    this.recordNewRequest()
    this.events.onRequest?.({ path, method: 'POST' })

    const releaseRequestSlot = await this.acquireRequestSlot()
    if (!releaseRequestSlot) {
      this.recordRequestFailed()
      this.sendError(res, 503, 'Server is busy, request queue is full')
      this.events.onResponse?.({ path, status: 503, error: 'Server is busy, request queue is full' })
      this.recordRequest({ path, success: false, error: 'Server is busy, request queue is full' })
      return
    }

    const { controller, cleanup } = this.createRequestAbortController(req, res)

    try {
      const body = await this.readBody(req, controller.signal)
      request = this.parseJsonBody<ClaudeRequest>(body, 'Invalid request body')

      request.model = this.applyModelMapping(request.model, matchedApiKey?.id)
      const modelThinkingEnabled = this.config.modelThinkingMode?.[request.model]
      const thinkingEnabled = modelThinkingEnabled || (req.headers['anthropic-beta'] as string || '').toLowerCase().includes('thinking')

      account = await this.getAvailableAccount(leasedAccountIds)
      if (!account) {
        this.recordRequestFailed()
        this.sendError(res, 503, 'No available accounts')
        this.events.onResponse?.({ path, model: request.model, status: 503, error: 'No available accounts' })
        this.recordRequest({ path, model: request.model, success: false, error: 'No available accounts' })
        return
      }

      this.events.onRequest?.({ path, method: 'POST', accountId: account.id })
      startTime = Date.now()

      let kiroPayload = claudeToKiro(request, account.profileArn)

      if (thinkingEnabled) {
        const thinkingPrompt = `<thinking_mode>enabled</thinking_mode>\n<max_thinking_length>200000</max_thinking_length>\n\n`
        const currentMessage = kiroPayload.conversationState?.currentMessage?.userInputMessage
        if (currentMessage && typeof currentMessage.content === 'string') {
          currentMessage.content = thinkingPrompt + currentMessage.content
        }
        proxyLogger.info('ProxyServer', 'Thinking mode enabled for Claude request')
      }

      if (this.config.logRequests) {
        const userInput = kiroPayload.conversationState.currentMessage?.userInputMessage
        const contentLength = typeof userInput?.content === 'string' ? userInput.content.length : 0
        const toolsCount = userInput?.userInputMessageContext?.tools?.length || 0
        const historyLength = kiroPayload.conversationState.history?.length || 0
        const hasImages = (userInput?.images?.length || 0) > 0

        proxyLogger.info('ProxyServer', `Claude API: ${request.model}`, {
          model: request.model,
          stream: request.stream,
          contentLength,
          toolsCount,
          historyLength,
          hasImages,
          accountId: account.id.substring(0, 8) + '...'
        })
      }

      if (request.stream) {
        await this.handleClaudeStream(res, account, kiroPayload, request.model, startTime, 0, undefined, false, 0, matchedApiKey, controller.signal, leasedAccountIds)
      } else {
        const { result, account: usedAccount } = await this.callWithRetry(
          account,
          async (acc) => callKiroApi(acc, claudeToKiro(request!, acc.profileArn), controller.signal),
          path
        )
        const response = kiroToClaudeResponse(result.content, result.toolUses, result.usage, request.model)

        this.recordRequestSuccess()
        this.stats.totalTokens += result.usage.inputTokens + result.usage.outputTokens
        this.stats.inputTokens += result.usage.inputTokens
        this.stats.outputTokens += result.usage.outputTokens
        this.accountPool.recordSuccess(usedAccount.id, result.usage.inputTokens + result.usage.outputTokens)

        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(response))
        this.events.onResponse?.({ path, model: request.model, status: 200, tokens: result.usage.inputTokens + result.usage.outputTokens, inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens })
        this.recordRequest({ path, model: request.model, accountId: usedAccount.id, inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens, responseTime: Date.now() - startTime, success: true })
      }
    } catch (error) {
      this.handleApiError(res, account || { id: 'unknown' }, error as Error, path, request?.model, startTime)
    } finally {
      cleanup()
      this.releaseLeasedAccounts(leasedAccountIds)
      releaseRequestSlot()
    }
  }

  // 澶勭悊 Claude 娴佸紡鍝嶅簲
  private async handleClaudeStream(
    res: http.ServerResponse,
    account: ProxyAccount,
    kiroPayload: ReturnType<typeof claudeToKiro>,
    model: string,
    startTime: number,
    currentRound: number = 0,
    msgId?: string,
    headersSent: boolean = false,
    contentBlockIndex: number = 0,
    matchedApiKey?: import('./types').ApiKey,
    signal?: AbortSignal,
    leasedAccountIds: Set<string> = new Set()
  ): Promise<void> {
    const id = msgId || `msg_${uuidv4()}`
    let currentBlockIndex = contentBlockIndex
    let hasStartedTextBlock = false
    let collectedContent = ''
    const pendingToolCalls: Map<string, { name: string; input: Record<string, unknown> }> = new Map()
    let hasLoggedThinkingFormat = false
    let streamInitialized = headersSent
    // 鐢ㄤ簬妫€娴嬫櫘閫氬搷搴斾腑鐨?<thinking> 鏍囩
    let textBuffer = ''
    let inThinkingBlock = false

    // 浼扮畻杈撳叆 tokens锛堝熀浜?payload 澶у皬锛?
    const estimatedInputTokens = Math.max(1, Math.round(JSON.stringify(kiroPayload).length / 3))

    // 澶勭悊鏂囨湰杈撳嚭锛屾娴嬪苟杞崲 <thinking> 鏍囩
    const processClaudeText = (text: string, forceFlush = false) => {
      const format = this.config.thinkingOutputFormat || 'reasoning_content'
      textBuffer += text
      
      while (true) {
        if (!inThinkingBlock) {
          // 鏌ユ壘 <thinking> 寮€濮嬫爣绛?
          const thinkingStart = textBuffer.indexOf('<thinking>')
          if (thinkingStart !== -1) {
            // 杈撳嚭 thinking 鏍囩涔嬪墠鐨勫唴瀹?
            if (thinkingStart > 0) {
              const beforeThinking = textBuffer.substring(0, thinkingStart)
              collectedContent += beforeThinking
              if (!hasStartedTextBlock) {
                ensureStreamInitialized()
                const blockStart = createClaudeStreamEvent('content_block_start', {
                  index: currentBlockIndex,
                  content_block: { type: 'text', text: '' }
                })
                res.write(`event: content_block_start\ndata: ${JSON.stringify(blockStart)}\n\n`)
                hasStartedTextBlock = true
              }
              const delta = createClaudeStreamEvent('content_block_delta', {
                index: currentBlockIndex,
                delta: { type: 'text_delta', text: beforeThinking }
              })
              res.write(`event: content_block_delta\ndata: ${JSON.stringify(delta)}\n\n`)
            }
            textBuffer = textBuffer.substring(thinkingStart + 10) // 绉婚櫎 <thinking>
            inThinkingBlock = true
            if (!hasLoggedThinkingFormat) {
              proxyLogger.info('ProxyServer', `[Claude] Detected <thinking> tag, output format: ${format}`)
              hasLoggedThinkingFormat = true
            }
          } else if (forceFlush || textBuffer.length > 50) {
            // 娌℃湁鎵惧埌鏍囩锛屽畨鍏ㄨ緭鍑?
            const safeLength = forceFlush ? textBuffer.length : Math.max(0, textBuffer.length - 15)
            if (safeLength > 0) {
              const safeText = textBuffer.substring(0, safeLength)
              collectedContent += safeText
              if (!hasStartedTextBlock) {
                ensureStreamInitialized()
                const blockStart = createClaudeStreamEvent('content_block_start', {
                  index: currentBlockIndex,
                  content_block: { type: 'text', text: '' }
                })
                res.write(`event: content_block_start\ndata: ${JSON.stringify(blockStart)}\n\n`)
                hasStartedTextBlock = true
              }
              const delta = createClaudeStreamEvent('content_block_delta', {
                index: currentBlockIndex,
                delta: { type: 'text_delta', text: safeText }
              })
              res.write(`event: content_block_delta\ndata: ${JSON.stringify(delta)}\n\n`)
              textBuffer = textBuffer.substring(safeLength)
            }
            break
          } else {
            break
          }
        } else {
          // 鍦?thinking 鍧楀唴锛屾煡鎵?</thinking> 缁撴潫鏍囩
          const thinkingEnd = textBuffer.indexOf('</thinking>')
          if (thinkingEnd !== -1) {
            // 杈撳嚭 thinking 鍐呭
            const thinkingContent = textBuffer.substring(0, thinkingEnd)
            if (thinkingContent) {
              if (!hasStartedTextBlock) {
                ensureStreamInitialized()
                const blockStart = createClaudeStreamEvent('content_block_start', {
                  index: currentBlockIndex,
                  content_block: { type: 'text', text: '' }
                })
                res.write(`event: content_block_start\ndata: ${JSON.stringify(blockStart)}\n\n`)
                hasStartedTextBlock = true
              }
              if (format === 'thinking') {
                const delta = createClaudeStreamEvent('content_block_delta', {
                  index: currentBlockIndex,
                  delta: { type: 'text_delta', text: `<thinking>${thinkingContent}</thinking>` }
                })
                res.write(`event: content_block_delta\ndata: ${JSON.stringify(delta)}\n\n`)
              } else if (format === 'think') {
                const delta = createClaudeStreamEvent('content_block_delta', {
                  index: currentBlockIndex,
                  delta: { type: 'text_delta', text: `<think>${thinkingContent}</think>` }
                })
                res.write(`event: content_block_delta\ndata: ${JSON.stringify(delta)}\n\n`)
              }
              // reasoning_content 鏍煎紡锛氳繃婊ゆ帀 thinking 鍐呭锛堝ぇ澶氭暟瀹㈡埛绔笉鏀寔姝ゅ瓧娈碉級
            }
            textBuffer = textBuffer.substring(thinkingEnd + 11) // 绉婚櫎 </thinking>
            inThinkingBlock = false
          } else if (forceFlush && textBuffer) {
            // 寮哄埗鍒锋柊锛氳緭鍑哄墿浣欏唴瀹?
            if (format === 'thinking' || format === 'think') {
              if (!hasStartedTextBlock) {
                ensureStreamInitialized()
                const blockStart = createClaudeStreamEvent('content_block_start', {
                  index: currentBlockIndex,
                  content_block: { type: 'text', text: '' }
                })
                res.write(`event: content_block_start\ndata: ${JSON.stringify(blockStart)}\n\n`)
                hasStartedTextBlock = true
              }
              const tag = format === 'thinking' ? 'thinking' : 'think'
              const delta = createClaudeStreamEvent('content_block_delta', {
                index: currentBlockIndex,
                delta: { type: 'text_delta', text: `<${tag}>${textBuffer}</${tag}>` }
              })
              res.write(`event: content_block_delta\ndata: ${JSON.stringify(delta)}\n\n`)
            }
            // reasoning_content 鏍煎紡锛氳繃婊ゆ帀 thinking 鍐呭
            textBuffer = ''
            break
          } else {
            break
          }
        }
      }
    }
    
    // 鍙戦€?message_start锛堜粎棣栬疆锛?
    const ensureStreamInitialized = () => {
      if (streamInitialized) {
        return
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      })

      if (currentRound === 0) {
        const messageStart = createClaudeStreamEvent('message_start', {
          message: {
            id,
            type: 'message',
            role: 'assistant',
            content: [],
            model,
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: estimatedInputTokens, output_tokens: 0 }
          }
        })
        res.write(`event: message_start\ndata: ${JSON.stringify(messageStart)}\n\n`)
      }

      streamInitialized = true
    }

    return new Promise((resolve) => {
      callKiroApiStream(
        account as any,
        kiroPayload,
        (text, toolUse, isThinking) => {
          if (text) {
            if (isThinking) {
              // reasoningContentEvent 鐨勬€濊€冨唴瀹?
              const format = this.config.thinkingOutputFormat || 'reasoning_content'
              if (!hasLoggedThinkingFormat) {
                proxyLogger.info('ProxyServer', `[Claude] Thinking output format (reasoningContentEvent): ${format}`)
                hasLoggedThinkingFormat = true
              }
              // reasoning_content 鏍煎紡锛氳繃婊ゆ帀鎬濊€冨唴瀹癸紙澶у鏁板鎴风涓嶆敮鎸侊級
              if (format === 'thinking' || format === 'think') {
                if (!hasStartedTextBlock) {
                  ensureStreamInitialized()
                  const blockStart = createClaudeStreamEvent('content_block_start', {
                    index: currentBlockIndex,
                    content_block: { type: 'text', text: '' }
                  })
                  res.write(`event: content_block_start\ndata: ${JSON.stringify(blockStart)}\n\n`)
                  hasStartedTextBlock = true
                }
                const tag = format === 'thinking' ? 'thinking' : 'think'
                const delta = createClaudeStreamEvent('content_block_delta', {
                  index: currentBlockIndex,
                  delta: { type: 'text_delta', text: `<${tag}>${text}</${tag}>` }
                })
                res.write(`event: content_block_delta\ndata: ${JSON.stringify(delta)}\n\n`)
              }
            } else {
              // 鏅€氭枃鏈紝妫€娴?<thinking> 鏍囩
              processClaudeText(text)
            }
          }
          if (toolUse) {
            // 缁撴潫涔嬪墠鐨勬枃鏈潡
            if (hasStartedTextBlock) {
              const blockStop = createClaudeStreamEvent('content_block_stop', { index: currentBlockIndex })
              res.write(`event: content_block_stop\ndata: ${JSON.stringify(blockStop)}\n\n`)
              currentBlockIndex++
              hasStartedTextBlock = false
            }
            // 璁板綍宸ュ叿璋冪敤
            pendingToolCalls.set(toolUse.toolUseId, { name: toolUse.name, input: toolUse.input })
            // 寮€濮嬪伐鍏峰潡
            ensureStreamInitialized()
            const toolBlockStart = createClaudeStreamEvent('content_block_start', {
              index: currentBlockIndex,
              content_block: { type: 'tool_use', id: toolUse.toolUseId, name: toolUse.name, input: {} }
            })
            res.write(`event: content_block_start\ndata: ${JSON.stringify(toolBlockStart)}\n\n`)
            // 鍙戦€佸伐鍏疯緭鍏?
            const toolDelta = createClaudeStreamEvent('content_block_delta', {
              index: currentBlockIndex,
              delta: { type: 'input_json_delta', partial_json: JSON.stringify(toolUse.input) } as any
            })
            res.write(`event: content_block_delta\ndata: ${JSON.stringify(toolDelta)}\n\n`)
            // 缁撴潫宸ュ叿鍧?
            const toolBlockStop = createClaudeStreamEvent('content_block_stop', { index: currentBlockIndex })
            res.write(`event: content_block_stop\ndata: ${JSON.stringify(toolBlockStop)}\n\n`)
            currentBlockIndex++
          }
        },
        async (usage) => {
          // 鍒锋柊缂撳啿鍖轰腑鍓╀綑鐨勫唴瀹?
          processClaudeText('', true)
          
          // 缁撴潫鏈€鍚庣殑鏂囨湰鍧?
          if (hasStartedTextBlock) {
            const blockStop = createClaudeStreamEvent('content_block_stop', { index: currentBlockIndex })
            res.write(`event: content_block_stop\ndata: ${JSON.stringify(blockStop)}\n\n`)
            currentBlockIndex++
          }

          this.recordRequestSuccess()
          this.stats.totalTokens += usage.inputTokens + usage.outputTokens
          this.stats.inputTokens += usage.inputTokens
          this.stats.outputTokens += usage.outputTokens
          this.stats.totalCredits += usage.credits || 0
          this.events.onCreditsUpdate?.(this.stats.totalCredits)
          this.events.onTokensUpdate?.(this.stats.inputTokens, this.stats.outputTokens)
          this.accountPool.recordSuccess(account.id, usage.inputTokens + usage.outputTokens)
          this.events.onResponse?.({ path: '/v1/messages', model, status: 200, tokens: usage.inputTokens + usage.outputTokens, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, credits: usage.credits })
          this.recordRequest({ path: '/v1/messages', model, accountId: account.id, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, credits: usage.credits, responseTime: Date.now() - startTime, success: true })
          // 璁板綍 API Key 鐢ㄩ噺
          if (matchedApiKey) {
            this.recordApiKeyUsage(matchedApiKey.id, usage.credits || 0, usage.inputTokens, usage.outputTokens, model, '/v1/messages')
          }

          // 妫€鏌ユ槸鍚﹂渶瑕佽嚜鍔ㄧ户缁?
          const maxRounds = this.config.autoContinueRounds || 0
          const hasToolCalls = pendingToolCalls.size > 0
          const shouldContinue = hasToolCalls && maxRounds > 0 && currentRound < maxRounds

          if (shouldContinue) {
            console.log(`[ProxyServer] Claude auto-continue round ${currentRound + 1}/${maxRounds}`)
            
            // 鏋勯€犵户缁姹?
            const toolResults = Array.from(pendingToolCalls.entries()).map(([toolId]) => ({
              toolUseId: toolId,
              content: [{ text: 'Done. Continue with the next step.' }],
              status: 'success' as const
            }))

            const originalMsg = kiroPayload.conversationState?.currentMessage?.userInputMessage
            const modelId = originalMsg?.modelId || 'anthropic.claude-sonnet-4-20250514-v1:0'
            const origin = originalMsg?.origin || 'CHAT'

            const continuePayload = {
              ...kiroPayload,
              conversationState: {
                ...kiroPayload.conversationState,
                currentMessage: {
                  userInputMessage: {
                    content: 'Continue.',
                    userInputMessageContext: {
                      toolResults
                    },
                    modelId,
                    origin
                  }
                },
                history: [
                  ...(kiroPayload.conversationState?.history || []),
                  {
                    assistantResponseMessage: {
                      content: collectedContent || 'I will continue with the task.',
                      ...(pendingToolCalls.size > 0 ? {
                        toolUses: Array.from(pendingToolCalls.entries()).map(([toolId, toolData]) => ({
                          toolUseId: toolId,
                          name: toolData.name,
                          input: toolData.input
                        }))
                      } : {})
                    }
                  }
                ]
              }
            } as typeof kiroPayload

            try {
              await this.handleClaudeStream(res, account, continuePayload, model, startTime, currentRound + 1, id, true, currentBlockIndex, matchedApiKey, signal, leasedAccountIds)
            } catch (error) {
              console.error('[ProxyServer] Claude auto-continue error:', error)
            }
            resolve()
          } else {
            // 鍙戦€?message_delta锛堝寘鍚畬鏁?usage 淇℃伅锛?
            const stopReason = hasToolCalls ? 'tool_use' : 'end_turn'
            const messageDelta = createClaudeStreamEvent('message_delta', {
              delta: { stop_reason: stopReason, stop_sequence: null } as any,
              usage: { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens }
            })
            ensureStreamInitialized()
            res.write(`event: message_delta\ndata: ${JSON.stringify(messageDelta)}\n\n`)
            // 鍙戦€?message_stop
            const messageStop = createClaudeStreamEvent('message_stop')
            res.write(`event: message_stop\ndata: ${JSON.stringify(messageStop)}\n\n`)
            res.end()
            resolve()
          }
        },
        (error) => {
          console.error('[ProxyServer] Stream error:', error)
          void (async () => {
            const errMsg = error.message || ''
            const abortedError = this.getAbortedRequestError(signal, error)

            if (abortedError) {
              this.recordRequestFailed()
              const abortStatus = abortedError.statusCode || 499
              if (abortStatus !== 499 && !res.destroyed && !res.writableEnded) {
                ensureStreamInitialized()
                const errorEvent = createClaudeStreamEvent('error', {
                  error: { type: 'api_error', message: abortedError.message }
                })
                res.write(`event: error\ndata: ${JSON.stringify(errorEvent)}\n\n`)
                res.end()
              }
              this.events.onResponse?.({ path: '/v1/messages', model, status: abortStatus, error: abortedError.message })
              this.recordRequest({ path: '/v1/messages', model, accountId: account.id, responseTime: Date.now() - startTime, success: false, error: abortedError.message })
              resolve()
              return
            }

            if (!streamInitialized) {
              let retryAccount: ProxyAccount | null = null

              if (this.isAuthLikeErrorMessage(errMsg)) {
                retryAccount = await this.getAuthFallbackAccount(account, errMsg, leasedAccountIds)
              } else if (this.isQuotaLikeErrorMessage(errMsg)) {
                retryAccount = this.getQuotaFallbackAccount(account, errMsg)
              }

              if (retryAccount) {
                await this.handleClaudeStream(
                  res,
                  retryAccount,
                  {
                    ...kiroPayload,
                    profileArn: retryAccount.profileArn
                  },
                  model,
                  startTime,
                  currentRound,
                  msgId,
                  false,
                  currentBlockIndex,
                  matchedApiKey,
                  signal,
                  leasedAccountIds
                )
                resolve()
                return
              }
            }

            ensureStreamInitialized()
            const errorEvent = createClaudeStreamEvent('error', {
              error: { type: 'api_error', message: error.message }
            })
            res.write(`event: error\ndata: ${JSON.stringify(errorEvent)}\n\n`)
            res.end()

            this.recordRequestFailed()
            const isQuotaError = this.isQuotaLikeErrorMessage(error.message)
            if (!isQuotaError) {
              this.accountPool.recordError(account.id, false)
            }
            this.events.onResponse?.({ path: '/v1/messages', model, status: isQuotaError ? 429 : 500, error: error.message })
            this.recordRequest({ path: '/v1/messages', model, accountId: account.id, responseTime: Date.now() - startTime, success: false, error: error.message })
            resolve()
          })()
        },
        signal
      )
    })
  }

  // 澶勭悊 API 閿欒
  private handleApiError(res: http.ServerResponse, account: { id: string }, error: Error, path: string, model?: string, startTime?: number): void {
    this.recordRequestFailed()
    const isQuotaError = this.isQuotaLikeErrorMessage(error.message)
    const isAuthError = this.isAuthLikeErrorMessage(error.message)
    const proxyError = error as Error & { accountId?: string; accountStateHandled?: boolean; statusCode?: number }
    const accountId = proxyError.accountId || account.id
    const isAbortError = proxyError.statusCode === 408 || proxyError.statusCode === 499 || this.isAbortLikeError(error)

    if (!proxyError.accountStateHandled && !isAbortError) {
      this.accountPool.recordError(accountId, isQuotaError)
    }

    let statusCode = proxyError.statusCode || 500
    if (isQuotaError) statusCode = 429
    if (isAuthError) statusCode = 401

    if (statusCode !== 499 && !res.destroyed) {
      this.sendError(res, statusCode, error.message)
    }
    this.events.onResponse?.({ path, status: statusCode, error: error.message })
    this.recordRequest({ path, model, accountId, responseTime: startTime ? Date.now() - startTime : 0, success: false, error: error.message })
  }

  // 璇诲彇璇锋眰浣?
  private readBody(req: http.IncomingMessage, signal?: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      let totalBytes = 0
      let settled = false
      const maxBytes = this.config.maxRequestBodyBytes || 2 * 1024 * 1024

      const cleanup = () => {
        req.off('data', onData)
        req.off('end', onEnd)
        req.off('error', onError)
        req.off('aborted', onAborted)
        signal?.removeEventListener('abort', onSignalAbort)
      }

      const finish = (handler: () => void) => {
        if (settled) {
          return
        }
        settled = true
        cleanup()
        handler()
      }

      const onSignalAbort = () => {
        finish(() => reject(this.getAbortedRequestError(signal) || this.createAbortError(499, 'Request aborted')))
      }

      const onAborted = () => {
        finish(() => reject(this.createAbortError(499, 'Client disconnected during request upload')))
      }

      const onError = (error: Error) => {
        finish(() => reject(error))
      }

      const onData = (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        totalBytes += buffer.length

        if (totalBytes > maxBytes) {
          const tooLargeError = this.createHttpError(413, `Request body too large (limit: ${maxBytes} bytes)`)
          // Drain the rest of the upload so the caller can return a clean 413 response
          // instead of resetting the socket and surfacing a generic client-side failure.
          req.resume()
          finish(() => reject(tooLargeError))
          return
        }

        chunks.push(buffer)
      }

      const onEnd = () => {
        finish(() => resolve(Buffer.concat(chunks).toString('utf8')))
      }

      if (signal?.aborted) {
        onSignalAbort()
        return
      }

      req.on('data', onData)
      req.on('end', onEnd)
      req.on('error', onError)
      req.on('aborted', onAborted)
      signal?.addEventListener('abort', onSignalAbort, { once: true })
    })
  }

  // 鍙戦€侀敊璇搷搴?
  private sendError(res: http.ServerResponse, status: number, message: string): void {
    if (res.destroyed || res.writableEnded) {
      return
    }

    if (!res.headersSent) {
      res.writeHead(status, { 'Content-Type': 'application/json' })
    }

    res.end(JSON.stringify({ error: { message, type: 'error', code: status } }))
  }

  // 璁板綍璇锋眰鍒?recentRequests
  private recordRequest(log: {
    path: string
    model?: string
    accountId?: string
    inputTokens?: number
    outputTokens?: number
    credits?: number
    responseTime?: number
    success: boolean
    error?: string
  }): void {
    this.stats.recentRequests.push({
      timestamp: Date.now(),
      path: log.path,
      model: log.model || 'unknown',
      accountId: log.accountId || 'unknown',
      inputTokens: log.inputTokens || 0,
      outputTokens: log.outputTokens || 0,
      credits: log.credits,
      responseTime: log.responseTime || 0,
      success: log.success,
      error: log.error
    })
    // 鍙繚鐣欐渶杩?100 鏉?
    if (this.stats.recentRequests.length > 100) {
      this.stats.recentRequests = this.stats.recentRequests.slice(-100)
    }
  }
}


