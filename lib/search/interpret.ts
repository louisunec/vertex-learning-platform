import 'server-only'

import {openai} from '@ai-sdk/openai'
import {generateObject} from 'ai'
import {z} from 'zod'

import {generateBoundedObject} from '@/lib/ai/gateway'
import {FLAGS, isFlagEnabled} from '@/lib/flags'
import {sanityFetch} from '@/sanity/lib/fetch'
import {fallbackTerms, sanitizeTerms} from './terms'

/**
 * Query interpretation (SEARCH.md §3.1). The LLM's only job is turning the
 * learner's natural-language query into keyword variants that parameterize
 * grounded retrieval. It never authors GROQ, never orders results, and its
 * output is sanitized to safe tokens before touching a query.
 *
 * On any failure (missing key, model error, empty output) interpretation
 * degrades to the deterministic tokenizer — retrieval stays grounded.
 */

const INTERPRETATION_MODEL = 'gpt-5-mini'
/** Bump when BASE_SYSTEM_PROMPT or the interpretation schema changes. */
const INTERPRETATION_PROMPT_VERSION = 'search-interpretation-v1'
/** Budget covers gpt-5-mini reasoning tokens. */
const INTERPRETATION_MAX_OUTPUT_TOKENS = 1000

const interpretationSchema = z.object({
  keywords: z
    .array(z.string())
    .max(10)
    .describe('Lowercase single-word search terms: the query’s core concepts plus close variants/synonyms.'),
})

/**
 * The inline prompt is the primary instruction surface for critical rules
 * (AGENTS.md §10); the Context document's instructions are appended as
 * tunable guidance. Note: escape backticks if template literals ever carry
 * GROQ examples here.
 */
const BASE_SYSTEM_PROMPT = [
  'You interpret search queries for Vertex, a video-course learning platform.',
  'Given a learner query, extract the concepts to retrieve with keyword matching over lesson titles, key points, notes, video chapter labels, and transcript chunks.',
  'Rules:',
  '- Return only keywords derived from the query and its close technical synonyms or word variants.',
  '- Never invent course names, lesson names, instructors, or facts; you are not answering the query.',
  '- Keywords are lowercase single words (letters, digits, hyphens); prefer specific terms over generic ones.',
  '- Do not include filler words (how, learn, video, course, tutorial).',
].join('\n')

/**
 * Context document instructions + a small grounded vocabulary. Cached by
 * `sanityFetch` (~60s); prompt/Context edits may need that window or a server
 * restart to take effect (SEARCH.md §12).
 */
async function fetchPromptContext(): Promise<string> {
  const slug = process.env.SANITY_CONTEXT_SLUG?.trim()
  try {
    const [instructions, vocabulary] = await Promise.all([
      slug
        ? (sanityFetch({
            query: /* groq */ `*[_type == "sanity.agentContext" && slug.current == $slug][0].instructions`,
            params: {slug},
            tags: [],
          }) as Promise<unknown>)
        : Promise.resolve(null),
      sanityFetch({
        query: /* groq */ `{
          "courses": *[_type == "course"].title,
          "categories": *[_type == "category"].title
        }`,
        tags: ['sanity:course', 'sanity:category'],
      }) as Promise<unknown>,
    ])
    const parts: string[] = []
    if (typeof instructions === 'string' && instructions.trim()) {
      parts.push(`Content guidance:\n${instructions.trim()}`)
    }
    const vocab = vocabulary as {courses?: unknown; categories?: unknown} | null
    const titles = [vocab?.courses, vocab?.categories]
      .flatMap((list) => (Array.isArray(list) ? list : []))
      .filter((title): title is string => typeof title === 'string')
    if (titles.length > 0) {
      parts.push(`The platform currently covers: ${titles.join('; ')}.`)
    }
    return parts.join('\n\n')
  } catch {
    return ''
  }
}

/**
 * Interpreted, sanitized retrieval terms for a learner query. `distinctId`
 * (Clerk user id or `"anonymous"`) only selects the `ai-gateway-search` flag
 * variant; it is never sent to the model.
 */
export async function interpretQuery(query: string, {distinctId}: {distinctId: string}): Promise<string[]> {
  const fallback = fallbackTerms(query)
  if (!process.env.OPENAI_API_KEY) return fallback
  try {
    const [promptContext, useGateway] = await Promise.all([
      fetchPromptContext(),
      isFlagEnabled(FLAGS.aiGatewaySearch, distinctId),
    ])
    const system = promptContext ? `${BASE_SYSTEM_PROMPT}\n\n${promptContext}` : BASE_SYSTEM_PROMPT
    const prompt = `Learner query: ${JSON.stringify(query)}`
    // The gpt-5 family rejects non-default temperature, so none is set
    // (output is sanitized anyway).
    const {keywords} = useGateway
      ? await generateBoundedObject({
          model: openai(INTERPRETATION_MODEL),
          schema: interpretationSchema,
          system,
          prompt,
          maxOutputTokens: INTERPRETATION_MAX_OUTPUT_TOKENS,
          // Timeout: the gateway default (AI_GATEWAY_TIMEOUT_MS, lib/timeouts.ts);
          // past it, search proceeds on deterministic terms.
          versions: {task: 'search-interpretation', promptVersion: INTERPRETATION_PROMPT_VERSION},
        })
      : // Pre-PR-0 path, kept while the flag is off as the rollback target.
        (
          await generateObject({
            model: openai(INTERPRETATION_MODEL),
            schema: interpretationSchema,
            system,
            prompt,
            maxOutputTokens: INTERPRETATION_MAX_OUTPUT_TOKENS,
          })
        ).object
    // Keep the deterministic tokens in front so the learner's own words always
    // participate; model variants widen recall behind them.
    const terms = sanitizeTerms([...fallback, ...keywords])
    return terms.length > 0 ? terms : fallback
  } catch {
    return fallback
  }
}
