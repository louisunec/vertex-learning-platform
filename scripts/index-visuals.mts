import {writeFile} from 'node:fs/promises'

import {openai, type OpenAILanguageModelResponsesOptions} from '@ai-sdk/openai'

import {toSourceChunks, type StoredChunk} from '../lib/evidence/chunks.ts'
import {readVisualConfig} from '../lib/visual/budget.ts'
import {buildVisualIndex, type VideoVisualIndexDocument} from '../lib/visual/index.ts'
import {openLocalMedia} from '../lib/visual/media.ts'
import {createTesseractEngine} from '../lib/visual/ocr.ts'
import {createVlmDescriber} from '../lib/visual/vlm.ts'

/**
 * Offline visual indexing for one video (development plan §5 PR-2). Never
 * runs in the request path.
 *
 *   npm run index:visuals -- --file <path> --video <video document id>
 *   npm run index:visuals -- --file lesson.mp4 --video video-youtube-abc --dry-run --out index.json
 *   npm run index:visuals -- --file lesson.mp4 --video video-youtube-abc --no-vlm
 *
 * Only index media you own or are licensed to process. This tool reads a
 * local file and downloads nothing. It samples frames, OCRs them, merges
 * repeated text into appearance intervals, and calls the vision model only
 * where the gate justifies it, within the `VISUAL_*` caps (see
 * `.env.example`). The result replaces the `visual-<video id>` document;
 * `--dry-run` writes nothing. Needs ffmpeg/ffprobe; the VLM needs
 * OPENAI_API_KEY (without it, or with `--no-vlm`, gated frames are recorded as
 * skipped spans).
 */

const MODEL = 'gpt-5-mini'
/** A frame description needs little deliberation; reasoning tokens count against the output budget. */
const PROVIDER_OPTIONS = {
  openai: {reasoningEffort: 'minimal', reasoningSummary: null} satisfies OpenAILanguageModelResponsesOptions,
}
const VLM_TIMEOUT_MS = 60_000
const SANITY_TIMEOUT_MS = 30_000
/** Published `video` document ids only: never a draft or version id. */
const VIDEO_DOCUMENT_ID = /^video-[A-Za-z0-9_-]+$/

type VideoRecord = {
  _id: string
  durationSeconds?: number | null
  transcriptChunks?: Array<Partial<StoredChunk>> | null
}

const {file, videoId, dryRun, noVlm, out} = parseArgs(process.argv.slice(2))

console.log('Indexing a local media file. Only index media you own or are licensed to process; nothing is downloaded.\n')

const projectId = process.env.NEXT_PUBLIC_SANITY_PROJECT_ID
const dataset = process.env.NEXT_PUBLIC_SANITY_DATASET
const apiVersion = process.env.NEXT_PUBLIC_SANITY_API_VERSION || '2026-08-31'
const writeToken = process.env.SANITY_API_WRITE_TOKEN
const readToken = writeToken || process.env.SANITY_API_READ_TOKEN
if (!dryRun && (!projectId || !dataset || !writeToken)) {
  console.error(
    'Missing NEXT_PUBLIC_SANITY_PROJECT_ID, NEXT_PUBLIC_SANITY_DATASET, or SANITY_API_WRITE_TOKEN (required to write; use --dry-run to index without writing).',
  )
  process.exit(1)
}
const apiBase = projectId ? `https://${projectId}.api.sanity.io/v${apiVersion}/data` : null

const config = readVisualConfig()
const vlmEnabled = !noVlm && Boolean(process.env.OPENAI_API_KEY) && config.caps.maxVlmCalls > 0
if (!vlmEnabled) {
  config.caps.maxVlmCalls = 0
  console.log(`VLM disabled (${noVlm ? '--no-vlm' : process.env.OPENAI_API_KEY ? 'VISUAL_MAX_VLM_CALLS=0' : 'no OPENAI_API_KEY'}); gated frames are recorded as skipped spans.`)
}

const video = await fetchVideo()
if (!video && !dryRun) {
  console.error(`No published video document "${videoId}". A visual index must reference an existing video.`)
  process.exit(1)
}
if (!video) console.warn(`Video "${videoId}" not readable; dry run continues without transcript context.`)

