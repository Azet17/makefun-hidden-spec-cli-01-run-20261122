# makefun-hidden-spec-cli-01-run-20261122

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Azet17/makefun-hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Azet17/makefun-hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend — one patch tool for every AI edit format: applies unified diffs, SEARCH/REPLACE blocks, V4A patches and JSON edits to a tree of text files, to the SPEC.md contract.

## Run it

```sh
node main.ts
```

`node main.ts [--format=NAME] [--check] [--strict] [PATCH]` — PATCH is the patch file (or `-` / omitted for stdin), and the working directory is the root of the tree. `--format` picks one of `unified`, `search-replace`, `v4a`, `json` (default `auto` detects it). `--check` reports what would change without writing anything; `--strict` matches lines exactly.

Edits are found at the first of three matching tiers (exact, trailing-whitespace-insensitive, trimmed, with re-indentation at the trimmed tier), and every change is written atomically: any failed edit means no file is written at all. Exit codes are 0 (applied), 1 (edits failed, nothing written), 2 (usage, unreadable patch, unknown format, or unparsable patch).

Node 22+ standard library only — no dependencies, no network, no model calls.

---

<sub>Entered on [make.fun](https://make.fun/?ref=3cnb50c1&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
