// Performance-All-Round: cuts the token waste described in RESEARCH.md.
//
//  - status line: context fill, cost, prompt-cache warm/cold, rate limits
//  - output compressor: long Bash and MCP outputs become head + tail + errors,
//    the full text saved to .claude/perf/raw/
//  - repeat-read guard: an unchanged re-read is refused once, with a way through
//  - context hygiene: /compact and /clear prompts at 50% and 75%, a warning
//    before the prompt cache expires and on a costly resume
//  - compaction safety net: files in play and the last failure survive /compact
//  - lean working rules: a short always-on section of the system prompt
//  - model/effort advisor and vague-prompt hint at the start of a task
//  - post-edit check: a configured command runs when Claude stops after edits
//  - project brief: a pointer to .claude/project-brief.md when one exists
//  - /perf: report, audit, check, mode off|normal|strict
//
// Every hook fails open: if anything here throws, the engine carries on as if
// the plugin were not installed.

import type { EngineInterface, Register, SessionUsage } from 'claude-code'
import { adviseModel, classifyPrompt, isVague } from './lib/advice.ts'
import { approxTokens, compressOutput, mcpText, wantsRaw, type CompressOptions } from './lib/compress.ts'
import { ReadTracker } from './lib/reads.ts'
import {
  cacheRemainingMs,
  formatDuration,
  formatStatus,
  kTokens,
  ttlFor,
  TTL_API_MS,
  type CacheState,
} from './lib/status.ts'

type $ = EngineInterface
type Mode = 'off' | 'normal' | 'strict'
const MODES: readonly Mode[] = ['off', 'normal', 'strict']

const PERF_DIR = '.claude/perf'
const RAW_DIR = `${PERF_DIR}/raw`
const CONFIG_PATH = '.claude/perf.json'
const BRIEF_PATH = '.claude/project-brief.md'

/** Per-project settings, read from .claude/perf.json at session start. */
type Config = {
  /** Shell command run when Claude stops after editing files, e.g. "npm run -s typecheck". */
  check?: string
  /** How long the check may run, in ms (default 120000). */
  checkTimeoutMs?: number
  /** The vague-prompt hint: on in strict mode unless set; set true or false to override. */
  vaguePromptHint?: boolean
  /** The model/effort advisor (default on). */
  modelAdvisor?: boolean
  /**
   * Prompt-cache lifetime in minutes. Guessed otherwise: 60 on a subscription,
   * 5 on an API key. Set 60 on an API key with the 1-hour cache turned on.
   */
  cacheTtlMinutes?: number
}

const COMPRESS: Record<Exclude<Mode, 'off'>, CompressOptions> = {
  normal: { thresholdChars: 8000, headLines: 40, tailLines: 60, maxSignalLines: 40 },
  strict: { thresholdChars: 3000, headLines: 20, tailLines: 30, maxSignalLines: 25 },
}
const NUDGE_AT: Record<Exclude<Mode, 'off'>, readonly [number, number]> = {
  normal: [50, 75],
  strict: [40, 60],
}
/** Whole-file reads longer than this get a one-time hint to search first. */
const LARGE_READ_LINES = 500
/** Below this many context tokens a cold cache is cheap enough not to mention. */
const CACHE_WARN_MIN_TOKENS = 30_000

/** The always-on rules. Fixed text, so it never changes the cached prefix. */
const RULES = `# Token discipline (Performance-All-Round)
- Locate before reading: Grep/Glob with narrow patterns, then Read only the line range you need (offset/limit).
- Do not re-read a file you already have unless it changed; do not echo file contents, diffs or tool output back. Cite path:line.
- Prefer quiet flags and filtered output (-q, --silent, | tail, | grep) for tests, builds and installs.
- Hand verbose read-only work (log or test triage, wide searches) to a subagent and keep only its summary.
- Answer concisely: no preamble, no restating the plan, no recap of what the user can already see.`

// ---------------------------------------------------------------- state ----
// Module variables are per process (a hot reload starts them over, which only
// costs a counter). What must outlive the session is in $.store.

