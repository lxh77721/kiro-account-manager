import fs from 'fs'
import http from 'http'
import path from 'path'
import { URL } from 'url'
import { WebProxyService } from './account-service'

const service = new WebProxyService()
const host = process.env.KIRO_WEB_HOST || '0.0.0.0'
const port = Number(process.env.KIRO_WEB_PORT || 3080)
const builtUiDir = path.resolve(process.cwd(), 'out', 'web-ui')
const fallbackPublicDir = path.resolve(process.cwd(), 'src', 'web-proxy', 'public')
const staticRoot = fs.existsSync(builtUiDir) ? builtUiDir : fallbackPublicDir

function readJson(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      if (!body) {
        resolve({})
        return
      }

      try {
        resolve(JSON.parse(body))
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

function sendJson(res: http.ServerResponse, statusCode: number, body: unknown): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

function sendText(res: http.ServerResponse, statusCode: number, body: string): void {
  res.writeHead(statusCode, { 'Content-Type': 'text/plain; charset=utf-8' })
  res.end(body)
}

function setCors(res: http.ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Token')
}

function getMimeType(filePath: string): string {
  if (filePath.endsWith('.css')) return 'text/css; charset=utf-8'
  if (filePath.endsWith('.js')) return 'application/javascript; charset=utf-8'
  if (filePath.endsWith('.html')) return 'text/html; charset=utf-8'
  if (filePath.endsWith('.svg')) return 'image/svg+xml'
  if (filePath.endsWith('.png')) return 'image/png'
  if (filePath.endsWith('.jpg') || filePath.endsWith('.jpeg')) return 'image/jpeg'
  if (filePath.endsWith('.woff2')) return 'font/woff2'
  return 'application/octet-stream'
}

function getAdminToken(req: http.IncomingMessage): string | null {
  const token = req.headers['x-admin-token']
  return Array.isArray(token) ? token[0] : token || null
}

async function handleApi(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL
): Promise<boolean> {
  if (!url.pathname.startsWith('/api/')) {
    return false
  }

  setCors(res)
  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return true
  }

  if (url.pathname === '/api/meta' && req.method === 'GET') {
    sendJson(res, 200, service.getMeta())
    return true
  }

  if (!service.isAuthorized(getAdminToken(req))) {
    sendJson(res, 401, { error: 'Unauthorized' })
    return true
  }

  try {
    if (url.pathname === '/api/renderer/call' && req.method === 'POST') {
      const body = (await readJson(req)) as { method?: string; params?: Record<string, unknown> }
      sendJson(res, 200, { result: await service.handleRendererCall(body) })
      return true
    }

    if (url.pathname === '/api/state' && req.method === 'GET') {
      sendJson(res, 200, service.getState())
      return true
    }

    if (url.pathname === '/api/import' && req.method === 'POST') {
      const body = (await readJson(req)) as { content?: string; format?: string }
      const result = await service.importContent(body.content || '', body.format)
      sendJson(res, 200, result)
      return true
    }

    if (url.pathname === '/api/accounts/verify-all' && req.method === 'POST') {
      sendJson(res, 200, await service.verifyAll())
      return true
    }

    if (url.pathname === '/api/proxy/start' && req.method === 'POST') {
      const body = (await readJson(req)) as { config?: Record<string, unknown> }
      await service.startProxy(body.config as Partial<Record<string, unknown>>)
      sendJson(res, 200, { success: true, state: service.getState() })
      return true
    }

    if (url.pathname === '/api/proxy/stop' && req.method === 'POST') {
      await service.stopProxy()
      sendJson(res, 200, { success: true, state: service.getState() })
      return true
    }

    if (url.pathname === '/api/proxy/config' && req.method === 'POST') {
      const body = (await readJson(req)) as { config?: Record<string, unknown> }
      const config = await service.updateProxyConfig(body.config as Partial<Record<string, unknown>>)
      sendJson(res, 200, { success: true, config })
      return true
    }

    const verifyMatch = url.pathname.match(/^\/api\/accounts\/([^/]+)\/verify$/)
    if (verifyMatch && req.method === 'POST') {
      const account = await service.verifyAccount(decodeURIComponent(verifyMatch[1]))
      sendJson(res, 200, { success: true, account })
      return true
    }

    const deleteMatch = url.pathname.match(/^\/api\/accounts\/([^/]+)$/)
    if (deleteMatch && req.method === 'DELETE') {
      await service.deleteAccount(decodeURIComponent(deleteMatch[1]))
      sendJson(res, 200, { success: true })
      return true
    }
  } catch (error) {
    sendJson(res, 500, {
      error: error instanceof Error ? error.message : 'Request failed'
    })
    return true
  }

  sendJson(res, 404, { error: 'Not found' })
  return true
}

function resolveStaticPath(pathname: string): string {
  const safePath = pathname === '/' ? '/index.html' : pathname
  const target = path.resolve(staticRoot, `.${safePath}`)
  if (!target.startsWith(staticRoot)) {
    return ''
  }
  return target
}

function serveFile(res: http.ServerResponse, filePath: string): void {
  res.writeHead(200, { 'Content-Type': getMimeType(filePath) })
  fs.createReadStream(filePath).pipe(res)
}

function serveStatic(res: http.ServerResponse, pathname: string): void {
  const target = resolveStaticPath(pathname)
  if (target && fs.existsSync(target) && !fs.statSync(target).isDirectory()) {
    serveFile(res, target)
    return
  }

  const hasExtension = path.basename(pathname).includes('.')
  const indexFile = path.join(staticRoot, 'index.html')
  if (!hasExtension && fs.existsSync(indexFile)) {
    serveFile(res, indexFile)
    return
  }

  sendText(res, 404, 'Not found')
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
  if (await handleApi(req, res, url)) {
    return
  }

  serveStatic(res, url.pathname)
})

server.listen(port, host, () => {
  console.log(`[web-proxy] UI listening on http://${host}:${port}`)
})
