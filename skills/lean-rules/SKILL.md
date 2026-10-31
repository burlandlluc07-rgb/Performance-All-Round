---
name: lean-rules
description: Token-lean working playbook - read before exploring a large codebase, reading big files or logs, or when context is filling up.
---

# Lean working rules

The always-on version of these rules is already in the system prompt. This is the longer playbook.

## Reading code
1. Locate first: `Grep` for the symbol or string, `Glob` for the file name. Narrow the path and the pattern.
2. Read only the lines you need: `Read` with `offset`/`limit` around the match (about 40 to 120 lines).
3. Do not re-read a file you already have unless it changed. The perf plugin refuses an unchanged re-read once; repeat the exact Read if the earlier output is really gone.
4. A whole-file read over ~500 lines is almost always a sign to search first.

## Commands and logs
- Use quiet forms: `npm test --silent`, `pytest -q`, `cargo test -q`, `git log --oneline -20`, `ls` over `ls -R`.
- Filter before printing: `| tail -n 50`, `| grep -E "error|FAIL"`.
- Long outputs are compressed to head, tail and error lines; the full text is in `.claude/perf/raw/`. Read a slice of it if you need more. Prefix a command with `PERF_RAW=1` to skip compression.
- Hand log and test triage to the `perf:log-triager` agent when the output would be large; keep only its summary.

## Answers
- No preamble, no restated plan, no recap. Do not echo file contents or diffs back; cite `path:line`.

## Context hygiene
- Suggest `/clear` when the person switches to unrelated work, and `/compact <what to keep>` at task boundaries once context passes about half.
- Before compacting, make sure decisions, open bugs, failing tests and next steps are written down in the conversation or a notes file.
