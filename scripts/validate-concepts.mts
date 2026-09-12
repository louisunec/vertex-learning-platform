import {assessmentCoverage, validateGraph, type GraphConcept, type GraphEdge} from '../lib/concepts/graph.ts'
import {createSanityHttp} from './sanity-http.mts'

/**
 * Read-only integrity and coverage check of the published concept graph
 * (development plan §5 PR-3). Writes nothing and calls no model.
 *
 *   npm run validate:concepts -- --course <slug>
 *
 * Reports active-graph defects (self-edges, duplicate pairs, dangling,
 * inactive, or inaccessible endpoints, cycles) for edges touching the
 * course's concepts, and assessment coverage: approved concepts no approved
 * item resolves to, items without a primary concept (with chunk-overlap
 * suggestions, never applied), links resolved through merges, and links to
 * split concepts that need reconciliation. Exits 1 on any graph defect.
 */

const slug = parseArgs(process.argv.slice(2))
const sanity = createSanityHttp()

type ConceptRow = {
  _id: string
  conceptId: string
  reviewStatus: string
  mergedInto: string | null
  splitInto: string[] | null
  lessons: string[] | null
  sourceChunkIds: string[] | null
}

const course = await sanity.groq<{_id: string; title: string; lessonIds: string[] | null} | null>(
  '*[_type == "course" && slug.current == $slug][0]{_id, title, "lessonIds": modules[].lessons[]._ref}',
  {slug},
  'published',
)
if (!course) {
  console.error(`No published course "${slug}".`)
  process.exit(1)
}
const lessonIds = new Set(course.lessonIds ?? [])

const [conceptRows, edgeRows, publishedLessonIds, assessments] = await Promise.all([
  sanity.groq<ConceptRow[] | null>(
    '*[_type == "concept"]{_id, conceptId, reviewStatus, "mergedInto": mergedInto._ref, "splitInto": splitInto[]._ref, "lessons": lessons[]._ref, "sourceChunkIds": sourceRefs[].chunkId}',
    {},
    'published',
  ),
  sanity.groq<GraphEdge[] | null>(
    '*[_type == "conceptPrerequisite"]{"id": _id, status, "prerequisite": prerequisite._ref, "dependent": dependent._ref}',
    {},
    'published',
  ),
  sanity.groq<string[] | null>('*[_type == "course" && defined(slug.current)].modules[].lessons[]._ref', {}, 'published'),
  sanity.groq<Array<{id: string; primaryConcept: string | null; sourceChunkIds: string[] | null}> | null>(
    '*[_type == "assessment" && lesson._ref in $lessonIds && reviewStatus == "approved" && sourceStatus == "current"]{"id": _id, "primaryConcept": primaryConcept._ref, "sourceChunkIds": sourceChunkRefs[].chunkId}',
    {lessonIds: [...lessonIds]},
    'published',
  ),
])

const accessibleLessons = new Set(publishedLessonIds ?? [])
const concepts: Array<GraphConcept & {sourceChunkIds: string[]}> = (conceptRows ?? []).map((row) => ({
  id: row._id,
  conceptId: row.conceptId,
  reviewStatus: row.reviewStatus,
  mergedInto: row.mergedInto,
  splitInto: row.splitInto ?? [],
  accessible: (row.lessons ?? []).some((lesson) => accessibleLessons.has(lesson)),
  sourceChunkIds: row.sourceChunkIds ?? [],
}))
const inCourse = new Set(
  (conceptRows ?? []).filter((row) => (row.lessons ?? []).some((lesson) => lessonIds.has(lesson))).map((row) => row._id),
)
const edges = (edgeRows ?? []).filter(
  (edge) => (edge.prerequisite && inCourse.has(edge.prerequisite)) || (edge.dependent && inCourse.has(edge.dependent)),
)

const graph = validateGraph({concepts, edges})
const coverage = assessmentCoverage({
  scope: [...inCourse],
  concepts,
  assessments: (assessments ?? []).map((row) => ({...row, sourceChunkIds: row.sourceChunkIds ?? []})),
})

const byStatus = (status: string) => concepts.filter((concept) => inCourse.has(concept.id) && concept.reviewStatus === status).length
console.log(`${course.title}: ${inCourse.size} published concept(s) — ${byStatus('approved')} approved, ${byStatus('merged') + byStatus('split') + byStatus('archived')} tombstone(s)`)
console.log(`${edges.length} published edge(s) touching the course, ${graph.activeEdges} active (approved)`)
console.log(`${(assessments ?? []).length} approved current assessment(s)\n`)

console.log(graph.defects.length === 0 ? 'Graph: no defects' : `Graph: ${graph.defects.length} defect(s)`)
for (const defect of graph.defects) console.log(`  ${defect.code.padEnd(22)} ${defect.detail}  [${defect.edgeIds.join(', ')}]`)

console.log('\nCoverage:')
console.log(`  approved concepts without an approved assessment: ${coverage.uncovered.join(', ') || 'none'}`)
console.log(`  assessments without a primary concept: ${coverage.unlinked.length}`)
for (const entry of coverage.unlinked) console.log(`    ${entry.assessmentId}: suggest ${entry.suggestions.join(', ') || '(no chunk overlap)'}`)
for (const entry of coverage.viaMerge) console.log(`  ${entry.assessmentId}: ${entry.from} resolves through a merge to ${entry.to}`)
for (const entry of coverage.needsReconciliation) console.log(`  ${entry.assessmentId}: ${entry.conceptId} was split into ${entry.into.join(', ')} — reconcile`)
for (const entry of coverage.unresolved) console.log(`  ${entry.assessmentId}: ${entry.conceptId} does not resolve (${entry.reason})`)

process.exit(graph.defects.length > 0 ? 1 : 0)

function parseArgs(argv: string[]): string {
  if (argv.length === 2 && argv[0] === '--course' && argv[1]) return argv[1]
  console.error('Usage: validate-concepts --course <slug>')
  process.exit(1)
}
