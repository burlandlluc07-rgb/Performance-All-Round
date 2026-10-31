// The status line text and the prompt-cache estimate behind it. Pure.

import type { SessionUsage } from 'claude-code'

export type CacheState = {
  /** When the last model response landed (ms since epoch), or undefined before the first. */
  lastResponseAt?: number
  /** Cache lifetime in ms: about 1 h on a subscription, 5 min on an API key. */
  ttlMs: number
}

export const TTL_SUBSCRIPTION_MS = 60 * 60 * 1000
export const TTL_API_MS = 5 * 60 * 1000

/**
 * Subscriptions report rate-limit windows; API-key and cloud-provider sessions
 * do not. That is the only signal the plugin has for the cache lifetime.
 */
export const ttlFor = (usage: Pick<SessionUsage, 'rateLimits'>): number =>
  usage.rateLimits.length > 0 ? TTL_SUBSCRIPTION_MS : TTL_API_MS

export function cacheRemainingMs(cache: CacheState, now: number): number | undefined {
  if (cache.lastResponseAt === undefined) return undefined
  return cache.lastResponseAt + cache.ttlMs - now
}

export function formatDuration(ms: number): string {
  const min = Math.floor(ms / 60000)
  if (min >= 1) return `${min}m`
  return `${Math.max(0, Math.floor(ms / 1000))}s`
}

export const kTokens = (n: number): string =>
  n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)

export type Level = 'ok' | 'warn' | 'high'

export function contextLevel(percent: number | undefined): Level {
  if (percent === undefined || percent < 50) return 'ok'
  return percent < 75 ? 'warn' : 'high'
}

const DOT: Record<Level, string> = { ok: '●', warn: '▲', high: '■' }

export type StatusExtras = {
  savedTokens: number
  runningAgents: number
  mode: string
}

/** One line, e.g. `● ctx 42% 84k/200k · $1.23 · cache warm 52m · 5h 23% · saved ~12k`. */
export function formatStatus(
  usage: SessionUsage,
  cache: CacheState,
  now: number,
  extras: StatusExtras,
): string {
  const parts: string[] = []
  const pct = usage.context.percent
  const level = contextLevel(pct)
  const tokens = usage.context.tokens
  const ctx =
    pct === undefined
      ? `ctx – /${kTokens(usage.context.window)}`
      : `ctx ${pct}%${tokens !== undefined ? ` ${kTokens(tokens)}/${kTokens(usage.context.window)}` : ''}`
  parts.push(`${DOT[level]} ${ctx}${level === 'high' ? ' → /compact' : ''}`)

  if (usage.cost) parts.push(`$${usage.cost.usd.toFixed(2)}`)

  const left = cacheRemainingMs(cache, now)
  if (left !== undefined) {
    parts.push(left > 0 ? `cache warm ${formatDuration(left)}` : 'cache cold')
  }

  for (const rl of usage.rateLimits) {
    const name = rl.kind === 'five_hour' ? '5h' : rl.kind === 'seven_day' ? '7d' : rl.kind
    parts.push(`${name} ${Math.round(rl.percentUsed)}%`)
  }

  if (extras.runningAgents > 0) parts.push(`bg ${extras.runningAgents}`)
  if (extras.savedTokens > 0) parts.push(`saved ~${kTokens(extras.savedTokens)}`)
  if (extras.mode !== 'normal') parts.push(`perf:${extras.mode}`)
  return parts.join(' · ')
}
