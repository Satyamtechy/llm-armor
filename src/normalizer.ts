import type { ZodSchema } from 'zod'
import type { CoercionEntry } from './types'

/**
 * Normalizes raw LLM output string into parseable JSON.
 * Handles: markdown fences, prose wrapping, trailing commas, single quotes.
 */
export function normalizeRawOutput(raw: string): { json: string; repairs: string[] } {
  const repairs: string[] = []
  let text = raw.trim()

  // Strip markdown code fences — try all blocks, pick first valid JSON
  const fenceRegex = /```(?:json[c5]?|javascript|js|JSON)?\s*\n?([\s\S]*?)\n?\s*```/g
  const fenceMatches: string[] = []
  let m: RegExpExecArray | null
  while ((m = fenceRegex.exec(text)) !== null) {
    fenceMatches.push(m[1]!.trim())
  }

  if (fenceMatches.length > 0) {
    // Try each code block — use first one that looks like valid JSON
    let found = false
    for (const block of fenceMatches) {
      const cleaned = stripComments(block)
      if ((cleaned.startsWith('{') || cleaned.startsWith('[')) && isValidJson(cleaned)) {
        text = cleaned
        found = true
        break
      }
    }
    // If none are valid, use the last one (most likely the complete one)
    if (!found) {
      text = stripComments(fenceMatches[fenceMatches.length - 1]!)
    }
    repairs.push('stripped_markdown_fences')
  }

  // Strip JS/JSON comments (// and /* */)
  const beforeComments = text
  text = stripComments(text)
  if (text !== beforeComments) repairs.push('stripped_comments')

  // If text starts with JSON, strip trailing non-JSON prose
  if (text.startsWith('{') || text.startsWith('[')) {
    const closingChar = text.startsWith('{') ? '}' : ']'
    const lastClose = text.lastIndexOf(closingChar)
    if (lastClose !== -1 && lastClose < text.length - 1) {
      text = text.slice(0, lastClose + 1)
      repairs.push('stripped_trailing_prose')
    }
  }

  // Extract JSON block from prose (find first { or [)
  if (!text.startsWith('{') && !text.startsWith('[')) {
    const jsonStart = text.search(/[{[]/)
    if (jsonStart !== -1) {
      const jsonEnd = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'))
      if (jsonEnd > jsonStart) {
        text = text.slice(jsonStart, jsonEnd + 1)
        repairs.push('extracted_json_block')
      }
    }
  }

  // Fix trailing commas before } or ]
  const trailingCommaRegex = /,\s*([}\]])/g
  if (trailingCommaRegex.test(text)) {
    text = text.replace(/,\s*([}\]])/g, '$1')
    repairs.push('removed_trailing_commas')
  }

  // Fix single quotes → double quotes (naive but handles most cases)
  if (!text.includes('"') && text.includes("'")) {
    text = text.replace(/'/g, '"')
    repairs.push('converted_single_quotes')
  }

  // Fix unquoted keys: { key: "value" } → { "key": "value" }
  const unquotedKeys = /(?<=\{|,)\s*([a-zA-Z_]\w*)\s*:/g
  if (unquotedKeys.test(text)) {
    text = text.replace(/(?<=\{|,)\s*([a-zA-Z_]\w*)\s*:/g, '"$1":')
    repairs.push('quoted_keys')
  }

  return { json: text, repairs }
}

/**
 * Attempts to parse a string as JSON. Returns null on failure.
 */
export function safeParse(text: string): unknown | null {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/**
 * Coerces values in a parsed object to match the expected schema types.
 * Returns coerced object + log of all coercions applied.
 */
export function coerceTypes(data: unknown, schema: ZodSchema): { data: unknown; coerced: CoercionEntry[] } {
  if (typeof data !== 'object' || data === null) return { data, coerced: [] }

  const coerced: CoercionEntry[] = []
  const obj = { ...(data as Record<string, unknown>) }

  // Get schema shape if available
  const shape = getSchemaShape(schema)
  if (!shape) return { data, coerced: [] }

  for (const [key, fieldSchema] of Object.entries(shape)) {
    if (!(key in obj)) continue
    const value = obj[key]
    const expectedType = getExpectedType(fieldSchema as ZodSchema)

    if (expectedType === 'number' && typeof value === 'string') {
      const num = extractNumber(value)
      if (num !== null) {
        coerced.push({ field: key, from: value, to: num, rule: detectNumberRule(value) })
        obj[key] = num
      }
    } else if (expectedType === 'boolean' && typeof value === 'string') {
      const bool = coerceBoolean(value)
      if (bool !== null) {
        coerced.push({ field: key, from: value, to: bool, rule: 'truthy_string' })
        obj[key] = bool
      }
    } else if (expectedType === 'array' && typeof value === 'string') {
      // "Bob, Alice" → ["Bob", "Alice"]
      const arr = value.split(/,\s*/).map(s => s.trim()).filter(Boolean)
      coerced.push({ field: key, from: value, to: arr, rule: 'split_csv_string' })
      obj[key] = arr
    }
  }

  return { data: obj, coerced }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function stripComments(text: string): string {
  // Remove comments while preserving strings (that may contain // or /*)
  let result = ''
  let i = 0
  let inString = false
  let stringChar = ''

  while (i < text.length) {
    const ch = text[i]!
    const next = text[i + 1]

    // Handle string boundaries
    if (inString) {
      result += ch
      if (ch === '\\') {
        // Skip escaped character
        i++
        if (i < text.length) result += text[i]
      } else if (ch === stringChar) {
        inString = false
      }
      i++
      continue
    }

    // Start of string
    if (ch === '"' || ch === "'") {
      inString = true
      stringChar = ch
      result += ch
      i++
      continue
    }

    // Single-line comment
    if (ch === '/' && next === '/') {
      // Skip until end of line
      while (i < text.length && text[i] !== '\n') i++
      continue
    }

    // Multi-line comment
    if (ch === '/' && next === '*') {
      i += 2
      while (i < text.length - 1 && !(text[i] === '*' && text[i + 1] === '/')) i++
      i += 2 // skip */
      continue
    }

    result += ch
    i++
  }

  return result.trim()
}

function isValidJson(text: string): boolean {
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

function extractNumber(value: string): number | null {
  // Pattern: "X out of Y", "X/Y" — extract X
  const ratioMatch = value.match(/(-?\d+(?:\.\d+)?)\s*(?:out of|\/)\s*\d+/)
  if (ratioMatch) return parseFloat(ratioMatch[1]!)

  // Pattern: currency "$1,234.56" — strip symbol and commas
  const currencyMatch = value.match(/[£$€¥]?\s*(-?\d{1,3}(?:,\d{3})*(?:\.\d+)?)/)
  if (currencyMatch) {
    const num = parseFloat(currencyMatch[1]!.replace(/,/g, ''))
    if (!isNaN(num)) return num
  }

  // Fallback: first number in string
  const match = value.match(/-?\d+(?:\.\d+)?/)
  if (!match) return null
  const num = parseFloat(match[0])
  return isNaN(num) ? null : num
}

function detectNumberRule(value: string): string {
  if (/^\$|€|£|¥/.test(value) || /\$/.test(value)) return 'currency_strip'
  if (/out of|\//.test(value)) return 'extract_number'
  if (/[a-zA-Z]/.test(value)) return 'text_to_number'
  return 'string_to_number'
}

function coerceBoolean(value: string): boolean | null {
  const lower = value.toLowerCase().trim()
  if (['true', 'yes', '1', 'on', 'enabled', 'active'].includes(lower)) return true
  if (['false', 'no', '0', 'off', 'disabled', 'inactive'].includes(lower)) return false
  return null
}

function getSchemaShape(schema: ZodSchema): Record<string, ZodSchema> | null {
  const def = (schema as { _def?: { shape?: () => Record<string, ZodSchema>; typeName?: string } })._def
  if (def?.typeName === 'ZodObject' && def.shape) {
    return def.shape()
  }
  return null
}

function getExpectedType(schema: ZodSchema): string | null {
  const def = (schema as { _def?: { typeName?: string; innerType?: ZodSchema } })._def
  if (!def?.typeName) return null

  const typeMap: Record<string, string> = {
    ZodString: 'string',
    ZodNumber: 'number',
    ZodBoolean: 'boolean',
    ZodArray: 'array',
    ZodEnum: 'string',
  }

  // Unwrap optional/nullable
  if (def.typeName === 'ZodOptional' || def.typeName === 'ZodNullable') {
    return def.innerType ? getExpectedType(def.innerType) : null
  }

  return typeMap[def.typeName] ?? null
}
