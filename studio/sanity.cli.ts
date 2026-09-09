/**
 * CLI configuration for the standalone Vertex Studio workspace.
 * Run `npx sanity <command>` from inside `studio/`.
 */
import {defineCliConfig} from 'sanity/cli'

export default defineCliConfig({
  api: {
    projectId: process.env.SANITY_STUDIO_PROJECT_ID,
    dataset: process.env.SANITY_STUDIO_DATASET,
  },
})