const media = await openLocalMedia({file, videoDocumentId: videoId})
if (typeof video?.durationSeconds === 'number' && Math.abs(video.durationSeconds - media.durationSeconds) > 5) {
  console.warn(
    `Warning: the file is ${Math.round(media.durationSeconds)}s but the video document says ${video.durationSeconds}s — is this the right file?`,
  )
}

const ocr = await createTesseractEngine()
let document: VideoVisualIndexDocument
let logLine: string
try {
  ;({document, logLine} = await buildVisualIndex({
    media,
    ocr,
    describe: vlmEnabled
      ? createVlmDescriber({model: openai(MODEL), providerOptions: PROVIDER_OPTIONS, timeoutMs: VLM_TIMEOUT_MS})
      : null,
    transcript: video ? toSourceChunks(video) : [],
    config,
  }))
} finally {
  await ocr.terminate()
}

console.log(logLine)
for (const span of document.coverage.skippedSpans) {
  console.log(`skipped ${span.startSeconds}–${span.endSeconds}s  ${span.reason}`)
}

if (out) {
  await writeFile(out, `${JSON.stringify(document, null, 2)}\n`)
  console.log(`Wrote ${document._id} to ${out}`)
}
if (dryRun) {
  console.log(`\nDry run: ${document._id} not written (${document.chunks.length} chunk(s)).`)
} else {
  await fetchJson(`${apiBase}/mutate/${dataset}?returnIds=false`, {
    method: 'POST',
    headers: {authorization: `Bearer ${writeToken}`, 'content-type': 'application/json'},
    body: JSON.stringify({mutations: [{createOrReplace: document}]}),
  })
  console.log(`\nWrote ${document._id} (${document.chunks.length} chunk(s)${document.coverage.partial ? ', partial' : ''}).`)
}

async function fetchVideo(): Promise<VideoRecord | null> {
  if (!apiBase || !dataset) return null
  const query = '*[_type == "video" && _id == $id][0]{_id, durationSeconds, transcriptChunks[]{_key, startSeconds, text}}'
  const search = new URLSearchParams({query, perspective: 'published', $id: JSON.stringify(videoId)})
  try {
    const body = (await fetchJson(`${apiBase}/query/${dataset}?${search}`, {
      headers: readToken ? {authorization: `Bearer ${readToken}`} : {},
    })) as {result?: VideoRecord | null}
    return body.result ?? null
  } catch (error) {
    if (!dryRun) throw error
    console.warn(error instanceof Error ? error.message : String(error))
    return null
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
    const mayHaveApplied = method === 'POST' ? '; the write may still have applied, and a rerun replaces it' : ''
    throw new Error(`${method} ${path} timed out after ${SANITY_TIMEOUT_MS / 1000}s${mayHaveApplied}`)
  }
  if (!response.ok) throw new Error(`${method} ${path} → ${response.status}: ${body.slice(0, 200)}`)
  return JSON.parse(body)
}

function parseArgs(argv: string[]): {file: string; videoId: string; dryRun: boolean; noVlm: boolean; out: string | null} {
  let file: string | null = null
  let videoId: string | null = null
  let dryRun = false
  let noVlm = false
  let out: string | null = null
  const usage = 'Usage: index-visuals --file <path> --video <video document id> [--dry-run] [--no-vlm] [--out file.json]'
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--dry-run') dryRun = true
    else if (arg === '--no-vlm') noVlm = true
    else if (arg === '--file' && argv[i + 1]) file = argv[++i]
    else if (arg === '--video' && argv[i + 1]) videoId = argv[++i]
    else if (arg === '--out' && argv[i + 1]) out = argv[++i]
    else {
      console.error(`Unexpected argument ${arg}. ${usage}`)
      process.exit(1)
    }
  }
  if (!file || !videoId) {
    console.error(`--file and --video are required. ${usage}`)
    process.exit(1)
  }
  if (!VIDEO_DOCUMENT_ID.test(videoId)) {
    console.error(`--video must be a published video document id such as "video-youtube-abc", not "${videoId}".`)
    process.exit(1)
  }
  return {file, videoId, dryRun, noVlm, out}
}
