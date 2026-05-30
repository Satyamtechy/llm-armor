import type { ZodSchema, ZodError } from 'zod'
import type { ProviderAdapter, ProviderCallOptions, ProviderMessage, ValidationError } from './types'
import { normalizeRawOutput, safeParse, coerceTypes } from './normalizer'
import type { CoercionEntry } from './types'

export interface RetryContext {
  schema: ZodSchema
  provider: ProviderAdapter
  callOptions: ProviderCallOptions
  systemPrompt: string
  userPrompt: string
  maxRetries: number
  coerce: boolean
}

export interface RetryResult {
  success: boolean
  data: unknown
  rawOutput: string
  attempts: number
  latency: number
  coerced: CoercionEntry[]
  repaired: string[]
  errors?: ValidationError[]
}

/**
 * Executes LLM call with validation, auto-repair prompt on failure, and retries.
 */
export async function executeWithRetry(ctx: RetryContext): Promise<RetryResult> {
  let attempts = 0
  let totalLatency = 0
  let lastRaw = ''
  let lastErrors: ValidationError[] = []
  let allRepairs: string[] = []
  let allCoerced: CoercionEntry[] = []

  const messages: ProviderMessage[] = [
    { role: 'system', content: ctx.systemPrompt },
    { role: 'user', content: ctx.userPrompt },
  ]

  while (attempts <= ctx.maxRetries) {
    attempts++

    const response = await ctx.provider.call(messages, ctx.callOptions)
    totalLatency += response.latency
    lastRaw = response.content

    // Normalize raw output
    const { json, repairs } = normalizeRawOutput(lastRaw)
    allRepairs = [...new Set([...allRepairs, ...repairs])]

    // Parse JSON
    let parsed = safeParse(json)
    if (parsed === null) {
      lastErrors = [{ path: '', message: 'Invalid JSON', expected: 'object', received: json.slice(0, 100) }]
      // Add repair prompt and retry
      messages.push(
        { role: 'assistant', content: lastRaw },
        { role: 'user', content: buildRepairPrompt(lastErrors) }
      )
      continue
    }

    // Coerce types if enabled
    if (ctx.coerce) {
      const coercion = coerceTypes(parsed, ctx.schema)
      parsed = coercion.data
      allCoerced = [...allCoerced, ...coercion.coerced]
    }

    // Validate against schema
    const validation = ctx.schema.safeParse(parsed)
    if (validation.success) {
      return {
        success: true,
        data: validation.data,
        rawOutput: lastRaw,
        attempts,
        latency: totalLatency,
        coerced: allCoerced,
        repaired: allRepairs,
      }
    }

    // Validation failed — build repair prompt
    lastErrors = formatZodErrors(validation.error)
    messages.push(
      { role: 'assistant', content: lastRaw },
      { role: 'user', content: buildRepairPrompt(lastErrors) }
    )
  }

  return {
    success: false,
    data: null,
    rawOutput: lastRaw,
    attempts,
    latency: totalLatency,
    coerced: allCoerced,
    repaired: allRepairs,
    errors: lastErrors,
  }
}

/**
 * Builds a repair prompt that tells the model exactly what failed.
 */
function buildRepairPrompt(errors: ValidationError[]): string {
  const errorList = errors
    .map((e, i) => `${i + 1}. '${e.path}' — ${e.message} (expected: ${e.expected}, got: ${e.received})`)
    .join('\n')

  return `Your previous response had validation errors:\n${errorList}\n\nPlease fix these specific fields and return ONLY valid JSON. No markdown, no explanation.`
}

/**
 * Converts Zod errors into our ValidationError format.
 */
function formatZodErrors(error: ZodError): ValidationError[] {
  return error.issues.map(issue => ({
    path: issue.path.join('.'),
    message: issue.message,
    expected: 'expected' in issue ? String(issue.expected) : 'unknown',
    received: 'received' in issue ? String(issue.received) : 'unknown',
  }))
}
