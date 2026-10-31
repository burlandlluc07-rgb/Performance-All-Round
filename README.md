# Performance-All-Round

A Claude Code plugin (`perf`) that cuts token waste and keeps long sessions fast. It is built from the problems and fixes in [RESEARCH.md](RESEARCH.md): it makes context and cache cost visible, keeps verbose output and repeat reads out of the context window, and prompts you to `/compact` or `/clear` before a session gets expensive.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install perf --marketplace burlandlluc07-rgb/Performance-All-Round
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in every session). From a shell: `claude plugin install perf --marketplace burlandlluc07-rgb/Performance-All-Round`. In the desktop app: + next to the prompt box, Plugins, Add marketplace `burlandlluc07-rgb/Performance-All-Round`, then Add plugin.

The plugin is written as a function-hooks module (`hooks/register.ts`), an early-access Claude Code API (2.1.3xx). It needs a Claude Code build with hooks modules turned on.

## What it does

| Piece | What you see | Research item |
|---|---|---|
| **Status line** | `● ctx 42% 84k/200k · $1.23 · cache warm 52m · 5h 23% · saved ~12k`. The dot turns ▲ at 50% and ■ at 75% (with `→ /compact`). Cache shows warm with time left, or cold. Running background agents show as `bg N`. No settings.json edit needed. | P1, P2, P12 |
| **Output compressor** | Bash output over ~8k characters (MCP over ~16k) is cut to its first 40 and last 60 lines plus up to 40 error/warning lines from the middle. The full output is saved to `.claude/perf/raw/` and the cut says where. Prefix a command with `PERF_RAW=1` to skip it. | P4, P5 |
| **Repeat-read guard** | Reading the same file and range again when it has not changed is refused once, with a note that the content is already in context. Repeating the same Read goes through, so nothing is ever lost. Tracked per subagent and reset after `/clear` and compaction. A whole-file read over 500 lines gets a one-time hint to Grep first. | P6 |
| **/compact and /clear prompts** | A toast at 50% context (compact at the next task boundary, or clear if switching work) and at 75% (compact now). | P1, P10 |
| **Cache warnings** | A toast 3 minutes before a 1-hour cache expires on a large session, after a message sent to a cold cache, on resuming a session whose cache expired (with the estimated re-write cost), and before a model switch that throws away a warm cache. | P2 |
| **Compaction safety net** | Before any compaction, the summarizer is told to keep the goal, decisions, open bugs and failing tests, plus the files you edited and the last failing command. The same state goes to `.claude/perf/state.md` and is handed back to Claude right after compaction. | P10 |
| **Lean working rules** | Five short lines added to the system prompt (search before reading, ranged reads, no re-reads or echoing, quiet commands, concise answers). Fixed text, so it never breaks the prompt cache. The `lean-rules` skill holds the longer playbook. | P6, P7, P13 |
| **`perf:log-triager` agent** | A Haiku subagent capped at 8 turns that runs a test/build command or reads a log and returns only the failures. | P5, P9 |
| **`/perf`** | `/perf` or `/perf report`: context, cost, cache, limits, and what the plugin saved this session and across sessions. `/perf audit`: always-on context by category, oversized CLAUDE.md files, MCP servers by schema cost with unused ones flagged, skill listing size, with suggestions. `/perf mode off\|normal\|strict`: off keeps only the status line; strict compresses above ~3k characters and prompts at 40% and 60%. | P3, P4, P8 |

Everything fails open: if a hook errors, Claude Code carries on as if the plugin were not there. The plugin writes only under `.claude/perf/` in your project, with a `.gitignore` so nothing shows up in `git status`.

## Not built yet

From RESEARCH.md section 4: the model/effort advisor (9), the post-edit verification hook (12), the vague-prompt hint (13) and the project-brief skill (14). Topic-change detection for `/clear` (part of 4) is also left out; the prompts are threshold-based.

## Developing

```
claude plugin validate .          # manifest, hooks module, marketplace
claude plugin test .              # tests/perf.test.ts against the engine's test kit
claude --plugin-dir .             # run a session with the working copy
```

`hooks/lib/` holds the pure parts (compression, read tracking, status text); `hooks/register.ts` wires them to Claude Code events.
