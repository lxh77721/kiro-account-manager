import { performance } from 'node:perf_hooks'

const args = new Map()
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index], process.argv[index + 1])
}

const target = args.get('--url')
const concurrency = Number(args.get('--concurrency') || '1')
const totalRequests = Number(args.get('--requests') || '1')
const timeoutMs = Number(args.get('--timeout') || '45000')
const payloadSize = Number(args.get('--payloadSize') || '0')

if (!target) {
  throw new Error('Missing --url')
}

const basePrompt =
  'Reply with exactly OK. Keep the response as short as possible. This is a load test request.'
const paddedPrompt =
  payloadSize > 0 ? `${basePrompt}\n${'x'.repeat(Math.max(0, payloadSize - basePrompt.length))}` : basePrompt

const requestBody = {
  model: 'claude-haiku-4-5-20251001',
  max_tokens: 64,
  messages: [{ role: 'user', content: paddedPrompt }]
}

const results = new Array(totalRequests)
let cursor = 0

function percentile(values, ratio) {
  if (!values.length) {
    return 0
  }
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))
  return sorted[index]
}

async function runOne(index) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const startedAt = performance.now()

  try {
    const response = await fetch(target, {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal
    })
    const body = await response.text()
    const elapsedMs = performance.now() - startedAt
    return {
      index,
      ok: response.ok,
      status: response.status,
      elapsedMs,
      body: body.slice(0, 240)
    }
  } catch (error) {
    return {
      index,
      ok: false,
      status: 0,
      elapsedMs: performance.now() - startedAt,
      error: error instanceof Error ? error.message : String(error)
    }
  } finally {
    clearTimeout(timer)
  }
}

async function worker() {
  while (true) {
    const index = cursor++
    if (index >= totalRequests) {
      return
    }
    results[index] = await runOne(index)
  }
}

const startedAt = performance.now()
await Promise.all(Array.from({ length: Math.max(1, concurrency) }, () => worker()))
const elapsedMs = performance.now() - startedAt

const success = results.filter((item) => item?.ok).length
const failures = results.length - success
const latencyValues = results.map((item) => item?.elapsedMs || 0).filter((value) => value > 0)
const statusBreakdown = Object.fromEntries(
  Object.entries(
    results.reduce((acc, item) => {
      const key = String(item?.status || 'error')
      acc[key] = (acc[key] || 0) + 1
      return acc
    }, {})
  ).sort((a, b) => Number(a[0]) - Number(b[0]))
)

const failureSamples = results.filter((item) => !item?.ok).slice(0, 5)

process.stdout.write(
  JSON.stringify(
    {
      target,
      concurrency,
      totalRequests,
      timeoutMs,
      elapsedMs,
      throughputRps: elapsedMs > 0 ? (totalRequests * 1000) / elapsedMs : 0,
      success,
      failures,
      statusBreakdown,
      latencyMs: {
        min: latencyValues.length ? Math.min(...latencyValues) : 0,
        p50: percentile(latencyValues, 0.5),
        p90: percentile(latencyValues, 0.9),
        p95: percentile(latencyValues, 0.95),
        max: latencyValues.length ? Math.max(...latencyValues) : 0,
        avg: latencyValues.length ? latencyValues.reduce((sum, value) => sum + value, 0) / latencyValues.length : 0
      },
      failureSamples
    },
    null,
    2
  )
)