let mode: Mode = 'normal'
let config: Config = {}
/** True until the first prompt of a task (session start, /clear, compaction). */
let atTaskBoundary = true
let editedThisTurn = false
let checkRetries = 0
let rulesInPrompt: boolean | undefined
const trackers = new Map<string, ReadTracker>()
const tracker = (agentId: string | undefined): ReadTracker => {
  const key = agentId ?? 'main'
  let t = trackers.get(key)
  if (!t) trackers.set(key, (t = new ReadTracker()))
  return t
}
const cache: CacheState = { ttlMs: TTL_API_MS }
let turn = 0
let goal: string | undefined
const edited = new Set<string>()
let lastFailure: string | undefined
let nudged = 0 // how many of the two thresholds have been announced this context
let cacheWarnedFor: number | undefined
let largeReadHinted = false
let rawDirReady = false
const session = { compressions: 0, savedChars: 0, readsRefused: 0, readSavedChars: 0 }

type Totals = { compressions: number; savedTokens: number; readsRefused: number; sessions: number }
const ZERO: Totals = { compressions: 0, savedTokens: 0, readsRefused: 0, sessions: 0 }

async function loadConfig($: $): Promise<Config> {
  try {
    if (!(await $.fs.exists(CONFIG_PATH))) return {}
    const parsed = JSON.parse(await $.fs.read(CONFIG_PATH)) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as Config) : {}
  } catch {
    return {}
  }
}

async function loadMode($: $): Promise<Mode> {
  const stored = await $.store.get('mode').catch(() => undefined)
  return MODES.includes(stored as Mode) ? (stored as Mode) : 'normal'
}

async function bumpTotals($: $, delta: Partial<Totals>): Promise<void> {
  try {
    const prev = { ...ZERO, ...((await $.store.get('totals')) as Partial<Totals> | undefined) }
    const next: Totals = {
      compressions: prev.compressions + (delta.compressions ?? 0),
      savedTokens: prev.savedTokens + (delta.savedTokens ?? 0),
      readsRefused: prev.readsRefused + (delta.readsRefused ?? 0),
      sessions: prev.sessions + (delta.sessions ?? 0),
    }
    await $.store.set('totals', next)
  } catch {
    // counters are best effort
  }
}

const savedTokens = (): number => approxTokens(session.savedChars + session.readSavedChars)

/** Clears per-context state after /clear or a compaction. */
function contextStartedOver(): void {
  for (const t of trackers.values()) t.reset()
  nudged = 0
  cacheWarnedFor = undefined
  largeReadHinted = false
  atTaskBoundary = true
}

/**
 * Tells the person something: a line in the transcript ($.ui.log, which the
 * model never reads) plus a toast where the surface shows one. In the
 * terminal's main screen a toast alone was easy to miss.
 */
function tell($: $, text: string): void {
  $.ui.toast(text)
  // The engine already heads a log line with the plugin's name.
  $.ui.log(text.replace(/^perf: /, ''))
}

async function saveRaw($: $, label: string, text: string): Promise<string | undefined> {
  try {
    if (!rawDirReady) {
      // Keep the saved outputs out of the person's git status.
      if (!(await $.fs.exists(`${PERF_DIR}/.gitignore`))) await $.fs.write(`${PERF_DIR}/.gitignore`, '*\n')
      rawDirReady = true
    }
    const now = await $.clock.now()
    const safe = label.replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 40) || 'output'
    const path = `${RAW_DIR}/${new Date(now).toISOString().replace(/[:.]/g, '-')}-${safe}.log`
    await $.fs.write(path, text)
    return path
  } catch {
    return undefined
  }
}

async function refreshStatus($: $, usage?: SessionUsage): Promise<void> {
  try {
    const u = usage ?? (await $.session.usage())
    cache.ttlMs =
      typeof config.cacheTtlMinutes === 'number' && config.cacheTtlMinutes > 0 ? config.cacheTtlMinutes * 60_000 : ttlFor(u)
    const agents = await $.agent.list().catch(() => [])
    const running = agents.filter(a => a.status === 'running' || a.status === 'pending').length
    $.ui.status(formatStatus(u, cache, await $.clock.now(), { savedTokens: savedTokens(), runningAgents: running, mode }))
  } catch {
    // a missing figure is not worth an error line
  }
}

