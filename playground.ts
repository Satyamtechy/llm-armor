/**
 * Playground — Test llm-armor without any API keys.
 * 
 * Run: npx tsx playground.ts
 * 
 * This simulates real LLM responses (the broken ones you'd get in production)
 * and shows how armor() handles them.
 */
import { z } from 'zod'
import { armor, configureArmor } from './src/armor'
import { registerProvider } from './src/providers'
import type { ProviderAdapter, ProviderMessage, ProviderCallOptions } from './src/types'

// ─── Mock Provider: simulates LLM responses ─────────────────────────────────

function mockLLM(responses: string[]): ProviderAdapter {
  let i = 0
  return {
    name: 'custom',
    async call(_msgs: ProviderMessage[], _opts: ProviderCallOptions) {
      const content = responses[i] ?? responses[responses.length - 1]!
      i++
      // Simulate network latency
      await new Promise(r => setTimeout(r, 100 + Math.random() * 200))
      return { content, model: 'mock-gpt', latency: 150 }
    },
  }
}

// ─── Setup ──────────────────────────────────────────────────────────────────

configureArmor({ providers: { custom: { apiKey: 'fake' } } })

// ─── Scenario 1: Markdown-wrapped JSON ──────────────────────────────────────

async function scenario1() {
  console.log('\n━━━ Scenario 1: Markdown-wrapped JSON ━━━')

  registerProvider('custom', mockLLM([
    '```json\n{"name": "John Doe", "email": "john@example.com", "age": 28}\n```\n\nI extracted the user info above.'
  ]))

  const result = await armor({
    prompt: 'Extract user from: John Doe, john@example.com, 28',
    schema: z.object({ name: z.string(), email: z.string().email(), age: z.number() }),
    model: 'mock-gpt',
    provider: 'custom',
  })

  console.log('✅ Success:', result.success)
  console.log('📦 Data:', result.data)
  console.log('🔧 Repairs:', result.meta.repaired)
  console.log('⏱️  Attempts:', result.meta.attempts)
}

// ─── Scenario 2: Wrong types (coercion) ────────────────────────────────────

async function scenario2() {
  console.log('\n━━━ Scenario 2: Wrong types → smart coercion ━━━')

  registerProvider('custom', mockLLM([
    '{"product": "MacBook Pro", "price": "$2,499", "inStock": "yes", "rating": "4.8 out of 5"}'
  ]))

  const result = await armor({
    prompt: 'Extract product details',
    schema: z.object({
      product: z.string(),
      price: z.number(),
      inStock: z.boolean(),
      rating: z.number().min(0).max(5),
    }),
    model: 'mock-gpt',
    provider: 'custom',
    coerce: true,
  })

  console.log('✅ Success:', result.success)
  console.log('📦 Data:', result.data)
  console.log('🔄 Coerced:', result.meta.coerced)
}

// ─── Scenario 3: Validation fails → retry with repair ──────────────────────

async function scenario3() {
  console.log('\n━━━ Scenario 3: Validation fails → auto-retry ━━━')

  registerProvider('custom', mockLLM([
    // Attempt 1: bad date format, wrong enum value
    '{"title": "Team standup", "date": "tomorrow", "priority": "urgent"}',
    // Attempt 2: model fixes it after receiving error feedback
    '{"title": "Team standup", "date": "2026-05-30", "priority": "high"}',
  ]))

  const result = await armor({
    prompt: 'Parse event: team standup tomorrow, high priority',
    schema: z.object({
      title: z.string().min(3),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      priority: z.enum(['low', 'medium', 'high']),
    }),
    model: 'mock-gpt',
    provider: 'custom',
    maxRetries: 3,
  })

  console.log('✅ Success:', result.success)
  console.log('📦 Data:', result.data)
  console.log('🔁 Attempts:', result.meta.attempts, '(needed 1 retry)')
}

// ─── Scenario 4: Total failure → defaultValue ──────────────────────────────

async function scenario4() {
  console.log('\n━━━ Scenario 4: Total failure → fallback default ━━━')

  registerProvider('custom', mockLLM([
    'I cannot extract that information, sorry!',
    'Still unable to process this request.',
    'Error: insufficient context provided.',
  ]))

  const result = await armor({
    prompt: 'Extract sentiment',
    schema: z.object({ sentiment: z.enum(['positive', 'negative', 'neutral']), confidence: z.number() }),
    model: 'mock-gpt',
    provider: 'custom',
    maxRetries: 2,
    defaultValue: { sentiment: 'neutral', confidence: 0 },
  })

  console.log('✅ Success:', result.success, '(used defaultValue)')
  console.log('📦 Data:', result.data)
  console.log('🔁 Attempts:', result.meta.attempts)
}

// ─── Scenario 5: Prose-wrapped + trailing commas ────────────────────────────

async function scenario5() {
  console.log('\n━━━ Scenario 5: Prose wrapping + trailing commas ━━━')

  registerProvider('custom', mockLLM([
    'Sure! Here are the results:\n\n{"items": ["apple", "banana", "cherry",], "count": 3,}\n\nLet me know if you need anything else.'
  ]))

  const result = await armor({
    prompt: 'List fruits',
    schema: z.object({ items: z.array(z.string()), count: z.number() }),
    model: 'mock-gpt',
    provider: 'custom',
  })

  console.log('✅ Success:', result.success)
  console.log('📦 Data:', result.data)
  console.log('🔧 Repairs:', result.meta.repaired)
}

// ─── Run all ────────────────────────────────────────────────────────────────

async function main() {
  console.log('🛡️  llm-armor Playground — No API keys needed!\n')
  console.log('This demonstrates how the package handles broken LLM output.\n')

  await scenario1()
  await scenario2()
  await scenario3()
  await scenario4()
  await scenario5()

  console.log('\n━━━ All scenarios complete! ━━━\n')
}

main().catch(console.error)
