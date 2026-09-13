import {spawn} from 'node:child_process'
import {existsSync} from 'node:fs'
import {mkdir, mkdtemp, rm, stat, writeFile} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {pathToFileURL} from 'node:url'

/**
 * Synthetic clips for the visual index (development plan §5 PR-2). Code,
 * slide, and diagram frames are rendered from local HTML with system fonts by headless
 * Chrome, then encoded with ffmpeg; the talking head is moving shapes drawn by
 * ffmpeg. No third-party footage, and nothing binary is committed.
 *
 *   node scripts/fixtures/make-visual-fixtures.mts [outDir]
 *
 * Needs ffmpeg (PATH or FFMPEG_PATH) and Chrome (CHROME_PATH or a standard
 * install location).
 */

export const FIXTURE_SIZE = {width: 1280, height: 720}
const FPS = 10

type Stage = {seconds: number; html: string}
export type FixtureName = 'silent-typing' | 'code-edit' | 'slide-change' | 'visual-diagram' | 'talking-head'

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
]

/** A runnable Chrome binary, or null. */
export function findChrome(): string | null {
  if (process.env.CHROME_PATH) return existsSync(process.env.CHROME_PATH) ? process.env.CHROME_PATH : null
  return CHROME_CANDIDATES.find((candidate) => existsSync(candidate)) ?? null
}

const codePage = (code: string) => `<!doctype html><html><head><meta charset="utf-8"><style>
  html, body { margin: 0; width: ${FIXTURE_SIZE.width}px; height: ${FIXTURE_SIZE.height}px; background: #1e1e1e; }
  pre { margin: 0; padding: 72px 96px; color: #e6e6e6; font: 36px/1.5 Menlo, Monaco, "DejaVu Sans Mono", monospace; }
</style></head><body><pre>${escapeHtml(code)}</pre></body></html>`

const slidePage = (title: string, bullets: string[], background: string) => `<!doctype html><html><head><meta charset="utf-8"><style>
  html, body { margin: 0; width: ${FIXTURE_SIZE.width}px; height: ${FIXTURE_SIZE.height}px; background: ${background}; }
  body { box-sizing: border-box; padding: 96px 120px; color: #111; font-family: Helvetica, Arial, "DejaVu Sans", sans-serif; }
  h1 { margin: 0 0 56px; font-size: 72px; }
  li { font-size: 44px; margin-bottom: 28px; }
</style></head><body><h1>${escapeHtml(title)}</h1><ul>${bullets.map((b) => `<li>${escapeHtml(b)}</li>`).join('')}</ul></body></html>`

const svgPage = (background: string, shapes: string) => `<!doctype html><html><head><meta charset="utf-8"><style>
  html, body { margin: 0; width: ${FIXTURE_SIZE.width}px; height: ${FIXTURE_SIZE.height}px; background: ${background}; }
</style></head><body><svg width="${FIXTURE_SIZE.width}" height="${FIXTURE_SIZE.height}" xmlns="http://www.w3.org/2000/svg">${shapes}</svg></body></html>`