function stateNote(): string {
  const lines: string[] = []
  if (goal) lines.push(`Session goal (first prompt): ${goal.slice(0, 400)}`)
  if (edited.size) lines.push(`Files edited this session: ${[...edited].slice(-15).join(', ')}`)
  const read = tracker(undefined).files().filter(f => !edited.has(f))
  if (read.length) lines.push(`Files read: ${read.slice(-15).join(', ')}`)
  if (lastFailure) lines.push(`Last failing command: ${lastFailure.slice(0, 300)}`)
  return lines.join('\n')
}

// ------------------------------------------------------------- register ----

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    mode = await loadMode($)
    config = await loadConfig($)
    void bumpTotals($, { sessions: 1 })
    await $.command.register({
      name: 'perf',
      description: 'Token and performance stats, audit and mode (Performance-All-Round)',
      argumentHint: '[report | audit | check | mode off|normal|strict]',
    })
    await refreshStatus($)
    // Keep the cache countdown honest and warn shortly before it expires.
    $.clock.every(30_000, async () => {
      await refreshStatus($)
      await maybeWarnCacheExpiry($)
    })
    return r
  }).catch(($, e, next) => next(e))

  // ---- lean working rules (system prompt, constant for the whole thread) ----
  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    if (rulesInPrompt === undefined) rulesInPrompt = (await loadMode($)) !== 'off'
    if (!rulesInPrompt) return r
    return { sections: [...r.sections, { id: 'perf:rules', text: RULES, scope: 'session' as const }] }
  }).catch(($, e, next) => next(e))

  // ---- remember the goal; tell the person when the cache went cold ----
  on('prompt.submit', async ($, e, next) => {
    if (goal === undefined && !e.command && e.text.trim()) goal = e.text.trim()
    if (mode !== 'off' && !e.command) {
      try {
        const left = cacheRemainingMs(cache, await $.clock.now())
        if (left !== undefined && left <= 0) {
          const u = await $.session.usage()
          const tokens = u.context.tokens ?? 0
          if (tokens >= CACHE_WARN_MIN_TOKENS) {
            tell($, 
              `perf: the prompt cache had expired, so this message re-writes ~${kTokens(tokens)} tokens of context. ` +
                'Before stepping away from a big session, /compact or /clear it.',
            )
          }
        }
      } catch {}
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // ---- start of a task: model/effort advisor and vague-prompt hint ----
  on('classic.UserPromptSubmit', async ($, e, next) => {
    const r = await next(e)
    if (mode === 'off' || e.agent_id !== undefined) return r
    if (e.source !== undefined && e.source !== 'user') return r
    const text = e.prompt.trim()
    if (!text || text.startsWith('/')) return r
    const boundary = atTaskBoundary
    atTaskBoundary = false
    const vagueOn = config.vaguePromptHint ?? mode === 'strict'
    if (vagueOn && isVague(text)) {
      tell(
        $,
        'perf: that prompt names no file, function or check, so Claude will have to explore to find the scope. ' +
          'Naming them (e.g. "add input validation to login() in auth.ts; npm test must pass") is cheaper and more accurate.',
      )
    }
    if (boundary && config.modelAdvisor !== false) {
      const advice = adviseModel(classifyPrompt(text), await $.session.model(), e.effort?.level)
      // Advice only, at a task boundary, so following it costs no warm cache.
      if (advice) tell($, `perf: ${advice}`)
    }
    return r
  }).catch(($, e, next) => next(e))

  // ---- after each turn: cache clock, status line, /compact and /clear prompts ----
  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId !== undefined) return r
    turn += 1
    try {
      cache.lastResponseAt = await $.clock.now()
      cacheWarnedFor = undefined
      const u = await $.session.usage()
      await refreshStatus($, u)
      if (mode === 'off') return r
      const pct = u.context.percent
      if (pct === undefined) return r
      const [low, high] = NUDGE_AT[mode]
      if (pct < low) nudged = 0
      const tokens = kTokens(u.context.tokens ?? 0)
      if (pct >= high && nudged < 2) {
        nudged = 2
        tell($, 
          `perf: context is ${pct}% full (${tokens} tokens re-sent with every message, and answers get worse as it fills). ` +
            'Run /compact <what to keep> now, or /clear if the next task is unrelated.',
        )
      } else if (pct >= low && nudged < 1) {
        nudged = 1
        tell($, 
          `perf: context is ${pct}% full (${tokens}). At the next task boundary, /compact <what to keep>; ` +
            'switching to unrelated work, /clear (it is free).',
        )
      }
    } catch {}
    return r
  }).catch(($, e, next) => next(e))

  // ---- verbose output compressor (Bash) ----
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError) lastFailure = e.command
    if (mode === 'off' || ran.deny !== undefined || e.run_in_background || wantsRaw(e.command)) return ran
    // A failed command's record has the same stdout/stderr fields; check rather than trust the type.
    const res = ran.result as { stdout?: unknown; stderr?: unknown } | undefined
    if (!res || typeof res.stdout !== 'string') return ran
    const stdout = res.stdout
    const stderr = typeof res.stderr === 'string' ? res.stderr : ''
    const opts = COMPRESS[mode]
    const total = stdout.length + stderr.length
    if (total <= opts.thresholdChars) return ran

    const raw = await saveRaw($, e.description ?? e.command.split(/\s+/)[0] ?? 'bash', `$ ${e.command}\n\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`)
    const out = compressOutput(stdout, opts, raw)
    const err = compressOutput(stderr, opts, raw)
    if (!out && !err) return ran
    const saved = (out?.savedChars ?? 0) + (err?.savedChars ?? 0)
    session.compressions += 1
    session.savedChars += saved
    void bumpTotals($, { compressions: 1, savedTokens: approxTokens(saved) })
    return {
      ...ran,
      ref: undefined,
      text: undefined,
      result: { ...res, stdout: out?.text ?? stdout, stderr: err?.text ?? stderr } as typeof ran.result,
    }
  }).catch(($, e, next) => next(e))

  // ---- verbose output compressor (MCP tools), through the PostToolUse contract ----
  on('classic.PostToolUse', async ($, e, next) => {
    const r = await next(e)
    if (mode === 'off' || !e.tool_name.startsWith('mcp__')) return r
    try {
      // Only text-block responses are replaced: images or structured content pass through.
      const raw = mcpText(e.tool_response)
      if (raw === undefined) return r
      const opts = COMPRESS[mode]
      if (!raw || raw.length <= opts.thresholdChars * 2) return r
      const path = await saveRaw($, e.tool_name, raw)
      const c = compressOutput(raw, { ...opts, thresholdChars: opts.thresholdChars * 2 }, path, '')
      if (!c) return r
      session.compressions += 1
      session.savedChars += c.savedChars
      void bumpTotals($, { compressions: 1, savedTokens: approxTokens(c.savedChars) })
      return { ...r, updatedMCPToolOutput: [{ type: 'text', text: c.text }] }
    } catch {
      return r
    }
  }).catch(($, e, next) => next(e))

  // ---- repeat-read guard ----
  on('tool.call', { tool: 'Read' }, async ($, e, next) => {
    if (mode === 'off') return next(e)
    const key = { path: e.file_path, offset: e.offset, limit: e.limit, pages: e.pages }
    const t = tracker(e.agentId)
    let mtimeMs: number
    try {
      mtimeMs = (await $.fs.stat(e.file_path)).mtimeMs
    } catch {
      return next(e) // missing or unreadable: let Read say so
    }
    const verdict = t.judge(key, mtimeMs)
    if (verdict.kind === 'repeat') {
      t.refused(key)
      session.readsRefused += 1
      session.readSavedChars += t.charsOf(key)
      void bumpTotals($, { readsRefused: 1, savedTokens: approxTokens(t.charsOf(key)) })
      return {
        deny:
          `perf: ${e.file_path} has not changed since you read this same range earlier in this conversation, ` +
          'so its content is already in your context. Work from that, or Grep for the part you need. ' +
          'If the earlier output is no longer visible to you, repeat this exact Read and it will go through.',
      }
    }
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError || !ran.result) return ran
    const res = ran.result
    const chars = res.type === 'text' ? res.file.content.length : (ran.text?.length ?? 0)
    t.record(key, mtimeMs, turn, chars)
    if (
      !largeReadHinted &&
      res.type === 'text' &&
      e.offset === undefined &&
      e.limit === undefined &&
      res.file.totalLines > LARGE_READ_LINES
    ) {
      largeReadHinted = true
      return {
        ...ran,
        context: [
          ...(ran.context ?? []),
          `perf: that was a whole-file read of ${res.file.totalLines} lines. Next time, Grep for the symbol first and Read only the lines around it (offset/limit).`,
        ],
      }
    }
    return ran
  }).catch(($, e, next) => next(e))

  // ---- files in play, for the compaction note ----
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    const name = String(e.tool)
    if ((name === 'Edit' || name === 'Write' || name === 'NotebookEdit') && ran.deny === undefined && !ran.isError) {
      const input = e as unknown as { file_path?: string; notebook_path?: string }
      const p = input.file_path ?? input.notebook_path
      if (p) {
        edited.delete(p)
        edited.add(p)
        if (e.agentId === undefined) editedThisTurn = true
      }
    }
    return ran
  }).catch(($, e, next) => next(e))

  // ---- post-edit check: run the project's fast check when Claude stops after edits ----
  on('classic.Stop', async ($, e, next) => {
    const r = await next(e)
    if (mode === 'off' || !config.check || !editedThisTurn || e.agent_id !== undefined) return r
    if (r.block !== undefined) return r // another hook already sent Claude back
    editedThisTurn = false
    const ran = await runCheck($, config.check, e.cwd)
    if (ran.ok) {
      checkRetries = 0
      tell($, `perf: check passed (${config.check}).`)
      return r
    }
    if (checkRetries >= 2) {
      checkRetries = 0
      tell($, `perf: check still failing after two attempts (${config.check}); stopping so you can look.`)
      return r
    }
    checkRetries += 1
    return {
      ...r,
      block:
        `perf: the project check failed after your edits (${config.check}, ${ran.summary}).\n${ran.output}\n` +
        'Fix the cause, or if it cannot pass for a reason outside this task, say so and stop.',
    }
  }).catch(($, e, next) => next(e))

  // ---- compaction safety net ----
  on('session.compact', async ($, e, next) => {
    if (mode === 'off' || e.agentId !== undefined || e.trigger === 'precompute') return next(e)
    const note = stateNote()
    if (note) {
      try {
        const when = new Date(await $.clock.now()).toISOString()
        await $.fs.write(`${PERF_DIR}/state.md`, `# State before compaction (${when})\n\n${note}\n`)
      } catch {}
    }
    const keep =
      'Preserve: the task goal, decisions made and why, open bugs, failing test names, and next steps.' +
      (note ? `\n${note}` : '')
    const r = await next({ ...e, instructions: e.instructions ? `${e.instructions}\n\n${keep}` : keep })
    contextStartedOver()
    return r
  }).catch(($, e, next) => next(e))

  // ---- session start sources: resume cost, /clear, after compaction ----
  on('classic.SessionStart', async ($, e, next) => {
    const r = await next(e)
    if (e.source === 'clear') {
      contextStartedOver()
      goal = undefined
      edited.clear()
      lastFailure = undefined
      cache.lastResponseAt = undefined
    }
    if (e.source === 'compact') contextStartedOver()
    if (mode === 'off') return r
    if ((e.source === 'resume' || e.source === 'fork') && e.prompt_cache_likely_expired) {
      const tokens = e.context_tokens ?? 0
      if (tokens >= CACHE_WARN_MIN_TOKENS) {
        const usd = e.estimated_cache_write_usd !== undefined ? ` (~$${e.estimated_cache_write_usd.toFixed(2)})` : ''
        tell($, 
          `perf: this session's prompt cache has expired. Your first message will re-write ~${kTokens(tokens)} tokens${usd}. ` +
            'If you only need the gist, /compact <focus> or /clear first.',
        )
      }
    }
    const extra: string[] = []
    if ((e.source === 'startup' || e.source === 'clear' || e.source === 'compact') && (await $.fs.exists(BRIEF_PATH).catch(() => false))) {
      extra.push(`perf: a project brief is at ${BRIEF_PATH}. Read it before exploring the codebase; refresh it with the project-brief skill when it is stale.`)
    }
    if (e.source === 'compact') {
      const note = stateNote()
      if (note) {
        return {
          ...r,
          additionalContext: [
            ...(r.additionalContext ?? []),
            ...extra,
            `perf: state kept across compaction (also in ${PERF_DIR}/state.md):\n${note}`,
          ],
        }
      }
    }
    return extra.length ? { ...r, additionalContext: [...(r.additionalContext ?? []), ...extra] } : r
  }).catch(($, e, next) => next(e))

  // ---- /perf ----
  on('command.run', { command: 'perf' }, async ($, e) => {
    const [sub = '', arg = ''] = e.args.trim().split(/\s+/)
    if (sub === 'mode') {
      if (!MODES.includes(arg as Mode)) return { text: `Mode is ${mode}. Use /perf mode off|normal|strict.` }
      mode = arg as Mode
      await $.store.set('mode', mode)
      await refreshStatus($)
      return {
        text:
          `perf mode set to ${mode}. ` +
          (mode === 'off'
            ? 'Compression, the read guard and prompts are off; the status line stays. The working rules leave the system prompt in your next session.'
            : mode === 'strict'
              ? 'Outputs over ~3k chars are compressed and the /compact prompts come at 40% and 60%.'
              : 'Outputs over ~8k chars are compressed and the /compact prompts come at 50% and 75%.'),
      }
    }
    if (sub === 'audit') return { text: await audit($) }
    if (sub === 'check') {
      config = await loadConfig($)
      if (!config.check) return { text: `No check is set. Add {"check": "npm run -s typecheck"} (or your fast test command) to ${CONFIG_PATH}.` }
      const ran = await runCheck($, config.check, await $.session.cwd())
      return { text: `${config.check}: ${ran.ok ? 'passed' : 'failed'} (${ran.summary})${ran.ok ? '' : `\n${ran.output}`}` }
    }
    if (sub === 'report' || sub === '') return { text: await report($) }
    return { text: 'Usage: /perf [report | audit | check | mode off|normal|strict]' }
  }).catch(() => ({ text: 'perf: the command failed; see claude --debug for the reason.' }))
}

