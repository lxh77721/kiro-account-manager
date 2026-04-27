import { useState, useEffect, useCallback } from 'react'
import { AccountManager } from './components/accounts'
import { Sidebar, type PageType } from './components/layout'
import { HomePage, AboutPage, SettingsPage, MachineIdPage, KiroSettingsPage, ProxyPage, KProxyPage } from './components/pages'
import { UpdateDialog } from './components/UpdateDialog'
import { CloseConfirmDialog } from './components/CloseConfirmDialog'
import { useAccountsStore } from './store/accounts'
import { isWebRuntime } from './web/runtime'

function App(): React.JSX.Element {
  const [currentPage, setCurrentPage] = useState<PageType>('home')
  const [sidebarCollapsed, setSidebarCollapsed] = useState(true)
  const webMode = isWebRuntime()
  
  const loadFromStorage = useAccountsStore((state) => state.loadFromStorage)
  const startAutoTokenRefresh = useAccountsStore((state) => state.startAutoTokenRefresh)
  const stopAutoTokenRefresh = useAccountsStore((state) => state.stopAutoTokenRefresh)
  const handleBackgroundRefreshResult = useAccountsStore((state) => state.handleBackgroundRefreshResult)
  const handleBackgroundCheckResult = useAccountsStore((state) => state.handleBackgroundCheckResult)
  const accounts = useAccountsStore((state) => state.accounts)
  const activeAccountId = useAccountsStore((state) => state.activeAccountId)
  const setActiveAccount = useAccountsStore((state) => state.setActiveAccount)
  const checkAndRefreshExpiringTokens = useAccountsStore((state) => state.checkAndRefreshExpiringTokens)

  // 切换到下一个可用账户
  const switchToNextAccount = useCallback(() => {
    if (webMode) return

    const activeAccounts = Array.from(accounts.values()).filter(acc => acc.status === 'active')
    if (activeAccounts.length <= 1) return

    const currentIndex = activeAccounts.findIndex(acc => acc.id === activeAccountId)
    const nextIndex = (currentIndex + 1) % activeAccounts.length
    setActiveAccount(activeAccounts[nextIndex].id)
  }, [webMode, accounts, activeAccountId, setActiveAccount])

  // 更新托盘账户信息
  const updateTrayInfo = useCallback(() => {
    // 更新账户列表
    if (webMode) return

    const accountList = Array.from(accounts.values()).map(acc => ({
      id: acc.id,
      email: acc.email || 'Unknown',
      idp: acc.idp || 'Unknown',
      status: acc.status
    }))
    window.api.updateTrayAccountList(accountList)

    // 更新当前账户
    if (activeAccountId) {
      const activeAccount = accounts.get(activeAccountId)
      if (activeAccount) {
        window.api.updateTrayAccount({
          id: activeAccount.id,
          email: activeAccount.email || 'Unknown',
          idp: activeAccount.idp || 'Unknown',
          status: activeAccount.status,
          subscription: activeAccount.subscription?.title || undefined,
          usage: activeAccount.usage ? {
            usedCredits: activeAccount.usage.current || 0,
            totalCredits: activeAccount.usage.limit || 0,
            totalRequests: 0,
            successRequests: 0,
            failedRequests: 0
          } : undefined
        })
      } else {
        window.api.updateTrayAccount(null)
      }
    } else {
      window.api.updateTrayAccount(null)
    }
  }, [webMode, accounts, activeAccountId])
  
  // 应用启动时加载数据并启动自动刷新
  useEffect(() => {
    let cancelled = false
    let refreshTimer: ReturnType<typeof setTimeout> | null = null

    loadFromStorage().then(() => {
      if (cancelled) return

      if (webMode) {
        refreshTimer = setTimeout(() => {
          if (!cancelled) {
            startAutoTokenRefresh()
          }
        }, 1500)
        return
      }

      startAutoTokenRefresh()
    })
    
    return () => {
      cancelled = true
      if (refreshTimer) {
        clearTimeout(refreshTimer)
      }
      stopAutoTokenRefresh()
    }
  }, [webMode, loadFromStorage, startAutoTokenRefresh, stopAutoTokenRefresh])

  // 账户变化时更新托盘信息
  useEffect(() => {
    if (webMode) return

    updateTrayInfo()
  }, [webMode, updateTrayInfo])

  // 监听托盘刷新账户事件
  useEffect(() => {
    if (webMode) return

    const unsubscribe = window.api.onTrayRefreshAccount(() => {
      checkAndRefreshExpiringTokens()
      updateTrayInfo()
    })
    return () => {
      unsubscribe()
    }
  }, [webMode, checkAndRefreshExpiringTokens, updateTrayInfo])

  // 监听托盘切换账户事件
  useEffect(() => {
    if (webMode) return

    const unsubscribe = window.api.onTraySwitchAccount(() => {
      switchToNextAccount()
    })
    return () => {
      unsubscribe()
    }
  }, [webMode, switchToNextAccount])

  // 监听后台刷新结果
  useEffect(() => {
    const unsubscribe = window.api.onBackgroundRefreshResult((data) => {
      handleBackgroundRefreshResult(data)
    })
    return () => {
      unsubscribe()
    }
  }, [handleBackgroundRefreshResult])

  // 监听后台检查结果
  useEffect(() => {
    const unsubscribe = window.api.onBackgroundCheckResult((data) => {
      handleBackgroundCheckResult(data)
    })
    return () => {
      unsubscribe()
    }
  }, [handleBackgroundCheckResult])

  const renderPage = () => {
    if (webMode && ['machineId', 'kiroSettings', 'kproxy'].includes(currentPage)) {
      return <HomePage />
    }

    switch (currentPage) {
      case 'home':
        return <HomePage />
      case 'accounts':
        return <AccountManager />
      case 'machineId':
        return <MachineIdPage />
      case 'kiroSettings':
        return <KiroSettingsPage />
      case 'proxy':
        return <ProxyPage />
      case 'kproxy':
        return <KProxyPage />
      case 'settings':
        return <SettingsPage />
      case 'about':
        return <AboutPage />
      default:
        return <HomePage />
    }
  }

  return (
    <div className="h-screen bg-background flex">
      <Sidebar
        currentPage={currentPage}
        onPageChange={setCurrentPage}
        collapsed={sidebarCollapsed}
        onToggleCollapse={() => setSidebarCollapsed(!sidebarCollapsed)}
      />
      <main className="flex-1 overflow-auto">
        {renderPage()}
      </main>
      {!webMode && <UpdateDialog />}
      {!webMode && <CloseConfirmDialog />}
    </div>
  )
}

export default App
