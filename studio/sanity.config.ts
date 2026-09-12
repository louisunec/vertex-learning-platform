import {visionTool} from '@sanity/vision'
import {contextPlugin} from '@sanity/context/studio'
import {defineConfig} from 'sanity'
import {structureTool} from 'sanity/structure'

import {gatePublish} from './actions/assessment-publish'
import {schemaTypes} from './schemaTypes'
import {structure} from './structure'

const GENERATOR_ONLY_TYPES = new Set(['assessment', 'assessmentGenerationRecord'])

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
    // Assessments and generation records are created only by the generator
    // (`npm run generate:assessments`): an assessment needs server-resolved
    // source chunks, so a hand-made one could never be published.
    newDocumentOptions: (prev) => prev.filter((item) => !GENERATOR_ONLY_TYPES.has(item.templateId)),
    // Assessments publish only after review; approved versions stay immutable.
    // Duplicating would copy source refs and family id into an off-scheme document.
    actions: (prev, context) =>
      context.schemaType === 'assessment'
        ? prev
            .filter((action) => action.action !== 'duplicate')
            .map((action) => (action.action === 'publish' ? gatePublish(action) : action))
        : prev,
  },
  plugins: [
    structureTool({structure}),
    visionTool({defaultApiVersion: '2026-08-31'}),
    // Registers the `sanity.agentContext` document type used to configure the
    // search Context MCP endpoint (content scope + query guidance).
    contextPlugin({insights: {enabled: false}}),
  ],
})