// ------------------------------------------------------------ post-edit check ----

async function runCheck($: $, command: string, cwd: string): Promise<{ ok: boolean; summary: string; output: string }> {
  const timeoutMs = config.checkTimeoutMs ?? 120_000
  try {
    const started = await $.clock.now()
    const r = await $.process.run(['bash', '-lc', command], { cwd, timeoutMs })
    const secs = Math.round(((await $.clock.now()) - started) / 100) / 10
    const text = `${r.stdout}\n${r.stderr}`.trim()
    // Keep only the tail: that is where test runners and compilers put the verdict.
    const tail = text.split('\n').slice(-30).join('\n')
    return { ok: r.exitCode === 0, summary: `exit ${r.exitCode}, ${secs}s`, output: tail }
  } catch (err) {
    return { ok: false, summary: 'could not run', output: String(err).slice(0, 500) }
  }
}

// --------------------------------------------------------- cache warning ----

async function maybeWarnCacheExpiry($: $): Promise<void> {
  if (mode === 'off' || cache.lastResponseAt === undefined || cacheWarnedFor === cache.lastResponseAt) return
  const left = cacheRemainingMs(cache, await $.clock.now())
  // Not for the 5-minute cache: it expires during ordinary pauses, and a warning every few minutes is noise.
  if (left === undefined || left <= 0 || left > 3 * 60_000 || cache.ttlMs < 10 * 60_000) return
  const u = await $.session.usage()
  const tokens = u.context.tokens ?? 0
  if (tokens < CACHE_WARN_MIN_TOKENS) return
  cacheWarnedFor = cache.lastResponseAt
  tell($, 
    `perf: prompt cache expires in ${formatDuration(left)}. If you are stepping away, /compact or /clear now; ` +
      `otherwise your next message re-writes ~${kTokens(tokens)} tokens.`,
  )
}

