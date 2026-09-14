import assert from 'node:assert/strict'
import {readdirSync, readFileSync} from 'node:fs'
import {register} from 'node:module'
import {before, describe, it} from 'node:test'

/**
 * The Studio publish gate for explanation tasks, through the real
 * `studio/sanity.config.ts` document-actions resolver and the real schema
 * constants, over isolated fixture documents: no running Studio, dataset, or
 * network. Sanity's packages are stubbed (identity `define*` helpers, inert
 * icons and plugins) because only the gate logic is under test; the Studio
 * wraps this same resolver around its built-in publish action.
 */

const STUDIO = new URL('../../studio/', import.meta.url)

function studioSources(dir: URL): string[] {
  return readdirSync(dir, {withFileTypes: true}).flatMap((entry) => {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) return []
    const url = new URL(entry.isDirectory() ? `${entry.name}/` : entry.name, dir)
    return entry.isDirectory() ? studioSources(url) : entry.name.endsWith('.ts') ? [readFileSync(url, 'utf8')] : []
  })
}

const ICONS = [...new Set(studioSources(STUDIO).flatMap((source) => source.match(/\b[A-Z]\w*Icon\b/g) ?? []))]

const STUBS: Record<string, string> = {
  sanity: 'export const defineConfig = (x) => x, defineType = (x) => x, defineField = (x) => x, defineArrayMember = (x) => x',
  'sanity/structure': 'export const structureTool = () => ({name: "structure"})',
  '@sanity/vision': 'export const visionTool = () => ({name: "vision"})',
  '@sanity/context/studio': 'export const contextPlugin = () => ({name: "context"}); export const CONTEXT_SCHEMA_TYPE_NAME = "sanity.agentContext"',
  '@sanity/icons': ICONS.map((name) => `export const ${name} = () => null`).join('\n'),
}

const HOOKS = `
  import {existsSync} from 'node:fs'
  const STUDIO = ${JSON.stringify(STUDIO.href)}
  const STUBS = ${JSON.stringify(STUBS)}
  export async function resolve(specifier, context, next) {
    if (Object.hasOwn(STUBS, specifier)) return {url: 'studio-stub:' + encodeURIComponent(specifier), shortCircuit: true}
    // Studio code imports its own modules without extensions (bundler resolution).
    if (specifier.startsWith('.') && context.parentURL?.startsWith(STUDIO) && !/\\.[a-z]+$/.test(specifier)) {
      for (const candidate of [specifier + '.ts', specifier + '/index.ts']) {
        const url = new URL(candidate, context.parentURL)
        if (existsSync(url)) return next(url.href, context)
      }
    }
    return next(specifier, context)
  }
  export async function load(url, context, next) {
    if (url.startsWith('studio-stub:')) return {format: 'module', source: STUBS[decodeURIComponent(url.slice('studio-stub:'.length))], shortCircuit: true}
    return next(url, context)
  }
`

type Doc = Record<string, unknown> & {_id: string; _type: string}
type Description = {label: string; disabled?: boolean; title?: string} | null
type Action = ((props: {draft: Doc | null; published: Doc | null}) => Description) & {action?: string}
type StudioConfig = {
  document: {
    actions: (prev: Action[], context: {schemaType: string}) => Action[]
    newDocumentOptions: (prev: Array<{templateId: string}>) => Array<{templateId: string}>
  }
}

const action = (name: string): Action => Object.assign(() => ({label: name}), {action: name})
const BUILT_IN = ['publish', 'discardChanges', 'unpublish', 'delete', 'duplicate', 'schedule'].map(action)

/** The synthetic fixture task (lib/explain/test-fixtures.ts), as a Studio document. */
function taskDoc(overrides: Record<string, unknown> = {}): Doc {
  return {
    _id: 'explanationTask-dough-rise-and-set',
    _type: 'explanationTask',
    reviewStatus: 'approved',
    taskId: 'dough-rise-and-set',
    version: 1,
    lesson: {_type: 'reference', _ref: 'lesson-why-dough-rises'},
    title: 'Rising and setting',
    prompt: 'In your own words, explain why dough rises while it proofs, but stops rising once the loaf is baked.',
    criteria: [
      {_key: 'c-rise', label: 'What makes dough rise while it proofs', point: 'Yeast gas trapped by gluten.', required: true, sourceChunkIds: ['video-youtube-doughvideo01:k1']},
    ],
    sourceChunkRefs: [{_key: 'r1', chunkId: 'video-youtube-doughvideo01:k1', chunkRevision: 'rev1', startSeconds: 30, endSeconds: 45}],
    review: Object.fromEntries(REVIEW_CHECKS.map((name) => [name, true])),
    ...overrides,
  }
}

