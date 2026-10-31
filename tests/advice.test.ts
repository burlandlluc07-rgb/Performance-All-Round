import { describe, expect, mock, test } from 'claude-code/testing'
import { adviseModel, classifyPrompt, isVague } from '../hooks/lib/advice.ts'

describe('classifyPrompt', () => {
  test('sizes prompts', () => {
    expect(classifyPrompt('fix the typo in the README heading')).toBe('trivial')
    expect(classifyPrompt('rename getUser to fetchUser in api.ts')).toBe('trivial')
    expect(classifyPrompt('find the root cause of the intermittent test failure in the queue worker')).toBe('hard')
    expect(classifyPrompt('add a --json flag to the export command')).toBe('normal')
  })
})

describe('adviseModel', () => {
  test('suggests cheaper for small edits on a large model or high effort', () => {
    expect(adviseModel('trivial', 'claude-opus-5-5', 'medium')).toContain('/model sonnet')
    expect(adviseModel('trivial', 'claude-sonnet-5-5', 'max')).toContain('/effort low')
    expect(adviseModel('trivial', 'claude-sonnet-5-5', 'medium')).toBe(undefined)
  })
  test('suggests stronger for hard work on a small model', () => {
    expect(adviseModel('hard', 'claude-haiku-5-5', undefined)).toContain('/model')
    expect(adviseModel('hard', 'claude-opus-5-5', undefined)).toBe(undefined)
  })
})

describe('isVague', () => {
  test('flags broad asks with no anchor', () => {
    expect(isVague('improve this codebase')).toBe(true)
    expect(isVague('clean up the code please')).toBe(true)
  })
  test('passes anchored or narrow asks', () => {
    expect(isVague('improve error handling in auth.ts')).toBe(false)
    expect(isVague('refactor `parseConfig` to return a Result')).toBe(false)
    expect(isVague('add input validation to the login form')).toBe(false)
    expect(isVague('/compact keep decisions')).toBe(false)
  })
})

describe('post-edit check', () => {
  test('a failing check sends Claude back once edits were made, a passing one does not', async ($, on) => {
    mock.store(on)
    mock.clock(on)
    on('fs.exists', (_, e) => ({ value: String((e as { path?: string }).path ?? e).includes('perf.json') }))
    on('fs.read', () => ({ value: JSON.stringify({ check: 'npm test' }) }))
    on('fs.write', () => ({ value: undefined }))
    on('command.register', () => ({ value: { command: 'perf' } }))
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    on('tool.call', () => ({ result: {} }))
    let exitCode = 1
    on('process.run', () => ({ value: { exitCode, stdout: 'FAIL auth.test.ts', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
    on('classic.Stop', () => ({}))

    await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
    const stop = {
      session_id: 's', transcript_path: '/t', cwd: '/p', hook_event_name: 'Stop' as const, stop_hook_active: false,
    }

    // No edits: no check.
    expect((await $.classic.Stop(stop)).block).toBe(undefined)

    await $.tool.call({ tool: 'Edit', file_path: '/p/a.ts', old_string: 'a', new_string: 'b' })
    const failed = await $.classic.Stop(stop)
    expect(failed.block).toContain('FAIL auth.test.ts')

    exitCode = 0
    await $.tool.call({ tool: 'Edit', file_path: '/p/a.ts', old_string: 'b', new_string: 'c' })
    expect((await $.classic.Stop({ ...stop, stop_hook_active: true })).block).toBe(undefined)
  })
})