// ------------------------------------------------------------ /perf text ----

async function report($: $): Promise<string> {
  const u = await $.session.usage()
  const now = await $.clock.now()
  const totals = { ...ZERO, ...((await $.store.get('totals').catch(() => undefined)) as Partial<Totals> | undefined) }
  const left = cacheRemainingMs(cache, now)
  const lines = [
    `Performance-All-Round · mode ${mode}`,
    '',
    `Context: ${u.context.percent ?? '–'}% (${kTokens(u.context.tokens ?? 0)} of ${kTokens(u.context.window)} tokens)`,
    `Cost so far: ${u.cost ? `$${u.cost.usd.toFixed(2)}` : 'n/a'}`,
    `Prompt cache: ${left === undefined ? 'no response yet' : left > 0 ? `warm, ~${formatDuration(left)} left` : 'cold (next message re-writes the context)'} (TTL ${cache.ttlMs >= 3_600_000 ? '1h, subscription' : '5m, API key'})`,
    ...u.rateLimits.map(r => `Limit ${r.kind}: ${r.percentUsed}% used${r.resetsAt ? `, resets ${r.resetsAt}` : ''}`),
    '',
    'This session:',
    `  outputs compressed: ${session.compressions} (~${kTokens(approxTokens(session.savedChars))} tokens kept out of context)`,
    `  repeat reads refused: ${session.readsRefused} (~${kTokens(approxTokens(session.readSavedChars))} tokens)`,
    `  files edited: ${edited.size}${lastFailure ? ` · last failing command: ${lastFailure.slice(0, 80)}` : ''}`,
    'All sessions:',
    `  ${totals.sessions} sessions · ${totals.compressions} compressions · ${totals.readsRefused} reads refused · ~${kTokens(totals.savedTokens)} tokens saved`,
    '',
    'Tokens are estimated at 4 characters each. Saved full outputs are in .claude/perf/raw/.',
  ]
  return lines.join('\n')
}

