/**
 * Validates scripts/seed/seed.ndjson before it is imported.
 *
 * Checks:
 *  - every document uses only fields the Studio schema defines (catches field drift),
 *  - every reference resolves to a document in the seed,
 *  - every lesson is referenced by exactly one module of exactly one course,
 *  - every lesson has an integer `durationSeconds` that matches videos.json,
 *  - prints the derived module/course totals (module = sum of its lessons,
 *    course = sum of its modules) so the numbers can be compared against
 *    what the web app derives at query time.
 *
 * Usage: node scripts/seed/validate.mjs   (from studio/)
 */
import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

const dir = path.dirname(fileURLToPath(import.meta.url))
const docs = fs
  .readFileSync(path.join(dir, 'seed.ndjson'), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line))
const videos = JSON.parse(fs.readFileSync(path.join(dir, 'videos.json'), 'utf8'))

// Mirrors studio/schemaTypes. Update both when the schema changes.
const FIELDS = {
  category: ['title', 'slug', 'description'],
  instructor: ['name', 'slug', 'photo', 'expertise', 'bio'],
  course: [
    'title', 'slug', 'summary', 'coverImage', 'level', 'instructor', 'category',
    'learningOutcomes', 'modules', 'priceDisplay', 'popular', 'studentCountDisplay',
  ],
  lesson: [
    'title', 'slug', 'videoUrl', 'poster', 'durationSeconds', 'notes', 'keyPoints',
    'proTip', 'resources', 'freePreview', 'studentCountDisplay',
  ],
}
const RESOURCE_TYPES = new Set(['article', 'documentation', 'code', 'download', 'video', 'other'])
const LEVELS = new Set(['beginner', 'intermediate', 'advanced'])

const problems = []
const byId = new Map()
for (const doc of docs) {
  if (byId.has(doc._id)) problems.push(`duplicate _id ${doc._id}`)
  byId.set(doc._id, doc)
}

for (const doc of docs) {
  const allowed = FIELDS[doc._type]
  if (!allowed) {
    problems.push(`${doc._id}: unexpected _type ${doc._type}`)
    continue
  }
  for (const key of Object.keys(doc)) {
    if (key.startsWith('_')) continue
    if (!allowed.includes(key)) problems.push(`${doc._id}: field "${key}" is not in the ${doc._type} schema`)
  }
  if (doc._type !== 'instructor' && typeof doc.title !== 'string') problems.push(`${doc._id}: missing title`)
  if (doc._type === 'instructor' && typeof doc.bio !== 'string') problems.push(`${doc._id}: bio must be plain text`)
  if (!doc.slug?.current) problems.push(`${doc._id}: missing slug`)
}

const lessonRefs = new Map()
const courses = docs.filter((d) => d._type === 'course')
const rows = []
for (const course of courses) {
  if (!LEVELS.has(course.level)) problems.push(`${course._id}: invalid level ${course.level}`)
  for (const field of ['instructor', 'category']) {
    if (!byId.has(course[field]?._ref)) problems.push(`${course._id}: ${field} reference does not resolve`)
  }
  let courseSeconds = 0
  let courseLessons = 0
  const modules = []
  ;(course.modules ?? []).forEach((mod, i) => {
    if (!mod._key) problems.push(`${course._id}: module ${i} has no _key`)
    let moduleSeconds = 0
    const refs = mod.lessons ?? []
    if (refs.length === 0) problems.push(`${course._id}: module "${mod.title}" has no lessons`)
    for (const ref of refs) {
      const lesson = byId.get(ref._ref)
      if (!lesson || lesson._type !== 'lesson') {
        problems.push(`${course._id}: module "${mod.title}" references missing lesson ${ref._ref}`)
        continue
      }
      lessonRefs.set(lesson._id, (lessonRefs.get(lesson._id) ?? 0) + 1)
      moduleSeconds += lesson.durationSeconds ?? 0
    }
    courseSeconds += moduleSeconds
    courseLessons += refs.length
    modules.push({title: mod.title, lessons: refs.length, seconds: moduleSeconds})
  })
  rows.push({course, modules, lessons: courseLessons, seconds: courseSeconds})
}

for (const lesson of docs.filter((d) => d._type === 'lesson')) {
  const n = lessonRefs.get(lesson._id) ?? 0
  if (n !== 1) problems.push(`${lesson._id}: referenced by ${n} modules (expected exactly 1)`)
  if (!Number.isInteger(lesson.durationSeconds) || lesson.durationSeconds <= 0) {
    problems.push(`${lesson._id}: durationSeconds must be a positive integer`)
  }
  const video = videos[lesson._id.replace(/^lesson\./, '')]
  if (!video) problems.push(`${lesson._id}: no entry in videos.json`)
  else {
    if (video.duration !== lesson.durationSeconds) {
      problems.push(`${lesson._id}: durationSeconds ${lesson.durationSeconds} != videos.json ${video.duration}`)
    }
    if (lesson.videoUrl !== `https://www.youtube.com/watch?v=${video.id}`) {
      problems.push(`${lesson._id}: videoUrl does not match videos.json id ${video.id}`)
    }
  }
  if (!Array.isArray(lesson.notes) || lesson.notes.length === 0) problems.push(`${lesson._id}: notes are empty`)
  for (const r of lesson.resources ?? []) {
    if (!RESOURCE_TYPES.has(r.type)) problems.push(`${lesson._id}: resource type "${r.type}" is invalid`)
  }
}

const fmt = (s) => `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`
for (const row of rows) {
  console.log(`${row.course.title} — ${row.modules.length} modules, ${row.lessons} lessons, ${fmt(row.seconds)}`)
  row.modules.forEach((m, i) => console.log(`  ${i + 1}. ${m.title} — ${m.lessons} lessons, ${fmt(m.seconds)}`))
}
const counts = Object.fromEntries(Object.keys(FIELDS).map((t) => [t, docs.filter((d) => d._type === t).length]))
console.log('\nDocuments:', JSON.stringify(counts))

if (problems.length) {
  console.error(`\n${problems.length} problem(s):`)
  for (const p of problems) console.error(` - ${p}`)
  process.exit(1)
}
console.log('OK: seed is consistent with the schema and all relations resolve.')
