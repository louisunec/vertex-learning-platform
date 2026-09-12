import {visionTool} from '@sanity/vision'
import {contextPlugin} from '@sanity/context/studio'
import {defineConfig} from 'sanity'
import {structureTool} from 'sanity/structure'

import {gatePublish, publishBlockReason, type PublishBlockReason} from './actions/assessment-publish'
import {conceptPublishBlockReason, keepUnpublishedDrafts, prerequisitePublishBlockReason} from './actions/concept-publish'
import {schemaTypes} from './schemaTypes'
import {structure} from './structure'

const GENERATOR_ONLY_TYPES = new Set([
  'assessment',
  'assessmentGenerationRecord',
  'concept',
  'conceptPrerequisite',
  'conceptMergeProposal',
  'conceptGenerationRecord',
])

/** Types whose publish is gated on editorial review. */
const PUBLISH_GATES: Record<string, PublishBlockReason> = {
  assessment: publishBlockReason,
  concept: conceptPublishBlockReason,
  conceptPrerequisite: prerequisitePublishBlockReason,
}

/** Concept ids are stable and retired concepts stay as tombstones, so concepts are never deleted or unpublished. */
const PERMANENT_TYPES = new Set(['concept'])

/** Generated drafts that are kept for audit even when rejected: discarding a never-published one is disabled. */
const AUDITED_DRAFT_TYPES = new Set(['concept', 'conceptPrerequisite'])

/**
 * Merge proposals are decided by their status on the draft: never published
 * (or scheduled), duplicated, or deleted — discarding a never-published draft
 * deletes it (audit).
 */
const PROPOSAL_REMOVED_ACTIONS = new Set(['publish', 'schedule', 'duplicate', 'delete', 'unpublish', 'discardChanges'])

const projectId = process.env.SANITY_STUDIO_PROJECT_ID
const dataset = process.env.SANITY_STUDIO_DATASET

if (!projectId || !dataset) {
  throw new Error('Missing SANITY_STUDIO_PROJECT_ID or SANITY_STUDIO_DATASET (see studio/.env.example)')
}

export default defineConfig({
  name: 'vertex',
  title: 'Vertex',
  projectId,
  dataset,
  schema: {types: schemaTypes},
  document: {
    // Assessments, concepts, prerequisite edges, and their generation records
    // are created only by the generators (`npm run generate:assessments`,
    // `npm run generate:concepts`): each needs server-resolved source chunks,
    // so a hand-made one could never be published.
    newDocumentOptions: (prev) => prev.filter((item) => !GENERATOR_ONLY_TYPES.has(item.templateId)),
    // Gated types publish only after review; approved content stays immutable.
    // Scheduling would publish later without the gate. Duplicating would copy
    // source refs and stable ids into an off-scheme document.
    actions: (prev, context) => {
      if (context.schemaType === 'conceptMergeProposal') {
        return prev.filter((action) => !PROPOSAL_REMOVED_ACTIONS.has(action.action ?? ''))
      }
      const gate = PUBLISH_GATES[context.schemaType]
      if (!gate) return prev
      const permanent = PERMANENT_TYPES.has(context.schemaType)
      const audited = AUDITED_DRAFT_TYPES.has(context.schemaType)
      return prev
        .filter((action) => action.action !== 'duplicate' && action.action !== 'schedule')
        .filter((action) => !permanent || (action.action !== 'delete' && action.action !== 'unpublish'))
        .map((action) => {
          if (action.action === 'publish') return gatePublish(action, gate)
          if (audited && action.action === 'discardChanges') return keepUnpublishedDrafts(action)
          return action
        })
    },
  },
  plugins: [
    structureTool({structure}),
    visionTool({defaultApiVersion: '2026-08-31'}),
    // Registers the `sanity.agentContext` document type used to configure the
    // search Context MCP endpoint (content scope + query guidance).
    contextPlugin({insights: {enabled: false}}),
  ],
})
