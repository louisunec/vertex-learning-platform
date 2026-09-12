/**
 * Minimal Sanity HTTP API client for the concept tooling
 * (`generate-concepts.mts`, `validate-concepts.mts`). Offline only: reads use
 * the write token when present, else the read token (the dataset is
 * private); writes require the write token. Every request is time-bounded.
 */

/** Bound on each Sanity request, including reading its body (`AbortSignal.timeout`, Node ≥ 17.3). */
const SANITY_TIMEOUT_MS = 30_000

export type Perspective = 'published' | 'raw'

export type SanityHttp = {
  groq<T>(query: string, params: Record<string, unknown>, perspective: Perspective): Promise<T>
  mutate(mutations: unknown[]): Promise<void>
  canWrite: boolean
}

export function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    console.error(`Missing environment variable ${name} (set it in .env.local).`)
    process.exit(1)
  }
  return value
}

export function createSanityHttp(): SanityHttp {
  const projectId = requireEnv('NEXT_PUBLIC_SANITY_PROJECT_ID')
  const dataset = requireEnv('NEXT_PUBLIC_SANITY_DATASET')
  const apiVersion = process.env.NEXT_PUBLIC_SANITY_API_VERSION || '2026-08-31'
  const writeToken = process.env.SANITY_API_WRITE_TOKEN
  const readToken = writeToken || process.env.SANITY_API_READ_TOKEN
  if (!readToken) {
    console.error('Missing SANITY_API_WRITE_TOKEN or SANITY_API_READ_TOKEN (the dataset is private).')
    process.exit(1)
  }
  const apiBase = `https://${projectId}.api.sanity.io/v${apiVersion}/data`
  const auth = (token: string | undefined): Record<string, string> => (token ? {authorization: `Bearer ${token}`} : {})

  return {
    canWrite: Boolean(writeToken),
    async groq<T>(query: string, params: Record<string, unknown>, perspective: Perspective): Promise<T> {
      const search = new URLSearchParams({query, perspective})
      for (const [name, value] of Object.entries(params)) search.set(`$${name}`, JSON.stringify(value))
      const body = (await fetchJson(`${apiBase}/query/${dataset}?${search}`, {headers: auth(readToken)})) as {result?: unknown}
      return (body.result ?? null) as T
    },
    async mutate(mutations: unknown[]): Promise<void> {
      if (!writeToken) throw new Error('SANITY_API_WRITE_TOKEN is required to write.')
      await fetchJson(`${apiBase}/mutate/${dataset}?returnIds=false`, {
        method: 'POST',
        headers: {...auth(writeToken), 'content-type': 'application/json'},
        body: JSON.stringify({mutations}),
      })
    },
  }
}

async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  const method = init?.method ?? 'GET'
  const path = new URL(url).pathname
  let response: Response
  let body: string
  try {
    response = await fetch(url, {...init, signal: AbortSignal.timeout(SANITY_TIMEOUT_MS)})
    body = await response.text()
  } catch (error) {
    if ((error as {name?: unknown})?.name !== 'TimeoutError') throw error
    const mayHaveApplied = method === 'POST' ? '; the write may still have applied, and a rerun is safe because recorded units are skipped' : ''
    throw new Error(`${method} ${path} timed out after ${SANITY_TIMEOUT_MS / 1000}s${mayHaveApplied}`)
  }
  if (!response.ok) throw new Error(`${method} ${path} → ${response.status}: ${body.slice(0, 200)}`)
  return JSON.parse(body)
}