async function audit($: $): Promise<string> {
  const u = await $.session.usage({ breakdown: 'summary' })
  const b = u.context.breakdown
  const out: string[] = ['Always-on context audit (estimates, as /context counts them)', '']
  const tips: string[] = []
  if (!b) return 'No breakdown is available in this session yet. Send one message and run /perf audit again.'

  const cats = [...b.categories].filter(c => !c.isDeferred && c.tokens > 0).sort((a, z) => z.tokens - a.tokens)
  for (const c of cats.slice(0, 8)) out.push(`  ${c.name.padEnd(26)} ${kTokens(c.tokens).padStart(6)}`)

  if (b.memoryFiles.length) {
    out.push('', 'Memory files (CLAUDE.md and friends):')
    for (const m of b.memoryFiles) {
      const flag = m.tokens > 2500 ? '  ← over ~200 lines' : ''
      out.push(`  ${kTokens(m.tokens).padStart(6)}  ${m.path}${flag}`)
      if (flag) tips.push(`Trim ${m.path}: keep essentials under ~200 lines; move situational detail into skills or path-scoped rules (paths: frontmatter).`)
    }
  }

  const servers = new Map<string, { tools: number; tokens: number; loaded: number }>()
  for (const t of b.mcpTools) {
    const s = servers.get(t.serverName) ?? { tools: 0, tokens: 0, loaded: 0 }
    s.tools += 1
    s.tokens += t.tokens
    if (t.isLoaded) s.loaded += 1
    servers.set(t.serverName, s)
  }
  if (servers.size) {
    out.push('', 'MCP servers (tools · schema tokens · loaded this session):')
    const sorted = [...servers].sort((a, z) => z[1].tokens - a[1].tokens)
    for (const [name, s] of sorted.slice(0, 10)) out.push(`  ${name}: ${s.tools} tools · ${kTokens(s.tokens)} · ${s.loaded} loaded`)
    if (sorted.length > 10) {
      const rest = sorted.slice(10)
      out.push(`  … and ${rest.length} more (${kTokens(rest.reduce((n, [, x]) => n + x.tokens, 0))} tokens)`)
    }
    const unused = sorted.filter(([, s]) => s.loaded === 0).map(([n]) => n)
    if (unused.length) tips.push(`${unused.length} of ${sorted.length} servers have no tool used yet (largest: ${unused.slice(0, 5).join(', ')}). Disable servers you do not need with /mcp, and prefer CLIs (gh, gcloud, aws) where one exists.`)
  }

  if (b.skills) {
    out.push('', `Skills: ${b.skills.totalSkills} installed, listing costs ~${kTokens(b.skills.tokens)} tokens per request`)
    if (b.skills.tokens > 3000) tips.push('The skill listing is large: disable plugins you do not use (each plugin adds its descriptions whether used or not).')
  }
  if (b.agents.length > 10) tips.push(`${b.agents.length} agent types are listed; disable plugins whose agents you never call.`)
  if ((u.context.percent ?? 0) >= 50) tips.push('This conversation is over half the window: /compact <focus> at the next task boundary, or /clear.')

  out.push('', tips.length ? 'Suggestions:' : 'Nothing stands out.')
  for (const t of tips) out.push(`  - ${t}`)
  return out.join('\n')
}
