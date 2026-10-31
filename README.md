# Performance-All-Round

`perf` is a Claude Code plugin that cuts token waste and keeps long sessions fast. It shows what context and the prompt cache are costing, keeps verbose output and repeat reads out of the context window, and tells you when to `/compact` or `/clear`. The research behind each piece is in [RESEARCH.md](RESEARCH.md).

## Install

In a Claude Code terminal session:

```
/plugin install perf --marketplace burlandlluc07-rgb/Performance-All-Round
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in every session). From a shell, run `claude plugin install perf --marketplace burlandlluc07-rgb/Performance-All-Round`. In the desktop app, click + next to the prompt box, then Plugins, Add marketplace `burlandlluc07-rgb/Performance-All-Round`, then Add plugin.

`perf` is a function-hooks module (`hooks/register.ts`), an early-access Claude Code API (2.1.3xx). It needs a build with hooks modules turned on.

## What it does

### See the cost

- **Status line.** For example: `● ctx 42% 84k/200k · $1.23 · cache warm 52m · 5h 23% · saved ~12k`.
  - The dot turns ▲ at 50% context and ■ at 75%, where it also adds `→ /compact`.
  - `cache warm 52m` counts down to `cache cold`.
  - Running background agents show as `bg N`.
  - No settings.json edit is needed.
- **Notices.** One-line `● perf:` messages in the transcript. Claude never reads them, so they cost no tokens. They cover:
  - context at 50% (compact at the next task boundary, or clear when switching work) and at 75% (compact now)
  - the prompt cache expiring in 3 minutes on a large session (caches of 10 minutes or more)
  - a message that went to a cold cache
  - resuming a session whose cache expired, with the estimated cost of re-writing it

### Keep tokens out of context

- **Output compressor.** Bash output over ~8k characters, and connector (MCP) text over ~16k, is cut to its first 40 and last 60 lines plus up to 40 error or warning lines from the middle.
  - The full output is saved to `.claude/perf/raw/`, and the cut says where.
  - Prefix a command with `PERF_RAW=1` to skip compression.
- **Repeat-read guard.** Re-reading the same unchanged file and range is refused once, with a note that it is already in context. Repeating the Read lets it through, so nothing is lost.
  - Reads are tracked per subagent and reset after `/clear` and compaction.
  - A whole-file read over 500 lines gets a one-time hint to Grep first.
- **Compaction safety net.** Before any compaction, the summarizer is told to keep the goal, decisions, open bugs and failing tests, plus the files edited and the last failing command. That state is also saved to `.claude/perf/state.md` and handed back to Claude right after compaction.
- **Lean working rules.** Five fixed lines in the system prompt: search before reading, ranged reads, no re-reads or echoing, quiet commands, concise answers. Fixed text never breaks the prompt cache. The `lean-rules` skill has the longer playbook.
- **`perf:log-triager`.** A Haiku subagent, capped at 8 turns, that runs a test or build command, or reads a log, and returns only the failures.

### Steer the work

- **Model/effort advisor.** On the first prompt of a task, a notice when the setup doesn't fit: a small edit on Opus or high effort ("`/model sonnet` would do it for less"), or a hard problem on Haiku.
  - It only advises, and only at task boundaries, so following it never throws away a warm cache.
  - It uses local heuristics, with no model call.
- **Post-edit check.** When Claude stops after editing files, your `check` command runs.
  - On failure, Claude is sent back with the last 30 lines of output, at most twice in a row.
  - On success, you get a one-line notice.
- **Vague-prompt hint.** A notice when a prompt asks for broad work ("improve this codebase") without naming a file, function, path or check.
- **Project brief.** The `project-brief` skill writes `.claude/project-brief.md`, a codebase overview under 150 lines. While that file exists, every new session (and every one after `/clear` or compaction) is pointed to it instead of re-exploring.

## Commands

| Command | What it does |
|---|---|
| `/perf` or `/perf report` | Context, cost, cache, limits, and what the plugin saved this session and across sessions |
| `/perf audit` | Always-on context by category, oversized CLAUDE.md files, MCP servers by schema cost (unused ones flagged) and skill listing size, with suggestions |
| `/perf check` | Runs the post-edit check now |
| `/perf mode off\|normal\|strict` | `off` keeps only the status line. `strict` compresses from ~3k characters, prompts at 40% and 60%, and turns on the vague-prompt hint |

## Settings

Optional, in `.claude/perf.json` in your project:

```json
{
  "check": "npm run -s typecheck && npm test --silent",
  "checkTimeoutMs": 120000,
  "vaguePromptHint": true,
  "modelAdvisor": true,
  "cacheTtlMinutes": 60
}
```

| Key | Default | Meaning |
|---|---|---|
| `check` | none (off) | Shell command for the post-edit check |
| `checkTimeoutMs` | `120000` | How long the check may run |
| `vaguePromptHint` | on in strict mode only | Turns the vague-prompt hint on or off |
| `modelAdvisor` | `true` | Turns the model/effort advisor on or off |
| `cacheTtlMinutes` | 60 on a subscription, 5 on an API key | Prompt-cache lifetime. Set it to `60` on an API key with the 1-hour cache |

## Good to know

- Everything fails open: if a hook errors, Claude Code carries on as if the plugin were not there.
- The plugin writes only under `.claude/perf/`, with a `.gitignore` so nothing shows up in `git status`.
- Claude Code already moves outputs over about 30k characters to a file and shows Claude a preview. The compressor's savings therefore come from outputs between ~8k and ~30k characters.
- `/clear` prompts are threshold-based; the plugin does not detect a change of topic.

## Developing

```
claude plugin validate .     # manifest, hooks module, marketplace
claude plugin test .         # tests/ against the engine's test kit
claude --plugin-dir .        # run an interactive session with the working copy
```

`hooks/lib/` holds the pure parts (compression, read tracking, status text, prompt heuristics). `hooks/register.ts` wires them to Claude Code events.

MIT licensed.
