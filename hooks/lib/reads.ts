// Repeat-read guard state: which (file, range) pairs were read at which
// modification time since the context last started over.

export type ReadKey = { path: string; offset?: number; limit?: number; pages?: string }

export type ReadVerdict =
  | { kind: 'new' }
  | { kind: 'changed' }
  | { kind: 'repeat'; firstSeenTurn: number }
  /** The same repeat asked again right after being refused: let it through. */
  | { kind: 'retry' }

const keyOf = (k: ReadKey): string =>
  `${k.path}|${k.offset ?? ''}|${k.limit ?? ''}|${k.pages ?? ''}`

export class ReadTracker {
  private seen = new Map<string, { mtimeMs: number; turn: number; chars: number }>()
  private lastRefused: string | undefined

  /** Judges a read before it runs. */
  judge(k: ReadKey, mtimeMs: number): ReadVerdict {
    const key = keyOf(k)
    const prior = this.seen.get(key)
    if (!prior) return { kind: 'new' }
    if (prior.mtimeMs !== mtimeMs) return { kind: 'changed' }
    if (this.lastRefused === key) {
      this.lastRefused = undefined
      return { kind: 'retry' }
    }
    return { kind: 'repeat', firstSeenTurn: prior.turn }
  }

  refused(k: ReadKey): void {
    this.lastRefused = keyOf(k)
  }

  /** Size of what a refused repeat would have re-sent, for the savings counter. */
  charsOf(k: ReadKey): number {
    return this.seen.get(keyOf(k))?.chars ?? 0
  }

  record(k: ReadKey, mtimeMs: number, turn: number, chars: number): void {
    this.lastRefused = undefined
    this.seen.set(keyOf(k), { mtimeMs, turn, chars })
  }

  /** The context started over (/clear, compaction): nothing read is in view any more. */
  reset(): void {
    this.seen.clear()
    this.lastRefused = undefined
  }

  /** Distinct files read, most recent last. */
  files(): string[] {
    return [...new Set([...this.seen.keys()].map(k => k.split('|')[0] ?? ''))].filter(Boolean)
  }
}