/** An unlabelled component tree: boxes and connectors, the kind of frame OCR cannot read. */
function componentTree(): string {
  const box = (x: number, y: number, w: number, h: number, fill: string) =>
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="12" fill="${fill}" stroke="#1b1b1b" stroke-width="8"/>`
  const edges =
    'M640 150 L340 330 M640 150 L640 330 M640 150 L940 330 M340 390 L200 560 M340 390 L420 560 M640 390 L640 560 M940 390 L840 560 M940 390 L1080 560'
  return svgPage(
    '#f7f7f2',
    `<path d="${edges}" stroke="#1b1b1b" stroke-width="8" fill="none"/>` +
      box(560, 90, 160, 60, '#61dafb') +
      [260, 560, 860].map((x) => box(x, 330, 160, 60, '#f4b942')).join('') +
      [130, 350, 570, 770, 1010].map((x, i) => box(x, 560, 140, 56, i === 2 ? '#e36b6b' : '#9be38b')).join(''),
  )
}

/** An unlabelled flame chart built from a fixed seed, so every render is identical. */
function flameChart(): string {
  const colors = ['#e8743b', '#f0a13a', '#f6c85f', '#d9534f', '#ef8e4a']
  let seed = 7
  const random = () => (seed = (seed * 9301 + 49297) % 233280) / 233280
  const rects: string[] = []
  const row = (y: number, x0: number, x1: number, depth: number) => {
    if (depth > 9 || x1 - x0 < 24) return
    for (let x = x0; x < x1 - 20; ) {
      const width = Math.max(24, Math.min(x1 - x, (x1 - x0) * (0.2 + random() * 0.6)))
      const fill = colors[(depth + Math.floor(random() * 5)) % 5]
      rects.push(`<rect x="${x}" y="${y}" width="${width - 4}" height="44" fill="${fill}" stroke="#1d1f24" stroke-width="4"/>`)
      row(y - 50, x + 4, x + width - 8, depth + 1)
      x += width
    }
  }
  row(650, 40, 1240, 0)
  return svgPage('#1d1f24', rects.join(''))
}

const TYPING = [
  'function calculateTotal(items) {',
  '\n  let total = 0',
  '\n  for (const item of items) {\n    total += item.price\n  }',
  '\n  return tot',
  'al\n}',
]

const CLAMP = (comparison: string) => `function clamp(x) {\n  if (x ${comparison} 10) {\n    return x\n  }\n  return 10\n}`

/** Each fixture's stages; stage times are cumulative from 0. */
export const FIXTURE_STAGES: Record<Exclude<FixtureName, 'talking-head'>, Stage[]> = {
  // 0–2 s signature, 2–4 s + let, 4–6 s + loop, 6–8 s "return tot", 8–12 s complete.
  'silent-typing': TYPING.map((_, i) => ({
    seconds: i === TYPING.length - 1 ? 4 : 2,
    html: codePage(TYPING.slice(0, i + 1).join('')),
  })),
  // 0–5 s `x < 10`, 5–10 s `x <= 10`: a one-character edit on a static screen.
  'code-edit': [
    {seconds: 5, html: codePage(CLAMP('<'))},
    {seconds: 5, html: codePage(CLAMP('<='))},
  ],
  // 0–4 s code whose identifier is never spoken, 4–8 s an unlabelled component
  // tree, 8–12 s an unlabelled flame chart: visual content OCR cannot read.
  'visual-diagram': [
    {
      seconds: 4,
      html: codePage(
        'const selectVisibleTodos = createSelector(\n  [selectTodos, selectFilter],\n  (todos, filter) => todos.filter(matches(filter))\n)',
      ),
    },
    {seconds: 4, html: componentTree()},
    {seconds: 4, html: flameChart()},
  ],
  // Three slides, 3 s each.
  'slide-change': [
    {seconds: 3, html: slidePage('Introduction to React Hooks', ['State in function components', 'Effects and cleanup'], '#f4f1ea')},
    {seconds: 3, html: slidePage('useEffect Cleanup', ['Return a function from the effect', 'It runs before the next effect'], '#e8f0f8')},
    {seconds: 3, html: slidePage('Custom Hooks', ['Extract reusable stateful logic', 'Name them with a use prefix'], '#eef6ea')},
  ],
}

export const FIXTURE_DURATIONS: Record<FixtureName, number> = {
  'silent-typing': 12,
  'code-edit': 10,
  'slide-change': 9,
  'visual-diagram': 12,
  'talking-head': 8,
}

/** Renders and encodes the fixtures (all, or only `names`) into `outDir`; returns their paths. */
export async function makeVisualFixtures(
  outDir: string,
  names?: ReadonlyArray<FixtureName>,
): Promise<Record<FixtureName, string>> {
  const wanted = (name: FixtureName) => !names || names.includes(name)
  const chrome = findChrome()
  if (!chrome) throw new Error('Chrome not found (set CHROME_PATH).')
  await mkdir(outDir, {recursive: true})
  const profile = await mkdtemp(path.join(os.tmpdir(), 'vertex-fixture-chrome-'))
  try {
    const paths = {} as Record<FixtureName, string>
    for (const [name, stages] of Object.entries(FIXTURE_STAGES) as Array<[FixtureName, Stage[]]>) {
      if (wanted(name)) paths[name] = await encodeStages(name, stages, outDir, chrome, profile)
    }
    if (wanted('talking-head')) paths['talking-head'] = await encodeTalkingHead(outDir)
    return paths
  } finally {
    await rm(profile, {recursive: true, force: true})
  }
}

async function encodeStages(name: string, stages: Stage[], outDir: string, chrome: string, profile: string): Promise<string> {
  const inputs: string[] = []
  for (const [i, stage] of stages.entries()) {
    const html = path.join(outDir, `${name}-${i}.html`)
    const png = path.join(outDir, `${name}-${i}.png`)
    await writeFile(html, stage.html)
    await screenshot(chrome, profile, html, png)
    inputs.push('-loop', '1', '-framerate', String(FPS), '-t', String(stage.seconds), '-i', png)
  }
  const {width, height} = FIXTURE_SIZE
  const scaled = stages.map((_, i) => `[${i}:v]scale=${width}:${height},format=yuv420p,setsar=1[s${i}]`)
  const joined = `${stages.map((_, i) => `[s${i}]`).join('')}concat=n=${stages.length}:v=1:a=0[v]`
  const out = path.join(outDir, `${name}.mp4`)
  await run(ffmpeg(), [
    ...['-y', '-v', 'error', ...inputs],
    ...['-filter_complex', [...scaled, joined].join(';'), '-map', '[v]', '-r', String(FPS), '-c:v', 'libx264', out],
  ])
  return out
}

/** A "head" and "shoulders" swaying in front of a flat background; no text. */
async function encodeTalkingHead(outDir: string): Promise<string> {
  const out = path.join(outDir, 'talking-head.mp4')
  const seconds = FIXTURE_DURATIONS['talking-head']
  const {width, height} = FIXTURE_SIZE
  await run(ffmpeg(), [
    ...['-y', '-v', 'error'],
    ...['-f', 'lavfi', '-i', `color=c=0x3a4a5a:s=${width}x${height}:d=${seconds}:r=${FPS}`],
    ...['-f', 'lavfi', '-i', `color=c=0xd9a77a:s=300x380:d=${seconds}:r=${FPS}`],
    ...['-f', 'lavfi', '-i', `color=c=0x2b3b2b:s=560x220:d=${seconds}:r=${FPS}`],
    '-filter_complex',
    "[0][1]overlay=x='490+70*sin(t*1.7)':y='120+25*sin(t*2.3)'[a];[a][2]overlay=x='360+70*sin(t*1.7)':y='520'[v]",
    ...['-map', '[v]', '-t', String(seconds), '-pix_fmt', 'yuv420p', '-c:v', 'libx264', out],
  ])
  return out
}

const SCREENSHOT_TIMEOUT_MS = 30_000

/**
 * Headless Chrome can stay alive after writing `--screenshot` (seen with
 * `--headless=new` on macOS), so this resolves once the PNG exists and its
 * size is stable, then kills Chrome's whole process group.
 */
async function screenshot(chrome: string, profile: string, html: string, png: string): Promise<void> {
  await rm(png, {force: true})
  const child = spawn(
    chrome,
    [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      '--force-device-scale-factor=1',
      `--user-data-dir=${profile}`,
      `--window-size=${FIXTURE_SIZE.width},${FIXTURE_SIZE.height}`,
      `--screenshot=${png}`,
      pathToFileURL(html).href,
    ],
    {stdio: 'ignore', detached: true},
  )
  let exited = false
  child.on('exit', () => (exited = true))
  const deadline = Date.now() + SCREENSHOT_TIMEOUT_MS
  try {
    let lastSize = -1
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200))
      const size = (await stat(png).catch(() => null))?.size ?? 0
      if (size > 0 && size === lastSize) return
      lastSize = size
      if (exited && size === 0) throw new Error(`Chrome exited without writing ${path.basename(png)}`)
    }
    throw new Error(`Chrome did not write ${path.basename(png)} within ${SCREENSHOT_TIMEOUT_MS / 1000}s`)
  } finally {
    if (!exited && child.pid) {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
    }
  }
}

function ffmpeg(): string {
  return process.env.FFMPEG_PATH || 'ffmpeg'
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {stdio: ['ignore', 'ignore', 'pipe']})
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => (stderr = (stderr + chunk.toString()).slice(-2000)))
    child.on('error', reject)
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${path.basename(command)} exited with ${code}: ${stderr.trim()}`)),
    )
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const outDir = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'vertex-visual-fixtures'))
  const paths = await makeVisualFixtures(outDir)
  for (const [name, file] of Object.entries(paths)) console.log(`${name.padEnd(14)} ${file}`)
}
