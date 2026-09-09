import {visionTool} from '@sanity/vision'
import {contextPlugin} from '@sanity/context/studio'
import {defineConfig} from 'sanity'
import {structureTool} from 'sanity/structure'

import {schemaTypes} from './schemaTypes'
import {structure} from './structure'

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
  plugins: [
    structureTool({structure}),
    visionTool({defaultApiVersion: '2026-08-31'}),
    // Registers the `sanity.agentContext` document type used to configure the
    // search Context MCP endpoint (content scope + query guidance).
    contextPlugin({insights: {enabled: false}}),
  ],
})
