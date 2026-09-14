import {CONTENT_SIGNAL_TYPE, type ContentSignalDocument, type Mutation} from './documents.ts'

/**
 * Where the aggregator reads and writes Sanity: `contentSignal` documents and
 * the few assessment fields regeneration needs. `createSanitySignalStore`
 * uses the Sanity HTTP API with the job's own write token
 * (`SANITY_API_SIGNALS_WRITE_TOKEN`), never the learner app's token;
 * `MemorySignalStore` applies the same mutation semantics in memory for
 * tests and dry runs.
 */

export type AssessmentSource = {
  _id: string
  familyId: string
  version: number
  lessonId: string | null
  /** The generation key of the assessment's source span (lesson, video, chunk revisions, prompt, model, config). */
  spanKey: string | null
}

export type RegenerationSummary = {status: string; candidateId: string; queuedDay: string; draftIds?: string[]; detail?: string}

export type SignalStore = {
  existingIds(windowKey: string): Promise<Set<string>>
  commit(mutations: Mutation[]): Promise<void>
  readAssessmentSources(ids: string[]): Promise<AssessmentSource[]>
  setRegeneration(signalId: string, regeneration: RegenerationSummary): Promise<void>
}

/** Sanity accepts large transactions, but smaller ones fail and retry more cheaply. */
const MUTATIONS_PER_TRANSACTION = 100
const SANITY_TIMEOUT_MS = 30_000

export function createSanitySignalStore({
  projectId,
  dataset,
  apiVersion,
  token,
  fetchImpl = fetch,
}: {
  projectId: string
  dataset: string
  apiVersion: string
  token: string
  fetchImpl?: typeof fetch
}): SignalStore {
  const base = `https://${projectId}.api.sanity.io/v${apiVersion}/data`
  const headers = {authorization: `Bearer ${token}`}

  async function request(url: string, init?: RequestInit): Promise<unknown> {
    const response = await fetchImpl(url, {...init, headers: {...headers, ...init?.headers}, signal: AbortSignal.timeout(SANITY_TIMEOUT_MS)})
    const text = await response.text()
    if (!response.ok) throw new Error(`Sanity request failed: HTTP ${response.status} ${text.slice(0, 200)}`)
    return text ? JSON.parse(text) : null
  }

  async function groq<T>(query: string, params: Record<string, unknown>, perspective: 'raw' | 'published'): Promise<T> {
    const search = new URLSearchParams({query, perspective})
    for (const [name, value] of Object.entries(params)) search.set(`$${name}`, JSON.stringify(value))
    const body = (await request(`${base}/query/${dataset}?${search}`)) as {result?: unknown}
    return (body.result ?? null) as T
  }

  async function mutate(mutations: unknown[]): Promise<void> {
    await request(`${base}/mutate/${dataset}?returnIds=false&visibility=sync`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({mutations}),
    })
  }

  return {
    async existingIds(windowKey) {
      const ids = await groq<string[] | null>(`*[_type == "${CONTENT_SIGNAL_TYPE}" && window.key == $key]._id`, {key: windowKey}, 'raw')
      return new Set(ids ?? [])
    },
    async commit(mutations) {
      // A document's createIfNotExists and its patch are adjacent, so a chunk boundary between them is harmless:
      // the patch only ever targets a document whose create committed first.
      for (let index = 0; index < mutations.length; index += MUTATIONS_PER_TRANSACTION) {
        await mutate(mutations.slice(index, index + MUTATIONS_PER_TRANSACTION))
      }
    },
    async readAssessmentSources(ids) {
      if (ids.length === 0) return []
      const rows = await groq<AssessmentSource[] | null>(
        '*[_type == "assessment" && _id in $ids]{_id, familyId, version, "lessonId": lesson._ref, "spanKey": generation.spanKey}',
        {ids},
        'published',
      )
      return rows ?? []
    },
    async setRegeneration(signalId, regeneration) {
      await mutate([{patch: {id: signalId, set: {regeneration}}}])
    },
  }
}

/** In-memory store with Sanity's createIfNotExists / patch.set / patch.unset semantics. */
export class MemorySignalStore implements SignalStore {
  documents = new Map<string, Record<string, unknown>>()
  assessments = new Map<string, AssessmentSource>()
  commits = 0

  async existingIds(windowKey: string) {
    return new Set(
      [...this.documents.values()]
        .filter((doc) => (doc.window as {key?: string} | undefined)?.key === windowKey)
        .map((doc) => String(doc._id)),
    )
  }

  async commit(mutations: Mutation[]) {
    this.commits++
    for (const mutation of mutations) {
      if ('createIfNotExists' in mutation) {
        const doc: ContentSignalDocument = mutation.createIfNotExists
        if (!this.documents.has(doc._id)) this.documents.set(doc._id, structuredClone(doc))
        continue
      }
      const doc = this.documents.get(mutation.patch.id)
      if (!doc) throw new Error(`patch of missing document ${mutation.patch.id}`)
      Object.assign(doc, structuredClone(mutation.patch.set))
      for (const field of mutation.patch.unset ?? []) delete doc[field]
    }
  }

  async readAssessmentSources(ids: string[]) {
    return ids.flatMap((id) => (this.assessments.has(id) ? [this.assessments.get(id)!] : []))
  }

  async setRegeneration(signalId: string, regeneration: RegenerationSummary) {
    const doc = this.documents.get(signalId)
    if (doc) doc.regeneration = structuredClone(regeneration)
  }
}