let config: StudioConfig
let REVIEW_CHECKS: string[] = []

before(async () => {
  register(`data:text/javascript,${encodeURIComponent(HOOKS)}`)
  // The config requires a project and dataset; placeholders, since nothing here reaches Sanity.
  process.env.SANITY_STUDIO_PROJECT_ID ||= 'fixture'
  process.env.SANITY_STUDIO_DATASET ||= 'fixture'
  // Dynamic and untyped: the root typecheck does not follow Studio code into its own workspace.
  const configUrl: string = new URL('sanity.config.ts', STUDIO).href
  const schemaUrl: string = new URL('schemaTypes/documents/explanation-task.ts', STUDIO).href
  config = (await import(configUrl)).default as StudioConfig
  REVIEW_CHECKS = ((await import(schemaUrl)).EXPLANATION_TASK_REVIEW_CHECKS as Array<{name: string}>).map((check) => check.name)
})

describe('explanation task publish gate (Studio config, fixture documents)', () => {
  const publishWith = (draft: Doc | null, published: Doc | null) => {
    const publish = config.document.actions(BUILT_IN, {schemaType: 'explanationTask'}).find((entry) => entry.action === 'publish')!
    const description = publish({draft, published})!
    return description.disabled ? description.title! : null
  }

  it('keeps tasks permanent and generator-only: no delete, unpublish, duplicate, schedule, or hand-made task', () => {
    const actions = config.document.actions(BUILT_IN, {schemaType: 'explanationTask'}).map((entry) => entry.action)
    assert.deepEqual(actions, ['publish', 'discardChanges'])
    assert.deepEqual(config.document.newDocumentOptions([{templateId: 'explanationTask'}, {templateId: 'lesson'}]), [{templateId: 'lesson'}])
    assert.equal(REVIEW_CHECKS.length, 6)
  })

  it('publishes a new task only at version 1, approved, with every review check ticked', () => {
    assert.equal(publishWith(taskDoc(), null), null)
    assert.equal(publishWith(taskDoc({version: 2}), null), 'A new task starts at version 1.')
    assert.equal(publishWith(taskDoc({reviewStatus: 'needs_review'}), null), 'Set the review status to Approved before publishing.')
    for (const check of REVIEW_CHECKS) {
      const review = {...taskDoc().review as object, [check]: false}
      assert.equal(publishWith(taskDoc({review}), null), 'Complete every review check before publishing.', check)
    }
    assert.equal(publishWith(null, taskDoc()), null, 'no draft: nothing to gate')
  })

  it('increases the version by exactly one when, and only when, published content changes', () => {
    const published = taskDoc()
    const reworded = {prompt: 'A reworded question.'}
    assert.equal(publishWith(taskDoc(reworded), published), 'Content changed since version 1: set the version to 2.')
    assert.equal(publishWith(taskDoc({...reworded, version: 3}), published), 'Content changed since version 1: set the version to 2.')
    assert.equal(publishWith(taskDoc({...reworded, version: 2}), published), null)
    assert.equal(publishWith(taskDoc({version: 2}), published), 'Keep version 1: only a content change increases it.')
    // A changed private point or source is a content change too; key order is not.
    const criteria = [{...(published.criteria as object[])[0], point: 'A changed point.'}]
    assert.equal(publishWith(taskDoc({criteria}), published), 'Content changed since version 1: set the version to 2.')
    const reordered = taskDoc({criteria: (published.criteria as Array<Record<string, unknown>>).map((entry) => Object.fromEntries(Object.entries(entry).reverse()))})
    assert.equal(publishWith(reordered, published), null)
  })

  it('keeps the task id, and lets an archive withdraw a task without changing it', () => {
    const published = taskDoc()
    assert.equal(publishWith(taskDoc({taskId: 'another-task'}), published), 'A task keeps its id. Draft a new task instead.')
    assert.equal(publishWith(taskDoc({reviewStatus: 'archived', review: {}}), published), null)
    assert.equal(publishWith(taskDoc({reviewStatus: 'archived', prompt: 'Changed.', version: 2}), published), 'An archived task keeps its published content.')
  })

  it('leaves other types to their own gates', () => {
    const lesson = config.document.actions(BUILT_IN, {schemaType: 'lesson'}).map((entry) => entry.action)
    assert.deepEqual(lesson, BUILT_IN.map((entry) => entry.action))
  })
})
