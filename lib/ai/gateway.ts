import {
  generateText,
  NoObjectGeneratedError,
  NoOutputGeneratedError,
  Output,
  type LanguageModel,
  type LanguageModelUsage,
  type ModelMessage,
} from 'ai'
import type {z} from 'zod'

import {AI_GATEWAY_TIMEOUT_MS} from '../timeouts.ts'

/**
 * Bounded structured model calls (development plan §3, PR-0). Every call has a
 * timeout, at most one provider retry, an output-token cap, and a typed
 * failure category, so callers can tell a provider outage from unusable
 * output and never turn either into a successful empty result.
 *
 * Framework-free on purpose (no env reads, no credentials — the model is
 * injected) so `node --test` can load it; the modules that create providers
 * keep `server-only`. Diagnostics carry versions and usage only, never the
 * prompt, the learner's text, or the model output.
 */

export type AiFailureCategory = 'timeout' | 'provider_error' | 'invalid_output'

/** A failed model call, classified for the caller's error handling. */
export class AiCallError extends Error {
  readonly category: AiFailureCategory

  constructor(category: AiFailureCategory, message: string, options?: {cause?: unknown}) {
    super(message, options)
    this.name = 'AiCallError'
    this.category = category
  }
}

export type AiCallVersions = {
  /** Stable name of the calling task, e.g. `search-interpretation`. */
  task: string
  /** Bumped whenever the task's prompt or schema changes. */
  promptVersion: string
}

export type AiCallDiagnostics = AiCallVersions & {
  modelId: string
  status: 'ok' | AiFailureCategory
  latencyMs: number
  inputTokens: number | null
  outputTokens: number | null
}

/** Provider-level retries (transient API errors only); output is never repaired here. */
export const MAX_PROVIDER_RETRIES = 1

/** Logs one line per call: versions, status, latency, and usage — no raw text. */
export function logAiDiagnostics(diagnostics: AiCallDiagnostics): void {
  const line = `[ai] ${JSON.stringify(diagnostics)}`
  if (diagnostics.status === 'ok') console.info(line)
  else console.warn(line)
}

/** One image sent with the text prompt (e.g. a video frame for a vision-capable model). */
export type BoundedImage = {data: Uint8Array; mediaType: 'image/png' | 'image/jpeg'}

type GenerateBoundedObjectOptions<T> = {
  model: LanguageModel
  schema: z.ZodType<T>
  system: string
  prompt: string
  /** At most one image; the model must support image input. Never logged. */
  image?: BoundedImage
  maxOutputTokens: number
  timeoutMs?: number
  /** Provider-specific settings (e.g. OpenAI reasoning effort), passed through unchanged. */
  providerOptions?: Parameters<typeof generateText>[0]['providerOptions']
  versions: AiCallVersions
  /** Diagnostics sink; defaults to `logAiDiagnostics`. */
  log?: (diagnostics: AiCallDiagnostics) => void
}

/**
 * Generates one schema-validated object. Resolves only with output that passed
 * `schema`; otherwise rejects with an `AiCallError`.
 */
export async function generateBoundedObject<T>({
  model,
  schema,
  system,
  prompt,
  image,
  maxOutputTokens,
  timeoutMs = AI_GATEWAY_TIMEOUT_MS,
  providerOptions,
  versions,
  log = logAiDiagnostics,
}: GenerateBoundedObjectOptions<T>): Promise<T> {
  const startedAt = Date.now()
  const report = (status: AiCallDiagnostics['status'], usage: LanguageModelUsage | undefined) =>
    log({
      ...versions,
      modelId: typeof model === 'string' ? model : model.modelId,
      status,
      latencyMs: Date.now() - startedAt,
      inputTokens: usage?.inputTokens ?? null,
      outputTokens: usage?.outputTokens ?? null,
    })

  try {
    const result = await generateText({
      model,
      output: Output.object({schema}),
      system,
      prompt: image ? withImage(prompt, image) : prompt,
      maxOutputTokens,
      maxRetries: MAX_PROVIDER_RETRIES,
      timeout: timeoutMs,
      providerOptions,
    })
    // `output` is a getter that throws NoOutputGeneratedError when absent.
    const output = result.output as T
    report('ok', result.usage)
    return output
  } catch (error) {
    const category = classifyFailure(error)
    report(category, NoObjectGeneratedError.isInstance(error) ? error.usage : undefined)
    throw new AiCallError(category, `${versions.task} model call failed (${category})`, {cause: error})
  }
}

/** One user message carrying the text prompt followed by the image. */
function withImage(prompt: string, image: BoundedImage): ModelMessage[] {
  return [
    {
      role: 'user',
      content: [
        {type: 'text', text: prompt},
        {type: 'image', image: image.data, mediaType: image.mediaType},
      ],
    },
  ]
}

/** Maps SDK/provider errors onto the three failure categories. */
function classifyFailure(error: unknown): AiFailureCategory {
  if (NoObjectGeneratedError.isInstance(error) || NoOutputGeneratedError.isInstance(error)) {
    return 'invalid_output'
  }
  if (isAbortError(error)) return 'timeout'
  return 'provider_error'
}

function isAbortError(error: unknown): boolean {
  for (let current = error, depth = 0; current instanceof Error && depth < 4; depth++) {
    if (current.name === 'AbortError' || current.name === 'TimeoutError') return true
    current = (current as {cause?: unknown}).cause
  }
  return false
}
