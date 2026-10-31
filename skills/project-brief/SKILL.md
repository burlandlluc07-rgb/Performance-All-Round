---
name: project-brief
description: Write or refresh .claude/project-brief.md, a short codebase overview that saves new sessions from re-exploring. Use when asked for a project brief, or when the brief is missing or stale.
---

# Project brief

Write `.claude/project-brief.md`: under 150 lines, so a new session can read it once instead of exploring. The perf plugin points every new session (and every session after /clear or compaction) at this file when it exists.

## Gather cheaply
1. `git ls-files | head -400` and `git ls-files | sed 's|/[^/]*$||' | sort | uniq -c | sort -rn | head -30` for the layout. Do not `ls -R` or read whole trees.
2. Read the manifests only: `package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `Makefile`, CI config. Take scripts, entry points and test commands from them.
3. Read the README's first ~80 lines and any existing CLAUDE.md.
4. For each top-level source folder, Grep for its main exports or entry points and read 20 to 40 lines around them. Delegate this to a subagent if there are more than five folders.

## Write
```
# <project> brief (updated YYYY-MM-DD, commit <short sha>)
## What it is            (2-3 lines)
## How to run / test     (exact commands; the fast check first)
## Layout                (folder -> one line each, only folders that matter)
## Key entry points      (path:line -> what starts there)
## Conventions           (style, naming, error handling, where tests live)
## Gotchas               (things that surprised you; generated files not to edit)
```
Facts only, each one checked against the code. No file contents pasted in. If something is unknown, leave it out.

## Refresh
If the file exists, compare its commit with `git log --oneline <sha>..HEAD -- . | head -50` and update only the sections those commits touch. Keep it under 150 lines; cut the least useful lines first.

Suggest committing it if the team shares the repo, or adding it to `.git/info/exclude` if it is personal.
