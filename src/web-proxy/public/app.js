const state = {
  meta: { authRequired: false },
  data: null
}

function getToken() {
  return localStorage.getItem('kiro-web-admin-token') || ''
}

async function api(path, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {})
  }
  const token = getToken()
  if (token) {
    headers['X-Admin-Token'] = token
  }

  const response = await fetch(path, { ...options, headers })
  const contentType = response.headers.get('content-type') || ''
  const data = contentType.includes('application/json') ? await response.json() : await response.text()

  if (!response.ok) {
    throw new Error(data.error || `HTTP ${response.status}`)
  }

  return data
}

function formatDate(value) {
  if (!value) return '-'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '-' : date.toLocaleString()
}

function formatUsage(usage) {
  if (!usage || !usage.limit) {
    return '-'
  }
  return `${usage.current.toFixed(2)} / ${usage.limit.toFixed(2)}`
}

function setResult(message, isError = false) {
  const node = document.querySelector('#import-result')
  node.textContent = typeof message === 'string' ? message : JSON.stringify(message, null, 2)
  node.style.background = isError ? 'rgba(180, 35, 24, 0.12)' : 'rgba(15, 118, 110, 0.08)'
}

function renderAccounts(accounts) {
  const tbody = document.querySelector('#accounts-table')
  tbody.innerHTML = ''

  if (!accounts.length) {
    tbody.innerHTML = '<tr><td colspan="8">还没有账号，先导入 CSV/TXT/JSON。</td></tr>'
    return
  }

  for (const account of accounts) {
    const row = document.createElement('tr')
    row.innerHTML = `
      <td>
        <strong>${account.email}</strong><br />
        <span>${account.nickname || '-'}</span>
      </td>
      <td>${account.provider}<br /><span>${account.region}</span></td>
      <td>
        <span class="badge ${account.status}">${account.status}</span>
        ${account.lastError ? `<div>${account.lastError}</div>` : ''}
      </td>
      <td>${account.subscription?.title || account.subscription?.type || '-'}</td>
      <td>${formatUsage(account.usage)}</td>
      <td>${account.accessTokenReady ? 'accessToken ok' : 'no accessToken'}</td>
      <td>${formatDate(account.lastCheckedAt)}</td>
      <td>
        <div class="small-actions">
          <button data-action="verify" data-id="${account.id}">校验</button>
          <button data-action="delete" data-id="${account.id}">删除</button>
        </div>
      </td>
    `
    tbody.appendChild(row)
  }
}

function applyProxyConfig(proxy) {
  document.querySelector('#proxy-running').textContent = proxy.running ? '运行中' : '未启动'
  document.querySelector('#panel-address').textContent = window.location.origin
  document.querySelector('#proxy-address').textContent = proxy.address
  document.querySelector('#proxy-host').value = proxy.config.host || '0.0.0.0'
  document.querySelector('#proxy-port').value = proxy.config.port || 5580
  document.querySelector('#proxy-api-key').value = proxy.config.apiKey || ''
  document.querySelector('#proxy-multi-account').checked = Boolean(proxy.config.enableMultiAccount)
  document.querySelector('#proxy-log-requests').checked = Boolean(proxy.config.logRequests)
}

async function refreshState() {
  try {
    state.data = await api('/api/state')
    renderAccounts(state.data.accounts)
    applyProxyConfig(state.data.proxy)
  } catch (error) {
    setResult(error.message, true)
  }
}

function readFileText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = reject
    reader.readAsText(file)
  })
}

async function init() {
  state.meta = await api('/api/meta')
  document.querySelector('#auth-panel').style.display = state.meta.authRequired ? 'block' : 'none'
  document.querySelector('#admin-token').value = getToken()

  document.querySelector('#save-token').addEventListener('click', async () => {
    localStorage.setItem('kiro-web-admin-token', document.querySelector('#admin-token').value.trim())
    setResult('口令已保存')
    await refreshState()
  })

  document.querySelector('#import-btn').addEventListener('click', async () => {
    try {
      const format = document.querySelector('#import-format').value
      let content = document.querySelector('#import-content').value
      const file = document.querySelector('#import-file').files[0]
      if (file) {
        content = await readFileText(file)
        document.querySelector('#import-content').value = content
      }

      const result = await api('/api/import', {
        method: 'POST',
        body: JSON.stringify({ content, format })
      })
      setResult(result)
      await refreshState()
    } catch (error) {
      setResult(error.message, true)
    }
  })

  document.querySelector('#verify-all-btn').addEventListener('click', async () => {
    try {
      const result = await api('/api/accounts/verify-all', { method: 'POST' })
      setResult(result)
      await refreshState()
    } catch (error) {
      setResult(error.message, true)
    }
  })

  document.querySelector('#save-config-btn').addEventListener('click', async () => {
    try {
      const config = {
        host: document.querySelector('#proxy-host').value.trim(),
        port: Number(document.querySelector('#proxy-port').value || 5580),
        apiKey: document.querySelector('#proxy-api-key').value.trim(),
        enableMultiAccount: document.querySelector('#proxy-multi-account').checked,
        logRequests: document.querySelector('#proxy-log-requests').checked
      }
      await api('/api/proxy/config', {
        method: 'POST',
        body: JSON.stringify({ config })
      })
      setResult('配置已保存')
      await refreshState()
    } catch (error) {
      setResult(error.message, true)
    }
  })

  document.querySelector('#start-proxy-btn').addEventListener('click', async () => {
    try {
      const config = {
        host: document.querySelector('#proxy-host').value.trim(),
        port: Number(document.querySelector('#proxy-port').value || 5580),
        apiKey: document.querySelector('#proxy-api-key').value.trim(),
        enableMultiAccount: document.querySelector('#proxy-multi-account').checked,
        logRequests: document.querySelector('#proxy-log-requests').checked
      }
      await api('/api/proxy/start', {
        method: 'POST',
        body: JSON.stringify({ config })
      })
      setResult('反代已启动')
      await refreshState()
    } catch (error) {
      setResult(error.message, true)
    }
  })

  document.querySelector('#stop-proxy-btn').addEventListener('click', async () => {
    try {
      await api('/api/proxy/stop', { method: 'POST' })
      setResult('反代已停止')
      await refreshState()
    } catch (error) {
      setResult(error.message, true)
    }
  })

  document.querySelector('#accounts-table').addEventListener('click', async (event) => {
    const target = event.target
    if (!(target instanceof HTMLButtonElement)) {
      return
    }

    const id = target.dataset.id
    const action = target.dataset.action
    if (!id || !action) {
      return
    }

    try {
      if (action === 'verify') {
        await api(`/api/accounts/${id}/verify`, { method: 'POST' })
        setResult('账号校验成功')
      } else if (action === 'delete') {
        await api(`/api/accounts/${id}`, { method: 'DELETE' })
        setResult('账号已删除')
      }
      await refreshState()
    } catch (error) {
      setResult(error.message, true)
    }
  })

  await refreshState()
}

init().catch((error) => setResult(error.message, true))
