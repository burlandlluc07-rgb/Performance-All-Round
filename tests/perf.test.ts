import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import { compressOutput, wantsRaw } from '../hooks/lib/compress.ts'
import { ReadTracker } from '../hooks/lib/reads.ts'
import { contextLevel, formatStatus, TTL_SUBSCRIPTION_MS } from '../hooks/lib/status.ts'

const bigLog = (n: number, failAt: number) =>
  Array.from({ length: n }, (_, i) => (i === failAt ? `FAIL src/auth.test.ts > rejects bad token` : `  ✓ test ${i} passed`)).join('\n')

describe('compressOutput', () => {
  const opts = { thresholdChars: 8000, headLines: 40, tailLines: 60, maxSignalLines: 40 }

  test('leaves short output alone', () => {
    expect(compressOutput('ok\n', opts, undefined)).toBe(null)
  })

  test('keeps head, tail and the failure from the middle', () => {
    const log = bigLog(2000, 1000)
    const c = compressOutput(log, opts, '.claude/perf/raw/x.log')
    expect(c).not.toBe(null)
    expect(c!.text).toContain('FAIL src/auth.test.ts')
    expect(c!.text).toContain('test 0 passed')
    expect(c!.text).toContain('test 1999 passed')
    expect(c!.text).toContain('.claude/perf/raw/x.log')
    expect(c!.text.length).toBeLessThan(log.length / 5)
    expect(c!.savedChars).toBe(log.length - c!.text.length)
  })

  test('cuts a few very long lines by characters', () => {
    const c = compressOutput('x'.repeat(50_000), opts, undefined)
    expect(c!.text.length).toBeLessThan(9000)
  })

  test('PERF_RAW=1 bypass is recognised', () => {
    expect(wantsRaw('PERF_RAW=1 npm test')).toBe(true)
    expect(wantsRaw('cd x && PERF_RAW=1 npm test')).toBe(true)
    expect(wantsRaw('npm test')).toBe(false)
  })
})

describe('ReadTracker', () => {
  test('refuses an unchanged repeat once, then lets the retry through', () => {
    const t = new ReadTracker()
    const k = { path: '/a.ts' }
    expect(t.judge(k, 1).kind).toBe('new')
    t.record(k, 1, 1, 100)
    expect(t.judge(k, 1).kind).toBe('repeat')
    t.refused(k)
    expect(t.judge(k, 1).kind).toBe('retry')
    expect(t.judge(k, 2).kind).toBe('changed')
    expect(t.judge({ path: '/a.ts', offset: 10, limit: 20 }, 1).kind).toBe('new')
    t.reset()
    expect(t.judge(k, 1).kind).toBe('new')
  })
})

describe('formatStatus', () => {
  test('shows context, cost, cache and limits', () => {
    const line = formatStatus(
      {
        startedAt: 0,
        context: { tokens: 160_000, window: 200_000, percent: 80 },
        rateLimits: [{ kind: 'five_hour', percentUsed: 23.5 }],
        cost: { usd: 1.234 },
      },
      { lastResponseAt: 0, ttlMs: TTL_SUBSCRIPTION_MS },
      10 * 60_000,
      { savedTokens: 12_000, runningAgents: 1, mode: 'normal' },
    )
    expect(line).toBe('■ ctx 80% 160k/200k → /compact · $1.23 · cache warm 50m · 5h 24% · bg 1 · saved ~12k')
    expect(contextLevel(10)).toBe('ok')
    expect(contextLevel(60)).toBe('warn')
  })
})

describe('hooks', () => {
  const stubs = (on: On) => {
    mock.store(on)
    on('fs.exists', () => ({ value: true }))
    on('fs.write', () => ({ value: undefined }))
    on('fs.stat', () => ({ value: { kind: 'file', size: 10, mtimeMs: 42, isLink: false } }))
  }

  test('a long Bash output is compressed and a PERF_RAW=1 one is not', async ($, on) => {
    stubs(on)
    const log = bigLog(3000, 1500)
    on('tool.call', () => ({ result: { stdout: log, stderr: '', interrupted: false } }))

    const ran = await $.tool.call({ tool: 'Bash', command: 'npm test' })
    const out = (ran.result as { stdout: string }).stdout
    expect(out.length).toBeLessThan(log.length / 5)
    expect(out).toContain('FAIL src/auth.test.ts')

    const raw = await $.tool.call({ tool: 'Bash', command: 'PERF_RAW=1 npm test' })
    expect((raw.result as { stdout: string }).stdout).toBe(log)
  })

  test('an unchanged re-read is refused once, then allowed', async ($, on) => {
    stubs(on)
    on('tool.call', () => ({
      result: { type: 'text', file: { filePath: '/r.ts', content: 'abc', numLines: 1, startLine: 1, totalLines: 1 } },
    }))
    const read = () => $.tool.call({ tool: 'Read', file_path: '/r.ts' })

    expect((await read()).deny).toBe(undefined)
    expect((await read()).deny).toContain('has not changed')
    expect((await read()).deny).toBe(undefined)
  })

  test('compaction is told which files were in play', async ($, on) => {
    stubs(on)
    on('tool.call', () => ({ result: {} }))
    let told = ''
    on('session.compact', (_, e) => {
      told = e.instructions ?? ''
      return { skip: 'test' }
    })
    await $.tool.call({ tool: 'Edit', file_path: '/src/auth.ts', old_string: 'a', new_string: 'b' })
    await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'hi', toolUses: [] }] as never, instructions: 'keep the API decisions' })
    expect(told).toContain('keep the API decisions')
    expect(told).toContain('/src/auth.ts')
  })
})
