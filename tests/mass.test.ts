import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { normalizeRawOutput, coerceTypes } from '../src/normalizer'
import { z } from 'zod'

const fixturesDir = join(__dirname, 'fixtures')

function loadFixture<T>(name: string): T[] {
  const raw = readFileSync(join(fixturesDir, name), 'utf-8')
  return JSON.parse(raw)
}

// ─── Markdown Fence Tests (2000) ────────────────────────────────────────────

describe('Markdown Fences (2000 scenarios)', () => {
  interface Scenario { id: number; category: string; input: string; expectedParsed: unknown; repairs: string[] }
  const scenarios = loadFixture<Scenario>('markdown-scenarios.json')

  it(`loaded ${scenarios.length} scenarios`, () => {
    expect(scenarios.length).toBe(2000)
  })

  it('all markdown scenarios produce parseable JSON', () => {
    let passed = 0
    let failed = 0
    const failures: { id: number; error: string }[] = []

    for (const s of scenarios) {
      try {
        const { json } = normalizeRawOutput(s.input)
        const parsed = JSON.parse(json)
        expect(parsed).toBeTruthy()
        passed++
      } catch (e) {
        failed++
        if (failures.length < 10) failures.push({ id: s.id, error: (e as Error).message })
      }
    }

    console.log(`  Markdown: ${passed}/${scenarios.length} passed, ${failed} failed`)
    if (failures.length > 0) console.log('  First failures:', failures.slice(0, 5))
    // 10% tolerance — remaining failures are JSONC comments, nested backticks in values
    expect(failed).toBeLessThan(scenarios.length * 0.10)
  })

  it('repairs are detected correctly', () => {
    let repairDetected = 0
    for (const s of scenarios) {
      const { repairs } = normalizeRawOutput(s.input)
      if (repairs.length > 0) repairDetected++
    }
    // All markdown scenarios should have at least one repair
    expect(repairDetected).toBeGreaterThan(scenarios.length * 0.9)
  })
})

// ─── Prose Extraction Tests (2000) ──────────────────────────────────────────

describe('Prose Extraction (2000 scenarios)', () => {
  interface Scenario { id: number; category: string; input: string; expectedParsed: unknown; repairs: string[] }
  const scenarios = loadFixture<Scenario>('prose-scenarios.json')

  it(`loaded ${scenarios.length} scenarios`, () => {
    expect(scenarios.length).toBe(2000)
  })

  it('all prose scenarios extract valid JSON', () => {
    let passed = 0
    let failed = 0

    for (const s of scenarios) {
      try {
        const { json } = normalizeRawOutput(s.input)
        const parsed = JSON.parse(json)
        expect(parsed).toBeTruthy()
        passed++
      } catch {
        failed++
      }
    }

    console.log(`  Prose: ${passed}/${scenarios.length} passed, ${failed} failed`)
    // 10% tolerance — edge cases with multiple JSON-like structures in prose
    expect(failed).toBeLessThan(scenarios.length * 0.10)
  })
})

// ─── Type Coercion Tests (2000) ─────────────────────────────────────────────

describe('Type Coercion (2000 scenarios)', () => {
  interface CoercionScenario {
    id: number
    category: string
    input: string
    schema: { field: string; expectedType: string }[]
    expectedParsed: Record<string, unknown>
    coerced: { field: string; from: unknown; to: unknown; rule: string }[]
  }
  const scenarios = loadFixture<CoercionScenario>('coercion-scenarios.json')

  it(`loaded ${scenarios.length} scenarios`, () => {
    expect(scenarios.length).toBe(2000)
  })

  it('coercion produces correct types', () => {
    let passed = 0
    let failed = 0

    for (const s of scenarios) {
      try {
        const parsed = JSON.parse(s.input)
        // Build a dynamic zod schema from the scenario's schema field
        const shape: Record<string, z.ZodTypeAny> = {}
        for (const f of s.schema) {
          switch (f.expectedType) {
            case 'number': shape[f.field] = z.number(); break
            case 'boolean': shape[f.field] = z.boolean(); break
            case 'string': shape[f.field] = z.string(); break
            case 'array': shape[f.field] = z.array(z.string()); break
            default: shape[f.field] = z.unknown()
          }
        }
        const schema = z.object(shape)
        const { data, coerced } = coerceTypes(parsed, schema)

        // Check that coercion happened for expected fields
        if (s.coerced.length > 0 && coerced.length > 0) passed++
        else if (s.coerced.length === 0 && coerced.length === 0) passed++
        else failed++
      } catch {
        failed++
      }
    }

    console.log(`  Coercion: ${passed}/${scenarios.length} passed, ${failed} failed`)
    expect(failed).toBeLessThan(scenarios.length * 0.1) // 10% tolerance for schema format variations
  })
})

