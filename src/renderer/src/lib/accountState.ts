import type { Account } from '@/types/account'

export function isBannedAccount(account: Pick<Account, 'lastError'>): boolean {
  return Boolean(
    account.lastError?.includes('UnauthorizedException') ||
    account.lastError?.includes('AccountSuspendedException') ||
    account.lastError?.includes('账户已封禁') ||
    account.lastError?.includes('HTTP 403') ||
    account.lastError?.includes('HTTP 423')
  )
}

export function isRateLimitedAccount(
  account: Pick<Account, 'proxyState'>,
  _now: number = Date.now()
): boolean {
  return Boolean(
    account.proxyState?.cooldownReason === 'quota'
  )
}
