import {
  buildVideoDocument,
  chunkCaptionEvents,
  parseDescriptionChapters,
  parseJson3Captions,
  type Chapter,
  type TranscriptChunk,
  type VideoDocument,
} from '../lib/video/ingest.ts'
import {parseVideoUrl, type ParsedVideo} from '../lib/video/provider.ts'

/**
 * Offline video ingestion (VIDEO_PIPELINE.md). Never runs in the request path.
 *
 *   npm run ingest:videos                        # every lesson video in the dataset
 *   npm run ingest:videos -- <url…>              # specific video URLs
 *   npm run ingest:videos -- --dry-run --limit 2 # build + validate, write nothing
 *   npm run ingest:videos -- --overwrite-chapters
 *
 * Writes one `video` document per unique video id via `createOrReplace` on the
 * deterministic id `video-<videoId>`, so reruns update in place. Chapters are
 * Studio-editable: existing chapters are preserved unless the existing document
 * has none or `--overwrite-chapters` is passed.
 *
 * YouTube is the only provider with ingestion support so far (captions and
 * chapters come from the public Innertube player endpoint — no credentials).
 * Vimeo/Bunny URLs are reported as unsupported and skipped.
 */

type Outcome = {
  videoId: string
  status: 'ingested' | 'would-ingest' | 'skipped' | 'failed'
  detail: string
}

type IngestedVideo = {
  title: string | null
  durationSeconds: number | null
  chapters: Chapter[]
  transcriptChunks: TranscriptChunk[]
}

const DELAY_MS = 300

const {urls, dryRun, limit, overwriteChapters} = parseArgs(process.argv.slice(2))

const projectId = requireEnv('NEXT_PUBLIC_SANITY_PROJECT_ID')
const dataset = requireEnv('NEXT_PUBLIC_SANITY_DATASET')
const apiVersion = process.env.NEXT_PUBLIC_SANITY_API_VERSION || '2026-08-31'
const token = process.env.SANITY_API_WRITE_TOKEN
if (!dryRun && !token) {
  console.error('Missing SANITY_API_WRITE_TOKEN (required to write; use --dry-run to build without writing).')
  process.exit(1)
}

const apiBase = `https://${projectId}.api.sanity.io/v${apiVersion}/data`

const outcomes: Outcome[] = []
const targets = dedupe(urls.length > 0 ? urls : await fetchLessonVideoUrls())
const bounded = limit ? targets.slice(0, limit) : targets
console.log(`${bounded.length} unique video(s) to ingest${dryRun ? ' (dry run)' : ''}\n`)

for (const [index, target] of bounded.entries()) {
  if (index > 0) await sleep(DELAY_MS)
  outcomes.push(await ingestOne(target))
}

report(outcomes)
process.exit(outcomes.some((outcome) => outcome.status === 'failed') ? 1 : 0)

async function ingestOne(parsed: ParsedVideo): Promise<Outcome> {
  const {videoId} = parsed
  try {
    if (parsed.provider !== 'youtube') {
      return {videoId, status: 'skipped', detail: `ingestion not supported for provider "${parsed.provider}" yet`}
    }
    const ingested = await ingestYouTube(parsed.providerVideoId)

    const existingChapters = await fetchExistingChapters(parsed.documentId)
    const useIngested = ingested.chapters.length > 0 && (existingChapters.length === 0 || overwriteChapters)
    const chapters = useIngested ? ingested.chapters : existingChapters
    if (chapters.length === 0 && ingested.transcriptChunks.length === 0) {
      return {videoId, status: 'skipped', detail: 'no captions and no chapters — nothing usable to index'}
    }

    const doc = buildVideoDocument({
      parsed,
      title: ingested.title,
      durationSeconds: ingested.durationSeconds,
      chapters,
      transcriptChunks: ingested.transcriptChunks,
      ingestedAt: new Date(),
    })
    const detail =
      `${doc.chapters?.length ?? 0} chapters` +
      `${useIngested || chapters.length === 0 ? '' : ' (kept existing)'}, ` +
      `${doc.transcriptChunks?.length ?? 0} chunks`
    if (dryRun) return {videoId, status: 'would-ingest', detail}
    await writeDocument(doc)
    return {videoId, status: 'ingested', detail}
  } catch (error) {
    return {videoId, status: 'failed', detail: error instanceof Error ? error.message : String(error)}
  }
}

/**
 * Captions/chapters/metadata from the public Innertube player endpoint.
 * The ANDROID client is used because caption `baseUrl`s issued to the plain
 * web client return empty bodies for anonymous requests.
 */
async function ingestYouTube(providerVideoId: string): Promise<IngestedVideo> {
  const player = (await fetchJson('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': 'com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip',
    },
    body: JSON.stringify({
      context: {client: {clientName: 'ANDROID', clientVersion: '20.10.38', androidSdkVersion: 30, hl: 'en'}},
      videoId: providerVideoId,
    }),
  })) as {
    playabilityStatus?: {status?: string; reason?: string}
    videoDetails?: {title?: string; lengthSeconds?: string; shortDescription?: string}
    captions?: {playerCaptionsTracklistRenderer?: {captionTracks?: CaptionTrack[]}}
  }

  const status = player.playabilityStatus?.status
  if (status !== 'OK') {
    throw new Error(`video not playable (${status ?? 'unknown'}${player.playabilityStatus?.reason ? `: ${player.playabilityStatus.reason}` : ''})`)
  }

  const details = player.videoDetails
  const durationSeconds = details?.lengthSeconds ? Number(details.lengthSeconds) : null
  const chapters = parseDescriptionChapters(details?.shortDescription, durationSeconds)
  const transcriptChunks = await fetchYouTubeTranscriptChunks(
    player.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [],
  )
  return {title: details?.title ?? null, durationSeconds, chapters, transcriptChunks}
}

