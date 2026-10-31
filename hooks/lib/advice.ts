// Prompt heuristics for the model/effort advisor and the vague-prompt hint.
// Pure and local: no model call, so they cost nothing.

export type TaskKind = 'trivial' | 'normal' | 'hard'

const TRIVIAL =
  /\b(typo|rename|reword|bump (the )?version|fix (the )?(spelling|indent(ation)?|import)|add (a )?comment|update (the )?(readme|changelog|copyright)|format(ting)?|lint fix|sort (the )?imports|change .{1,40} to .{1,40})\b/i
const HARD =
  /\b(architect(ure)?|design (a|the)|race condition|deadlock|memory leak|concurren(t|cy)|security (review|audit)|threat model|migrat(e|ion) (the|our|from)|root cause|intermittent|flaky|performance (issue|regression|problem)|refactor (the )?(whole|entire)|across (the )?(codebase|repo)|why (does|is|do)|prove|algorithm)\b/i

/** A rough size of the task from the prompt's words. */
export function classifyPrompt(text: string): TaskKind {
  const t = text.trim()
  if (HARD.test(t)) return 'hard'
  const words = t.split(/\s+/).filter(Boolean).length
  if (TRIVIAL.test(t) && words <= 40) return 'trivial'
  return 'normal'
}

export type ModelTier = 'small' | 'mid' | 'large' | 'unknown'

export function modelTier(model: string): ModelTier {
  const m = model.toLowerCase()
  if (/haiku/.test(m)) return 'small'
  if (/sonnet/.test(m)) return 'mid'
  if (/opus|fable/.test(m)) return 'large'
  return 'unknown'
}

const HIGH_EFFORT = new Set(['high', 'xhigh', 'max'])

/**
 * One line of advice, or undefined when the setup already fits the task.
 * Only ever advises; switching is the person's call, at a task boundary.
 */
export function adviseModel(kind: TaskKind, model: string, effort: string | undefined): string | undefined {
  const tier = modelTier(model)
  const highEffort = effort !== undefined && HIGH_EFFORT.has(effort)
  if (kind === 'trivial' && (tier === 'large' || highEffort)) {
    const what = [tier === 'large' ? '/model sonnet' : '', highEffort ? '/effort low' : ''].filter(Boolean).join(' or ')
    return `this looks like a small edit; ${what} would do it for less.`
  }
  if (kind === 'hard' && tier === 'small') {
    return 'this looks like a hard problem for a small model; /model sonnet or opus may save retries.'
  }
  return undefined
}

const ANCHOR =
  /[\w-]+\.[a-z0-9]{1,5}\b|`[^`]+`|[\w-]+\/[\w./-]+|\b[a-z]+[A-Z]\w*\b|\b\w+_\w+\b|\b\w+\(\)|#\d+|:\d+\b|https?:\/\//
const BROAD =
  /\b(improve|clean ?up|refactor|optimi[sz]e|make (it|this|the code) better|fix (all )?(the )?(bugs|issues|errors)|review (the|this|my) (code|codebase|repo|project)|look (at|over) (the|this|my) (code|codebase|repo|project)|modernize|tidy)\b/i

/**
 * True for a prompt that asks for broad work without naming anything to start
 * from: no file, path, symbol, issue, URL or quoted text.
 */
export function isVague(text: string): boolean {
  const t = text.trim()
  if (t.startsWith('/')) return false
  const words = t.split(/\s+/).filter(Boolean).length
  if (words < 2 || words > 60) return false
  return BROAD.test(t) && !ANCHOR.test(t)
}
