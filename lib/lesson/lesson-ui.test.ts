import assert from 'node:assert/strict'
import {describe, it} from 'node:test'

import type {ResolvedCitation} from '../ai/contracts.ts'
import {citationText, groupCitations, type SourcedCitation} from './citations.ts'
import {decideLessonFeatures} from './features.ts'
import {helpActions, tutorHelpActions} from './help-actions.ts'

function citation(chunkId: string, lessonId: string, startSeconds: number, endSeconds: number): ResolvedCitation {
  return {
    chunkId,
    lessonId,
    sourceRevision: `rev-${chunkId}`,
    startSeconds,
    endSeconds,
    label: `${lessonId === 'lesson-a' ? 'Hooks' : 'Effects'} · ${Math.floor(startSeconds / 60)}:${String(startSeconds % 60).padStart(2, '0')}`,
    href: `/lessons/${lessonId}?t=${startSeconds}`,
  }
}

describe('groupCitations', () => {
  it('merges contiguous same-lesson citations into one range that seeks to the first start, keeping every id', () => {
    const groups = groupCitations([
      citation('c1', 'lesson-a', 60, 75),
      citation('c2', 'lesson-a', 75, 90),
      citation('c3', 'lesson-a', 88, 100),
      citation('c4', 'lesson-a', 130, 140),
      citation('c5', 'lesson-b', 140, 150),
    ])
    assert.deepEqual(
      groups.map(({lessonId, startSeconds, endSeconds, href, chunkIds}) => [lessonId, startSeconds, endSeconds, href, chunkIds]),
      [
        ['lesson-a', 60, 100, '/lessons/lesson-a?t=60', ['c1', 'c2', 'c3']],
        ['lesson-a', 130, 140, '/lessons/lesson-a?t=130', ['c4']],
        ['lesson-b', 140, 150, '/lessons/lesson-b?t=140', ['c5']],
      ],
    )
  })

  it('never merges across lessons even when the times touch', () => {
    const groups = groupCitations([citation('c1', 'lesson-a', 10, 20), citation('c2', 'lesson-b', 20, 30), citation('c3', 'lesson-a', 30, 40)])
    assert.equal(groups.length, 3)
  })

  it('shows a range in this lesson and the server label for another lesson', () => {
    const [here, there] = groupCitations([citation('c1', 'lesson-a', 60, 75), citation('c2', 'lesson-a', 75, 125), citation('c3', 'lesson-b', 5, 9)])
    assert.equal(citationText(here, 'lesson-a'), '1:00–2:05')
    assert.equal(citationText(there, 'lesson-a'), 'Effects · 0:05')
    assert.equal(citationText(groupCitations([citation('c', 'lesson-a', 7, 7)])[0], 'lesson-a'), '0:07')
  })

  const sourced = (base: ResolvedCitation, source: SourcedCitation['source']): SourcedCitation => ({...base, source})

  it('marks a group visual only for validated on-screen evidence (ocr or vlm)', () => {
    const groups = groupCitations([
      citation('c1', 'lesson-a', 10, 20),
      sourced(citation('c2', 'lesson-a', 30, 40), 'transcript'),
      sourced(citation('c3', 'lesson-a', 50, 55), 'ocr'),
      sourced(citation('c4', 'lesson-a', 70, 75), 'vlm'),
    ])
    assert.deepEqual(
      groups.map((group) => group.kind),
      ['transcript', 'transcript', 'visual', 'visual'],
    )
  })

  it('never merges spoken and on-screen evidence into one button, even when the times touch', () => {
    const groups = groupCitations([
      sourced(citation('c1', 'lesson-a', 10, 20), 'transcript'),
      sourced(citation('c2', 'lesson-a', 20, 30), 'ocr'),
      sourced(citation('c3', 'lesson-a', 30, 40), 'vlm'),
    ])
    assert.deepEqual(
      groups.map(({kind, chunkIds}) => [kind, chunkIds]),
      [
        ['transcript', ['c1']],
        ['visual', ['c2', 'c3']],
      ],
    )
  })
})

describe('decideLessonFeatures', () => {
  const ALL = {lessonIntegration: true, learnerEvidence: true, helpPolicy: true, tutor: true}
  const decide = (flags: Partial<typeof ALL>, provider: string | null = 'youtube', checkItems = 2) =>
    decideLessonFeatures({flags: {...ALL, ...flags}, provider, checkItems})

  it('turns everything on only with every flag, a YouTube video, and reviewed items', () => {
    assert.deepEqual(decide({}), {check: true, hints: true, tutor: true, tutorUnavailable: null})
  })

  it('hides everything when lesson-integration or learner-evidence is off', () => {
    for (const off of [{lessonIntegration: false}, {learnerEvidence: false}]) {
      assert.deepEqual(decide(off), {check: false, hints: false, tutor: false, tutorUnavailable: 'rollout'})
    }
  })

  it('degrades one prerequisite at a time', () => {
    assert.deepEqual(decide({helpPolicy: false}), {check: true, hints: false, tutor: false, tutorUnavailable: 'rollout'})
    assert.deepEqual(decide({tutor: false}), {check: true, hints: true, tutor: false, tutorUnavailable: 'rollout'})
    assert.deepEqual(decide({}, 'vimeo'), {check: true, hints: true, tutor: false, tutorUnavailable: 'provider'})
    assert.deepEqual(decide({}, 'youtube', 0), {check: false, hints: false, tutor: true, tutorUnavailable: null})
  })

  it('blames the video only when every flag is on, so a flag-off learner never hears about providers', () => {
    assert.equal(decide({tutor: false}, 'vimeo').tutorUnavailable, 'rollout')
    assert.equal(decide({}, null).tutorUnavailable, 'provider')
  })
})

const requests = (actions: ReturnType<typeof helpActions>) => actions.map((action) => `${action.request}:${action.label}`)

describe('helpActions', () => {
  it('climbs hint → another hint | explanation → explanation, and never labels the solution a hint', () => {
    assert.deepEqual(requests(helpActions({level: 0})), ['hint:Get a hint'])
    assert.deepEqual(requests(helpActions({level: 1})), ['escalate:Another hint', 'solution:Show the explanation'])
    assert.deepEqual(requests(helpActions({level: 2})), ['solution:Show the explanation'])
    assert.deepEqual(requests(helpActions({level: 3})), [])
  })

  it('after grading offers only the explanation, and only after a miss that has not seen it', () => {
    assert.deepEqual(requests(helpActions({level: 0, answered: true, correct: false})), ['solution:Show the explanation'])
    assert.deepEqual(requests(helpActions({level: 2, answered: true, correct: false})), ['solution:Show the explanation'])
    assert.deepEqual(requests(helpActions({level: 0, answered: true, correct: true})), [])
    assert.deepEqual(requests(helpActions({level: 3, answered: true, correct: false})), [])
  })

  it('offers no tutor escalation on a clarifying question or a full explanation', () => {
    assert.deepEqual(requests(tutorHelpActions(0)), [])
    assert.deepEqual(requests(tutorHelpActions(1)), ['escalate:Another hint', 'solution:Show the explanation'])
    assert.deepEqual(requests(tutorHelpActions(3)), [])
  })
})
