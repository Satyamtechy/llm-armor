import { describe, it, expect, beforeEach } from 'vitest'
import { z } from 'zod'
import { armor, configureArmor } from '../src/armor'
import { registerProvider } from '../src/providers'
import type { ProviderAdapter, ProviderMessage, ProviderCallOptions } from '../src/types'

let callCount = 0

function countingMock(response: string): ProviderAdapter {
  return {
    name: 'custom',
    async call(_msgs: ProviderMessage[], _opts: ProviderCallOptions) {
      callCount++
      return { content: response, model: 'mock', latency: 50 }
    },
  }
}

beforeEach(() => {
  callCount = 0
  configureArmor({ providers: { custom: { apiKey: 'test' } } })
})

const Schema = z.object({ name: z.string(), age: z.number() })

describe('Cache', () => {
  it('returns cached result on identical prompt+schema', async () => {
    registerProvider('custom', countingMock('{"name":"John","age":30}'))

    const opts = {
      prompt: 'Extract user',
      schema: Schema,
      model: 'mock',
      provider: 'custom' as const,
      cache: { enabled: true, ttl: 5000 },
    }

    const r1 = await armor(opts)
    const r2 = await armor(opts)

    expect(r1.success).toBe(true)
    expect(r2.success).toBe(true)
    expect(r2.meta.cached).toBe(true)
    expect(callCount).toBe(1) // Only 1 API call, second was cached
  })

  it('does not cache when disabled', async () => {
    registerProvider('custom', countingMock('{"name":"Jane","age":25}'))

    const opts = {
      prompt: 'Extract user',
      schema: Schema,
      model: 'mock',
      provider: 'custom' as const,
    }

    await armor(opts)
    await armor(opts)

    expect(callCount).toBe(2) // Both hit provider
  })

  it('different prompts get different cache entries', async () => {
    registerProvider('custom', countingMock('{"name":"X","age":1}'))

    const base = { schema: Schema, model: 'mock', provider: 'custom' as const, cache: { enabled: true } }

    await armor({ ...base, prompt: 'prompt A' })
    await armor({ ...base, prompt: 'prompt B' })

    expect(callCount).toBe(2) // Different prompts, both hit provider
  })

  it('does not cache failed results', async () => {
    registerProvider('custom', countingMock('garbage'))

    const opts = {
      prompt: 'Extract',
      schema: Schema,
      model: 'mock',
      provider: 'custom' as const,
      maxRetries: 0,
      cache: { enabled: true },
    }

    const r1 = await armor(opts)
    expect(r1.success).toBe(false)

    // Replace with working mock
    registerProvider('custom', countingMock('{"name":"OK","age":5}'))
    const r2 = await armor(opts)
    expect(r2.success).toBe(true)
    expect(r2.meta.cached).toBe(false)
  })
})

describe('Provider auto-detection', () => {
  it('detects ollama from llama model name', async () => {
    // We can't actually call ollama, but we can test the detection
    // by registering a mock under "ollama" name and using a llama model
    registerProvider('ollama', countingMock('{"name":"test","age":1}'))

    const result = await armor({
      prompt: 'test',
      schema: Schema,
      model: 'llama3',
      // provider not specified — should auto-detect to 'ollama'
    })

    expect(result.success).toBe(true)
    expect(callCount).toBe(1)
  })

  it('detects groq from model name', async () => {
    registerProvider('groq', countingMock('{"name":"test","age":2}'))

    const result = await armor({
      prompt: 'test',
      schema: Schema,
      model: 'groq-llama3-70b',
    })

    expect(result.success).toBe(true)
  })

  it('detects together from model name', async () => {
    registerProvider('together', countingMock('{"name":"test","age":3}'))

    const result = await armor({
      prompt: 'test',
      schema: Schema,
      model: 'together-mistral-7b',
    })

    expect(result.success).toBe(true)
  })
})
