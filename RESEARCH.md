# Claude Performance & Token Efficiency — Research Report

_Research date: 2026-10-31. Purpose: groundwork for the **Performance-All-Round** Claude Code plugin. No plugin code yet._

This report covers (1) the most common token-usage and performance problems in Claude / Claude Code, each with its cause and a concrete fix, (2) the techniques that improve efficiency, and (3) a prioritized list of what a plugin (hooks, skills, slash commands, status line, subagents) can automate.

Sources are listed at the end. Official Anthropic docs are treated as authoritative; community figures are marked as anecdotal.

---

## 0. Mental model: where tokens actually go

Three facts explain almost every problem below.

1. **Every request re-sends the whole conversation.** Claude Code sends your full context with every message, and again with every batch of tool results. A one-line question in a session open all day pays for the whole day's history ([costs doc](https://code.claude.com/docs/en/costs)).
2. **Prompt caching makes re-sends cheap, but only while the cache is warm and the prefix is unchanged.** Cache reads cost ~0.1x base input (0.05x on Opus 5.5 / Sonnet 5.5, 0.025x on Fable 5.1). 5-minute cache writes cost 1.25x, 1-hour writes 2x. The cache order is `tools → system → messages`; changing an earlier layer invalidates everything after it ([prompt caching](https://docs.claude.com/en/docs/build-with-claude/prompt-caching)). In Claude Code the cache lasts about **1 hour on a subscription** and **5 minutes on an API key / cloud provider** ([best practices](https://www.anthropic.com/engineering/claude-code-best-practices)).
3. **More context is not just more cost, it is worse output.** Anthropic calls it *context rot*: recall and reasoning degrade as the window fills, so the goal is "the smallest possible set of high-signal tokens" ([context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)).

So the levers are: **keep context small**, **keep the cached prefix stable and warm**, **spend output/thinking tokens only where they pay off**, and **keep verbose work out of the main thread**.

Baseline for scale: enterprise average is ~$13 per developer per active day, $150–250/month, under $30/day for 90% of users. Unexpectedly high spend "usually traces back to long sessions that were never cleared or to Opus left as the default model" ([costs doc](https://code.claude.com/docs/en/costs)).

---

## 1. Problems: cause → fix

Ordered roughly by how much waste they cause in typical use.

### P1. Long sessions that never get cleared (context bloat)
- **Symptom:** usage limits hit fast; responses get slower, vaguer, start forgetting earlier instructions.
- **Cause:** history only grows. Twenty file reads and fifteen diffs from an old debugging task ride along on every later message. Quality also drops from context rot.
- **Fix:** `/clear` when switching to unrelated work (it costs nothing). `/compact <focus>` when you need continuity. Start new sessions per task. Watch context % in the status line.

### P2. Cache misses (idle gaps, prefix changes)
- **Symptom:** a single message after lunch costs as much as rebuilding the whole session.
- **Cause:** the first message after the cache TTL (5 min on API, ~1 h on subscription) reprocesses the full context at write price. Changing tool definitions (connecting/disconnecting MCP servers, enabling plugins), toggling thinking parameters, switching speed mode, or editing the system prompt mid-session invalidates the cache from that layer on.
- **Fix:** before stepping away from a big session, `/compact` or `/clear` it. Don't toggle MCP servers / plugins / model settings mid-session; decide at session start. `/usage` now shows cache hits, misses, "likely cause" of the last miss, and warm/cold state. SessionStart hooks receive `prompt_cache_likely_expired`, `context_tokens` and `estimated_cache_write_usd` on resume, so a hook can warn before a costly resume.

### P3. Bloated always-on context (CLAUDE.md, memory, skill/plugin descriptions)
- **Symptom:** thousands of tokens used before you type anything.
- **Cause:** CLAUDE.md, auto memory, skill descriptions, plugin skill/agent/command descriptions, and MCP tool names load into every request. A 5,000-token CLAUDE.md costs 5,000 tokens per turn (cached, but still counted and still diluting attention). Every enabled plugin adds its descriptions "whether or not the plugin gets used" ([plugin measure](https://code.claude.com/docs/en/plugins/measure)).
- **Fix:** keep CLAUDE.md **under ~200 lines** of essentials; move situational knowledge into **skills** (only the description loads; the body loads on invocation) or **path-scoped rules** (`paths:` frontmatter, loaded only with matching files). Uninstall/disable unused plugins. Keep skill descriptions short and specific. Measure with `/context` and `claude plugin` measurement tools.

### P4. MCP tool overhead
- **Symptom:** a large share of the window is tool schemas; wrong tool picked when many are loaded.
- **Cause:** historically each server injected full schemas up front (one public report: 7 servers ≈ 67k tokens, 33.7% of a 200k window; GitHub MCP alone ≈ 18k tokens — anecdotal). Too many tools also hurts tool selection accuracy. MCP results can be huge (raw JSON, full documents).
- **Fix:** MCP tool definitions are now **deferred by default** (tool search: only names + server instructions load until a tool is used), but names and instructions still cost tokens. Disable unused servers via `/mcp`. **Prefer CLI tools** (`gh`, `aws`, `gcloud`, `sentry-cli`) which add no per-tool listing. For heavy data flows, use the **code-execution pattern**: call MCP from code and return only the derived result (Anthropic's example: 150k → 2k tokens, −98.7%). Trim large MCP outputs with a PostToolUse hook (`updatedToolOutput`).

### P5. Verbose tool output flooding context
- **Symptom:** one `npm test`, build log, `git log`, or `find` dumps 10k+ tokens that stay in history forever.
- **Cause:** raw stdout goes straight into context, then is re-sent every turn.
- **Fix:** preprocess before Claude sees it. The official docs show a **PreToolUse hook on Bash** that rewrites test commands to show only failures, and a hook that greps a 10k-line log for `ERROR` ("tens of thousands of tokens to hundreds"). **PostToolUse** hooks can replace output via `updatedToolOutput`. Use quiet flags (`-q`, `--silent`, `| tail -n 50`), pipe through `head`/`grep`. Delegate log/test triage to a subagent.

### P6. Repeated and whole-file reads
- **Symptom:** the same file is read 3–4 times in a session; a 2,000-line file read to find one function.
- **Cause:** the model re-reads to be safe after edits/failed builds; it reads whole files instead of ranges. Community example: two files read three times ≈ 21k tokens for files that barely changed; reading five 2,000-line files to find two helpers ≈ 30k tokens (anecdotal). A "read-once" hook is reported to cut 60–90% of Read tokens (anecdotal, unverified).
- **Fix:** search first (Grep/Glob with narrow patterns), then Read with `offset`/`limit`. A PreToolUse hook on `Read` can track `(path, mtime, range)` per session and warn or block re-reads of unchanged content. A code-intelligence (LSP) plugin lets Claude jump to definitions instead of reading many files.

### P7. Vague prompts that trigger broad exploration
- **Symptom:** "improve this codebase" → dozens of reads before any work.
- **Cause:** Claude has to discover scope itself.
- **Fix:** name files, functions and the success check. Official example: "add input validation to the login function in auth.ts" vs "improve this codebase". A **UserPromptSubmit** hook can flag prompts with no file/symbol anchors and suggest a narrower ask. A "project brief"/codebase-overview skill removes repeated orientation reads.

### P8. Wrong model or effort for the task
- **Symptom:** high spend on trivial edits; or failed attempts and rework on hard tasks.
- **Cause:** Opus/max effort left as default for everything; thinking tokens are billed as **output** and default budgets can be tens of thousands per request. Conversely, too-small a model on a hard task causes retries that cost more.
- **Fix:** Sonnet for most coding, Opus for complex design/debugging, Haiku for simple subagents (`model: haiku` in subagent frontmatter). Lower effort with `/effort` for simple tasks. On fixed-budget models, `MAX_THINKING_TOKENS=8000`; adaptive models ignore it, use effort instead. Note: model/thinking switches mid-session invalidate parts of the cache, so switch at task boundaries.

### P9. Unnecessary or oversized subagents / agent teams
- **Symptom:** spend jumps when agents are used for simple lookups.
- **Cause:** each subagent starts cold: its own system prompt, CLAUDE.md, tools, and re-discovery of context. Agent teams use **~7x** more tokens than a standard session in plan mode; each teammate keeps consuming until it exits.
- **Fix:** use subagents only when the main-context clutter they prevent exceeds their startup cost (big searches, test/log triage, doc fetching). Give them a cheap model, a tight prompt and `maxTurns`. Keep teams small, use Sonnet for teammates, shut them down when done.

### P10. Compaction that loses the plot (or costs too much)
- **Symptom:** after auto-compact, Claude forgets decisions, re-reads files, repeats mistakes.
- **Cause:** compaction is a lossy summary. `/compact` itself reads the whole conversation (a big request). After compaction Claude Code only re-reads up to **5 recently modified files** (files over 5k tokens come back as references), invoked skill bodies are capped at 5k tokens each / 25k total, and hook-added context is summarized away.
- **Fix:** compact **proactively at task boundaries** rather than letting auto-compact fire mid-task; give `/compact` a focus ("preserve API decisions and failing test names"). Keep a durable notes/plan file (structured note-taking) the agent re-reads after compaction. Use a **SessionStart hook with the `compact` matcher** to re-inject key state; a **PreCompact** hook can snapshot decisions to disk first.

### P11. No verification loop (rework is the most expensive token)
- **Symptom:** Claude declares done, you find bugs, more turns, more context.
- **Cause:** "Claude stops when the work looks done" ([best practices](https://www.anthropic.com/engineering/claude-code-best-practices)). Without a pass/fail check, you become the test suite.
- **Fix:** give Claude a check (tests, typecheck, lint, screenshot). Hooks can run the fast checks after edits (async PostToolUse) and return only a short pass/fail summary.

### P12. Background/idle token drains
- **Symptom:** usage goes up while you're not typing.
- **Cause:** session-scoped scheduled tasks fire with full context; goal check-ins; cross-session messages; background subagents and teammates still running.
- **Fix:** audit `/usage` attribution; set `CLAUDE_CODE_GOAL_CHECKIN_MINUTES=0` if not wanted; stop idle teammates; avoid short-interval loops on huge contexts.

### P13. Verbose model output
- **Symptom:** long preambles, restated plans, echoed file contents and diffs.
- **Cause:** output tokens are the most expensive per token, and they also land in history.
- **Fix:** concise output style / instructions ("don't echo files, cite path:line, no recap"). An output style or short CLAUDE.md rule is cheap and always on.

---

## 2. Techniques that improve performance and efficiency

| Technique | What it does | How to apply in Claude Code |
|---|---|---|
| **Prompt caching** | Re-sent prefix billed at 0.025–0.1x | Automatic. Keep prefix stable: don't change tools/MCP/plugins/thinking mid-session; resume within TTL or clear first |
| **Context hygiene** | Smaller, higher-signal context | `/clear` between tasks, `/compact <focus>` at boundaries, `/context` to inspect |
| **Lean always-on layer** | Cuts per-turn fixed cost | CLAUDE.md < 200 lines; skills and path-scoped rules for situational info; disable unused MCP/plugins |
| **Just-in-time retrieval** | Load data only when needed | Keep lightweight identifiers (paths, queries), let the agent fetch on demand; search before read; ranged reads |
| **Output preprocessing** | Turns 10k-token outputs into 100s | PreToolUse command rewriting, PostToolUse `updatedToolOutput`, quiet flags |
| **Tool result clearing** | Drops stale raw results | Built into Claude Code's context management; also on the API as a context-management feature |
| **Subagent isolation** | Verbose work stays out of main thread; summary of ~1–2k tokens returns | Use for search, logs, tests, doc research; cheap model; `maxTurns` |
| **Structured notes** | Memory outside the window, survives compaction | A NOTES/plan file; plan mode plans are re-injected after compaction |
| **Model & effort routing** | Spend thinking only where it pays | Sonnet default, Opus for hard problems, Haiku subagents; `/effort`; `MAX_THINKING_TOKENS` on fixed-budget models |
| **CLI over MCP** | No schema overhead | `gh`, cloud CLIs; MCP only where no CLI exists |
| **Code execution with MCP** | Process data in sandbox, return only results | Expose MCP as code APIs; return derived answers |
| **Specific prompts + plan mode** | Avoids broad scanning and wrong paths | Name files/symbols/success check; Shift+Tab plan mode for complex work |
| **Verification loop** | Avoids rework turns | Tests/typecheck hooks returning short pass/fail |
| **Measurement** | You can't fix what you can't see | `/usage` (session, cache, attribution, recommendations), `/context`, `/insights`, status line JSON (`context_window`, `cost`, `prompt_cache`, `rate_limits`) |

---

## 3. Platform capabilities the plugin can use

Confirmed in the current docs:

- **Hook events:** `SessionStart` (sources `startup`/`resume`/`clear`/`compact`/`fork`; on resume gets `context_tokens`, `prompt_cache_likely_expired`, `estimated_cache_write_usd`), `UserPromptSubmit`, `PreToolUse` (can rewrite input / block), `PostToolUse` (`additionalContext`, `updatedToolOutput` to replace what Claude sees), `PostToolBatch`, `SubagentStart` (inject context into subagents), `SubagentStop`, `Stop`, `PreCompact`, `PostCompact`, `SessionEnd`, `PreModelSwitch`/`PostModelSwitch`, `FileChanged`, `InstructionsLoaded`, and more. Async hooks can run tests in the background and report back.
- **Status line:** receives JSON with `model`, `context_window` (`used_percentage`, `total_input_tokens`, `current_usage`), `cost.total_cost_usd`, durations, `prompt_cache`, and `rate_limits` (`five_hour`, `seven_day`). **A plugin cannot register a status line by itself**: `statusLine` is read only from settings.json, so the plugin needs a one-time install command that writes it (with backup).
- **Skills:** description always loaded, body on demand. Good for playbooks (targeted reading, compaction guide, project brief).
- **Subagents:** frontmatter supports `model` and `maxTurns`; plugin agents are namespaced `plugin:name`.
- **Slash commands:** for audits, reports, mode switching.
- **Plugin cost:** every skill/agent/command description in the plugin is always-on cost. The performance plugin must itself be lean, or it defeats its purpose.

---

## 4. What the plugin should automate (prioritized)

Priority = (waste addressed × how often it occurs) ÷ (risk + build effort). P0 = build first.

### P0 — biggest wins, low risk
1. **Status line: context %, cost, cache state, rate-limit %** (status line + install command).
   Shows context fill with colour thresholds (e.g. green < 50%, yellow 50–75%, red > 75%), session cost, cache warm/cold and time to expiry, 5-hour/weekly limit usage. Addresses P1, P2, P12 by making waste visible. Needs a `/perf:install-statusline` command because plugins can't set `statusLine` directly.
2. **Verbose output compressor** (PreToolUse on Bash + PostToolUse).
   Rewrite known noisy commands (test runners, builds, package installs, `git log`, `find`, `ls -R`) to quiet/failure-only forms; truncate any tool output over N tokens to head + tail + error lines with a pointer to a saved full log. Bypass via an env prefix. Addresses P5, P4 (MCP output).
3. **Repeat-read guard** (PreToolUse on Read, session state file).
   Track path + mtime + range; on an unchanged re-read, return a short notice instead of re-sending, or let it through once with a warning. Nudge toward ranged reads on large files. Addresses P6.
4. **Context hygiene nudges** (UserPromptSubmit + Stop).
   When context passes thresholds, or the new prompt looks unrelated to the session's topic, inject a one-line suggestion to `/compact <focus>` or `/clear`. Addresses P1, P10.
5. **Lean context rules skill / output style** (one small skill + short guidance).
   Search-before-read, ranged reads, no echoing files, cite path:line, CLI over MCP, concise answers. Addresses P6, P7, P13. Must be tiny (always-on cost).

### P1 — strong value, moderate effort
6. **Cache-aware resume warning** (SessionStart `resume`).
   Use `prompt_cache_likely_expired` and `estimated_cache_write_usd` to warn "resuming will re-write ~120k tokens (~$X); consider /compact or /clear". Also warn before mid-session MCP/plugin/model changes (PreModelSwitch). Addresses P2.
7. **Compaction safety net** (PreCompact + SessionStart `compact`).
   Before compaction, write a structured snapshot (goal, decisions, open bugs, files in play, failing tests) to `.claude/perf/state.md`; after compaction, re-inject a compact version. Addresses P10.
8. **`/perf:audit` command** (read-only).
   Measure always-on cost: CLAUDE.md size (flag > 200 lines), MCP servers and their tool counts, enabled plugins and their description sizes, skills count, hooks; suggest which to disable or move into skills/path-scoped rules. Addresses P3, P4.
9. **Model/effort advisor** (UserPromptSubmit, advisory only).
   Classify the prompt (trivial edit / normal / hard reasoning) and suggest `/effort` or `/model` changes at task boundaries only (to avoid cache invalidation). Addresses P8.
10. **Cheap subagents** (plugin agents with `model: haiku`, `maxTurns`).
    A quick-reader/summarizer and a log/test triager so verbose work stays out of the main thread at low cost. Plus a SubagentStart hook that injects the lean rules into every subagent. Addresses P5, P9.

### P2 — nice to have
11. **`/perf:report`** — session breakdown from the transcript: tokens by tool, largest outputs, repeated reads, cache hit rate, top offenders, with recommendations.
12. **Verification hook** — async PostToolUse that runs the project's fast check after edits and returns a one-line pass/fail (configurable per repo). Addresses P11.
13. **Prompt specificity hint** — UserPromptSubmit flag for vague prompts with no files/symbols (opt-in; can annoy).
14. **Project brief skill** — generate/refresh a < 150-line codebase overview so new sessions skip orientation reads.
15. **Idle drain detector** — flag running scheduled tasks, teammates, and background agents in the status line. Addresses P12.
16. **Modes** — `/perf:mode off|normal|strict` controlling how aggressive compression and blocking are.

### Design principles for the build
- **The plugin must be cheap itself.** Few skills, short descriptions, hooks over instructions (hooks cost zero context unless they inject).
- **Never hide information irreversibly.** Truncated output is saved to disk with a path Claude can read on demand; provide a raw bypass.
- **Advise, don't block, by default.** Blocking reads/commands can cause loops; `strict` mode opts into blocking.
- **Don't break the cache.** Inject context via `additionalContext` on the current turn, not by changing tools or system prompt mid-session.
- **Fast hooks.** Hooks run on every tool call; keep them in the tens of milliseconds, fail open, and log timings.
- **Measure savings.** Keep counters (tokens saved by compression, blocked re-reads) so `/perf:report` can prove value.

---

## Sources

Official Anthropic:
- [Manage costs effectively — Claude Code Docs](https://code.claude.com/docs/en/costs)
- [Explore the context window — Claude Code Docs](https://code.claude.com/docs/en/context-window)
- [Best practices for Claude Code](https://www.anthropic.com/engineering/claude-code-best-practices)
- [Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- [Code execution with MCP](https://www.anthropic.com/engineering/code-execution-with-mcp)
- [Prompt caching — Claude Platform Docs](https://docs.claude.com/en/docs/build-with-claude/prompt-caching)
- [Hooks reference — Claude Code Docs](https://code.claude.com/docs/en/hooks)
- [Customize your status line — Claude Code Docs](https://code.claude.com/docs/en/statusline)
- [Measure plugin cost and usage — Claude Code Docs](https://code.claude.com/docs/en/plugins/measure)
- [Models, usage and limits in Claude Code — Claude Help Center](https://support.claude.com/en/articles/14552983-models-usage-and-limits-in-claude-code)

Community (anecdotal figures, use with care):
- [MCP context bloat: the 2026 fixes that actually work — mcp.directory](https://mcp.directory/blog/mcp-context-bloat-fix-2026-tool-search-code-mode-progressive-disclosure)
- [Claude Code Context Window: Limits, Compaction — Morph](https://www.morphllm.com/claude-code-context-window)
- [9 Ways to Cut Token Consumption in Claude Code — Composio](https://composio.dev/blog/ways-to-cut-token-consumption-in-claude-code)
- [7 Practical Ways to Reduce Claude Code Token Usage — KDnuggets](https://kdnuggets.com/7-practical-ways-to-reduce-claude-code-token-usage)
- [23 Tips for Claude Code Token Saving — Analytics Vidhya](https://www.analyticsvidhya.com/blog/2026/05/tips-for-claude-code-token-saving/)
- [Claude Code Burning Through Tokens? 8 Fixes — ai-muninn](https://ai-muninn.com/en/blog/dev-workflow-token-burn-rate)
- [How to Handle Claude Code Token Limits in Large Projects — fast.io](https://fast.io/resources/claude-code-token-limit-workarounds/)
- [claude-usage-analyzer — GitHub](https://github.com/SingggggYee/claude-usage-analyzer)
