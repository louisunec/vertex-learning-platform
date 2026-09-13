import {spawn} from 'node:child_process'
import {createHash} from 'node:crypto'
import {createReadStream} from 'node:fs'
import {stat} from 'node:fs/promises'

import {ANALYSIS_FPS, ANALYSIS_HEIGHT, ANALYSIS_WIDTH, type GrayFrame} from './sampling.ts'

/**
 * Media input for the visual index (development plan §5 PR-2). The only
 * adapter reads a local file the caller owns or is licensed to process;
 * nothing here downloads from YouTube or any other provider. Vimeo/Bunny
 * owner-API adapters can implement `MediaSource` later.
 *
 * Decoding uses ffmpeg/ffprobe from PATH, or FFMPEG_PATH / FFPROBE_PATH.
 */

export type MediaSource = {
  videoDocumentId: string
  /** Content hash of the media file; a re-encode reads as a new source. */
  sourceRevision: string
  durationSeconds: number
  width: number
  height: number
  /** Decodes analysis frames in time order; return false from `onFrame` to stop early. */
  decodeAnalysisFrames(onFrame: (frame: GrayFrame) => boolean): Promise<void>
  /** Timestamps where ffmpeg's scene score exceeds `threshold`. */
  sceneChangeTimes(threshold: number): Promise<number[]>
  /** One full-resolution PNG frame at `timestampSeconds`. */
  framePng(timestampSeconds: number): Promise<Buffer>
}

export const ffmpegPath = () => process.env.FFMPEG_PATH || 'ffmpeg'
export const ffprobePath = () => process.env.FFPROBE_PATH || 'ffprobe'

/** Whether ffmpeg and ffprobe can be run. */
export async function hasMediaTools(): Promise<boolean> {
  try {
    await run(ffmpegPath(), ['-version'])
    await run(ffprobePath(), ['-version'])
    return true
  } catch {
    return false
  }
}

/** Opens a local, owned or licensed media file as the source for one `video` document. */
export async function openLocalMedia({file, videoDocumentId}: {file: string; videoDocumentId: string}): Promise<MediaSource> {
  const info = await stat(file).catch(() => null)
  if (!info?.isFile()) throw new Error(`Media file not found: ${file}`)

  const [sourceRevision, probe] = await Promise.all([hashFile(file), probeVideo(file)])
  const frameBytes = ANALYSIS_WIDTH * ANALYSIS_HEIGHT

  return {
    videoDocumentId,
    sourceRevision,
    ...probe,

    decodeAnalysisFrames(onFrame) {
      return new Promise((resolve, reject) => {
        const child = spawn(
          ffmpegPath(),
          [
            ...['-v', 'error', '-nostdin', '-i', file],
            ...['-an', '-vf', `fps=${ANALYSIS_FPS},scale=${ANALYSIS_WIDTH}:${ANALYSIS_HEIGHT},format=gray`],
            ...['-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1'],
          ],
          {stdio: ['ignore', 'pipe', 'pipe']},
        )
        let buffered = Buffer.alloc(0)
        let index = 0
        let stopped = false
        let stderr = ''
        child.stderr.on('data', (chunk: Buffer) => (stderr = (stderr + chunk.toString()).slice(-2000)))
        child.stdout.on('data', (chunk: Buffer) => {
          if (stopped) return
          buffered = Buffer.concat([buffered, chunk])
          while (buffered.length >= frameBytes) {
            const pixels = new Uint8Array(buffered.subarray(0, frameBytes))
            buffered = buffered.subarray(frameBytes)
            const frame = {timestampSeconds: index++ / ANALYSIS_FPS, width: ANALYSIS_WIDTH, height: ANALYSIS_HEIGHT, pixels}
            if (!onFrame(frame)) {
              stopped = true
              child.kill('SIGKILL')
              return
            }
          }
        })
        child.on('error', reject)
        child.on('close', (code) => {
          if (stopped || code === 0) resolve()
          else reject(new Error(`ffmpeg frame decode failed (${code}): ${stderr.trim()}`))
        })
      })
    },

    async sceneChangeTimes(threshold) {
      const {stderr} = await run(ffmpegPath(), [
        ...['-hide_banner', '-nostats', '-nostdin', '-loglevel', 'info', '-i', file],
        ...['-an', '-vf', `select='gt(scene,${threshold})',showinfo`, '-f', 'null', '-'],
      ])
      return [...stderr.matchAll(/\bpts_time:\s*([0-9.]+)/g)].map((match) => Number(match[1])).filter(Number.isFinite)
    },

    async framePng(timestampSeconds) {
      const {stdout} = await run(ffmpegPath(), [
        ...['-v', 'error', '-nostdin', '-ss', timestampSeconds.toFixed(3), '-i', file],
        ...['-an', '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1'],
      ])
      if (stdout.length === 0) throw new Error(`No frame at ${timestampSeconds}s`)
      return stdout
    },
  }
}

async function probeVideo(file: string): Promise<{durationSeconds: number; width: number; height: number}> {
  const {stdout} = await run(ffprobePath(), [
    ...['-v', 'error', '-select_streams', 'v:0'],
    ...['-show_entries', 'stream=width,height:format=duration', '-of', 'json', file],
  ])
  const parsed = JSON.parse(stdout.toString()) as {
    streams?: Array<{width?: number; height?: number}>
    format?: {duration?: string}
  }
  const stream = parsed.streams?.[0]
  const durationSeconds = Number(parsed.format?.duration)
  if (!stream?.width || !stream.height || !Number.isFinite(durationSeconds)) {
    throw new Error(`No video stream with a duration in ${file}`)
  }
  return {durationSeconds, width: stream.width, height: stream.height}
}

async function hashFile(file: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer)
  return `sha256-${hash.digest('hex')}`
}

function run(command: string, args: string[]): Promise<{stdout: Buffer; stderr: string}> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {stdio: ['ignore', 'pipe', 'pipe']})
    const out: Buffer[] = []
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve({stdout: Buffer.concat(out), stderr})
      else reject(new Error(`${command} exited with ${code}: ${stderr.trim().slice(-500)}`))
    })
  })
}
