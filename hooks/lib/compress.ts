// Output compression: keeps the head, the tail and the error-looking lines of
// a long tool output, and says where the full text was saved.
// Pure functions only, so they can be unit-tested without the engine.

export type CompressOptions = {
  /** Outputs at or under this many characters pass through untouched. */
  thresholdChars: number
  headLines: number
  tailLines: number
  /** Most error-looking lines kept from the elided middle. */
  maxSignalLines: number
}

export type Compressed = {
  text: string
  /** Characters removed (original length minus new length). */
  savedChars: number
}

const SIGNAL =
  /\b(error|errors|fail|failed|failing|failure|exception|traceback|panic|fatal|assert(ion)?|warn(ing)?|denied|not found|undefined reference|segfault)\b|✗|✖|FAIL|ERR!/i

/** Rough token estimate used across the plugin: about four characters a token. */
export const approxTokens = (chars: number): number => Math.round(chars / 4)

/**
 * Compresses `text` when it is longer than the threshold. Returns null when it
 * is short enough to keep, or when compressing would not save anything.
 */
export function compressOutput(
  text: string,
  opts: CompressOptions,
  rawPath: string | undefined,
  /** How to get the output uncompressed; the Bash default names PERF_RAW=1. */
  bypass: string = BASH_BYPASS,
): Compressed | null {
  if (text.length <= opts.thresholdChars) return null
  const lines = text.split('\n')
  const keep = opts.headLines + opts.tailLines
  if (lines.length <= keep) {
    // Few but very long lines (minified output, JSON): cut by characters.
    const half = Math.floor(opts.thresholdChars / 2)
    const head = text.slice(0, half)
    const tail = text.slice(-half)
    const out = `${head}\n${marker(text.length - head.length - tail.length, 'chars', rawPath, bypass)}\n${tail}`
    return out.length < text.length ? { text: out, savedChars: text.length - out.length } : null
  }

  const head = lines.slice(0, opts.headLines)
  const tail = lines.slice(lines.length - opts.tailLines)
  const middle = lines.slice(opts.headLines, lines.length - opts.tailLines)
  const signal: string[] = []
  for (const line of middle) {
    if (signal.length >= opts.maxSignalLines) break
    if (SIGNAL.test(line)) signal.push(clip(line, 400))
  }
  const elided = middle.length - signal.length
  const parts = [...head.map(l => clip(l, 400))]
  parts.push(marker(elided, 'lines', rawPath, bypass))
  if (signal.length > 0) {
    parts.push(`[perf: ${signal.length} error/warning line(s) from the elided part:]`, ...signal)
  }
  parts.push(...tail.map(l => clip(l, 400)))
  const out = parts.join('\n')
  return out.length < text.length ? { text: out, savedChars: text.length - out.length } : null
}

export const BASH_BYPASS = 'Prefix a command with PERF_RAW=1 to skip compression.'

function marker(count: number, unit: 'lines' | 'chars', rawPath: string | undefined, bypass: string): string {
  const where = rawPath ? ` Full output: ${rawPath} (Read a slice with offset/limit if you need it).` : ''
  return `[perf: ${count} ${unit} elided.${where}${bypass ? ` ${bypass}` : ''}]`
}

/**
 * The text of an MCP tool's response with its line breaks, so compression can
 * keep error lines: a string, a content-block array or `{ content: [...] }`
 * of text blocks. Undefined for anything else (images, structured content),
 * which is left alone. One-line JSON text is re-indented so it splits into lines.
 */
export function mcpText(response: unknown): string | undefined {
  let text: string | undefined
  if (typeof response === 'string') text = response
  else {
    const blocks = Array.isArray(response)
      ? response
      : response && typeof response === 'object' && Array.isArray((response as { content?: unknown }).content)
        ? (response as { content: unknown[] }).content
        : undefined
    if (!blocks || !blocks.every(b => b && typeof b === 'object' && (b as { type?: unknown }).type === 'text')) return undefined
    text = blocks.map(b => String((b as { text?: unknown }).text ?? '')).join('\n')
  }
  const t = text.trim()
  if ((t.startsWith('{') || t.startsWith('[')) && t.split('\n').length < 5) {
    try {
      return JSON.stringify(JSON.parse(t), null, 1)
    } catch {
      // not JSON after all
    }
  }
  return text
}

function clip(line: string, max: number): string {
  return line.length > max ? `${line.slice(0, max)}… [+${line.length - max} chars]` : line
}

/** True when the person or model asked for the raw output of this command. */
export const wantsRaw = (command: string): boolean => /(^|\s|;|&&)PERF_RAW=1\b/.test(command)