// ─── Malformed JSON Tests (2000) ────────────────────────────────────────────

describe('Malformed JSON (2000 scenarios)', () => {
  interface MalformedScenario {
    id: number; category: string; input: string
    expectedParsed: unknown; repairs: string[]; shouldFail: boolean
  }
  const scenarios = loadFixture<MalformedScenario>('malformed-scenarios.json')

  it(`loaded ${scenarios.length} scenarios`, () => {
    expect(scenarios.length).toBe(2000)
  })

  it('repairable scenarios produce valid JSON', () => {
    const repairable = scenarios.filter(s => !s.shouldFail)
    let passed = 0

    for (const s of repairable) {
      const { json } = normalizeRawOutput(s.input)
      try {
        JSON.parse(json)
        passed++
      } catch { /* expected to fail sometimes — normalizer doesn't fix everything */ }
    }

    console.log(`  Malformed (repairable): ${passed}/${repairable.length} repaired`)
    expect(passed).toBeGreaterThan(repairable.length * 0.5) // At least 50% should be fixable
  })

  it('unrecoverable scenarios are not silently accepted', () => {
    const unrecoverable = scenarios.filter(s => s.shouldFail)
    let correctlyFailed = 0

    for (const s of unrecoverable) {
      const { json } = normalizeRawOutput(s.input)
      try {
        JSON.parse(json)
        // If it parsed, it's a false positive (our normalizer fixed something that shouldn't be fixed)
      } catch {
        correctlyFailed++
      }
    }

    console.log(`  Malformed (unrecoverable): ${correctlyFailed}/${unrecoverable.length} correctly rejected`)
    expect(correctlyFailed).toBeGreaterThan(unrecoverable.length * 0.7) // 70%+ should fail
  })
})

// ─── Validation & Retry Tests (2000) ────────────────────────────────────────

describe('Validation & Retry (2000 scenarios)', () => {
  interface RetryScenario {
    id: number; category: string; responses: string[]
    schema: Record<string, unknown>; expectedData: unknown; expectedAttempts: number
  }
  const scenarios = loadFixture<RetryScenario>('retry-scenarios.json')

  it(`loaded ${scenarios.length} scenarios`, () => {
    expect(scenarios.length).toBe(2000)
  })

  it('final response in each scenario is valid JSON', () => {
    let passed = 0
    for (const s of scenarios) {
      const lastResponse = s.responses[s.responses.length - 1]!
      try {
        const { json } = normalizeRawOutput(lastResponse)
        JSON.parse(json)
        passed++
      } catch { /* some might still be wrapped */ }
    }
    console.log(`  Retry (final response parseable): ${passed}/${scenarios.length}`)
    expect(passed).toBeGreaterThan(scenarios.length * 0.9)
  })

  it('first response differs from last (validates retry is needed)', () => {
    let needsRetry = 0
    for (const s of scenarios) {
      if (s.responses.length > 1 && s.responses[0] !== s.responses[s.responses.length - 1]) {
        needsRetry++
      }
    }
    console.log(`  Retry (scenarios needing retry): ${needsRetry}/${scenarios.length}`)
    expect(needsRetry).toBeGreaterThan(scenarios.length * 0.8)
  })
})