type CaptionTrack = {baseUrl?: string; languageCode?: string; kind?: string}

/** Prefers a manual English track over auto-generated (ASR), then falls back in that order. */
async function fetchYouTubeTranscriptChunks(tracks: CaptionTrack[]): Promise<TranscriptChunk[]> {
  const usable = tracks.filter((track) => track.baseUrl)
  const english = (track: CaptionTrack) => track.languageCode?.startsWith('en') ?? false
  const track =
    usable.find((t) => english(t) && t.kind !== 'asr') ??
    usable.find((t) => t.kind !== 'asr') ??
    usable.find(english) ??
    usable[0]
  if (!track?.baseUrl) return []
  const url = new URL(track.baseUrl)
  url.searchParams.set('fmt', 'json3')
  const raw = await fetchJson(url.toString(), {
    headers: {'user-agent': 'com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip'},
  })
  return chunkCaptionEvents(parseJson3Captions(raw))
}

async function fetchLessonVideoUrls(): Promise<string[]> {
  const query = '*[_type == "lesson" && defined(videoUrl)].videoUrl'
  const result = (await fetchJson(`${apiBase}/query/${dataset}?query=${encodeURIComponent(query)}`, {
    headers: authHeaders(),
  })) as {result?: unknown}
  return Array.isArray(result.result) ? result.result.filter((url): url is string => typeof url === 'string') : []
}

async function fetchExistingChapters(documentId: string): Promise<Chapter[]> {
  const query = '*[_id == $id][0].chapters[]{startSeconds, label}'
  const params = `%24id=${encodeURIComponent(JSON.stringify(documentId))}`
  const result = (await fetchJson(`${apiBase}/query/${dataset}?query=${encodeURIComponent(query)}&${params}`, {
    headers: authHeaders(),
  })) as {result?: unknown}
  if (!Array.isArray(result.result)) return []
  return result.result.filter(
    (chapter): chapter is Chapter =>
      typeof chapter === 'object' &&
      chapter !== null &&
      Number.isInteger((chapter as Chapter).startSeconds) &&
      (chapter as Chapter).startSeconds >= 0 &&
      typeof (chapter as Chapter).label === 'string' &&
      (chapter as Chapter).label.length > 0,
  )
}

async function writeDocument(doc: VideoDocument): Promise<void> {
  await fetchJson(`${apiBase}/mutate/${dataset}`, {
    method: 'POST',
    headers: {...authHeaders(), 'content-type': 'application/json'},
    body: JSON.stringify({mutations: [{createOrReplace: doc}]}),
  })
}

function authHeaders(): Record<string, string> {
  return token ? {authorization: `Bearer ${token}`} : {}
}

async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, init)
  const body = await response.text()
  if (!response.ok) throw new Error(`${init?.method ?? 'GET'} ${new URL(url).pathname} → ${response.status}: ${body.slice(0, 200)}`)
  if (!body) throw new Error(`${new URL(url).pathname} returned an empty body`)
  try {
    return JSON.parse(body)
  } catch {
    throw new Error(`${new URL(url).pathname} returned non-JSON (${body.slice(0, 80)}…)`)
  }
}

function dedupe(rawUrls: string[]): ParsedVideo[] {
  const byId = new Map<string, ParsedVideo>()
  for (const raw of rawUrls) {
    const parsed = parseVideoUrl(raw)
    if (!parsed) {
      outcomes.push({videoId: raw, status: 'failed', detail: 'unsupported or malformed video URL'})
      continue
    }
    if (!byId.has(parsed.videoId)) byId.set(parsed.videoId, parsed)
  }
  return [...byId.values()]
}

function parseArgs(argv: string[]): {urls: string[]; dryRun: boolean; limit: number | null; overwriteChapters: boolean} {
  const urls: string[] = []
  let dryRun = false
  let limit: number | null = null
  let overwriteChapters = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--dry-run') dryRun = true
    else if (arg === '--overwrite-chapters') overwriteChapters = true
    else if (arg === '--limit') {
      const value = Number(argv[++i])
      if (!Number.isInteger(value) || value < 1) {
        console.error('--limit expects a positive integer')
        process.exit(1)
      }
      limit = value
    } else if (arg.startsWith('--')) {
      console.error(`Unknown flag ${arg}. Usage: ingest-videos [--dry-run] [--limit N] [--overwrite-chapters] [url…]`)
      process.exit(1)
    } else urls.push(arg)
  }
  return {urls, dryRun, limit, overwriteChapters}
}

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    console.error(`Missing environment variable ${name} (set it in .env.local).`)
    process.exit(1)
  }
  return value
}

function report(all: Outcome[]): void {
  console.log('')
  for (const outcome of all) {
    console.log(`${outcome.status.padEnd(13)} ${outcome.videoId}  ${outcome.detail}`)
  }
  const count = (status: Outcome['status']) => all.filter((outcome) => outcome.status === status).length
  console.log(
    `\n${count('ingested') + count('would-ingest')} ingested, ${count('skipped')} skipped, ${count('failed')} failed`,
  )
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
