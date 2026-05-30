import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { normalizeRawOutput, coerceTypes } from '../src/normalizer'

describe('normalizeRawOutput', () => {
  it('strips markdown fences', () => {
    const raw = '```json\n{"name": "John"}\n```'
    const { json, repairs } = normalizeRawOutput(raw)
    expect(JSON.parse(json)).toEqual({ name: 'John' })
    expect(repairs).toContain('stripped_markdown_fences')
  })

  it('strips markdown fences without language tag', () => {
    const raw = '```\n{"age": 25}\n```'
    const { json, repairs } = normalizeRawOutput(raw)
    expect(JSON.parse(json)).toEqual({ age: 25 })
    expect(repairs).toContain('stripped_markdown_fences')
  })

  it('extracts JSON from prose', () => {
    const raw = 'Here is the result:\n{"name": "Alice", "age": 30}\nHope this helps!'
    const { json, repairs } = normalizeRawOutput(raw)
    expect(JSON.parse(json)).toEqual({ name: 'Alice', age: 30 })
    expect(repairs).toContain('extracted_json_block')
  })

  it('removes trailing commas', () => {
    const raw = '{"name": "Bob", "age": 25,}'
    const { json, repairs } = normalizeRawOutput(raw)
    expect(JSON.parse(json)).toEqual({ name: 'Bob', age: 25 })
    expect(repairs).toContain('removed_trailing_commas')
  })

  it('handles clean JSON without modifications', () => {
    const raw = '{"valid": true}'
    const { json, repairs } = normalizeRawOutput(raw)
    expect(JSON.parse(json)).toEqual({ valid: true })
    expect(repairs).toHaveLength(0)
  })

  it('handles arrays', () => {
    const raw = 'The list:\n[1, 2, 3]\nDone.'
    const { json, repairs } = normalizeRawOutput(raw)
    expect(JSON.parse(json)).toEqual([1, 2, 3])
    expect(repairs).toContain('extracted_json_block')
  })
})

describe('coerceTypes', () => {
  const schema = z.object({
    name: z.string(),
    price: z.number(),
    active: z.boolean(),
    tags: z.array(z.string()),
  })

  it('coerces currency string to number', () => {
    const data = { name: 'Item', price: '$99.99', active: true, tags: ['a'] }
    const { data: result, coerced } = coerceTypes(data, schema)
    expect((result as Record<string, unknown>).price).toBe(99.99)
    expect(coerced.find(c => c.field === 'price')?.rule).toBe('currency_strip')
  })

  it('coerces truthy string to boolean', () => {
    const data = { name: 'Item', price: 10, active: 'yes', tags: ['a'] }
    const { data: result, coerced } = coerceTypes(data, schema)
    expect((result as Record<string, unknown>).active).toBe(true)
    expect(coerced.find(c => c.field === 'active')?.rule).toBe('truthy_string')
  })

  it('coerces CSV string to array', () => {
    const data = { name: 'Item', price: 10, active: true, tags: 'foo, bar, baz' }
    const { data: result, coerced } = coerceTypes(data, schema)
    expect((result as Record<string, unknown>).tags).toEqual(['foo', 'bar', 'baz'])
    expect(coerced.find(c => c.field === 'tags')?.rule).toBe('split_csv_string')
  })

  it('extracts number from text like "4.5 out of 5"', () => {
    const ratingSchema = z.object({ score: z.number() })
    const data = { score: '4.5 out of 5' }
    const { data: result } = coerceTypes(data, ratingSchema)
    expect((result as Record<string, unknown>).score).toBe(4.5)
  })

  it('leaves already-correct types unchanged', () => {
    const data = { name: 'Item', price: 50, active: false, tags: ['x'] }
    const { data: result, coerced } = coerceTypes(data, schema)
    expect(result).toEqual(data)
    expect(coerced).toHaveLength(0)
  })
})
