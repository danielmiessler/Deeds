---
name: deeds
description: Measures the work in a code repo as deeds (caps, fixes and tends) by running the bundled `deeds` CLI over the commit history, for this repo or any GitHub repo, over any time window. Reports totals, a week-by-week trend, a per-author breakdown and the named caps, and explains what the numbers mean.
when_to_use: Use when the user asks about deeds or how much real work went into a codebase. Triggers include "show me deeds progress", "deeds progress", "deeds report", "run deeds", "how many deeds", "how many caps did we ship", "what did we ship this week / month / quarter", "how much work did I do", "what did I get done", "analyze this repo with deeds", "run deeds on github.com/owner/repo", "deeds for the last 90 days", "who did the most work", "deeds by author", "compare this month to last month", "what is a cap / fix / tend", "how does deeds work", "set up deeds". NOT FOR counting PRs or commits alone (use git or gh directly).
allowed-tools: Bash(deeds:*)
---

# Deeds

Deeds counts work by what changed in the product, not by how many PRs or commits there were. Every commit's diff is judged into zero or more deeds:

- **cap**: a capability gained or deepened. The product can do something it couldn't, or does an existing thing more fully. A cap that regresses or is removed counts -1.
- **fix**: something moved from broken to sound, security fixes included.
- **tend**: upkeep nobody sees, such as refactors, dependency bumps, performance and tests.

## Done looks like

The user gets three separate numbers (caps, fixes and tends) for the repo and window they meant, how those numbers moved week by week, and the caps by name. They also learn how many commits were read and how many could not be judged. The three counts are never added into one score, and no kind of app is weighted above another.

## Workflow routing

| The user wants | Workflow |
|---|---|
| Progress on the repo they're in ("show me deeds progress", "what did we ship this week") | Progress |
| Deeds for another repo, a GitHub URL or a specific window | Analyze |
| Who did what, or one period against another | Compare |
| What deeds are, or why not PRs | Explain |
| It fails with a key, bun or install error | Setup |

**Progress.** From the repo root, run `deeds analyze . --since <window> --json`:

| The user says | Window |
|---|---|
| "this week" | `7d` |
| "this month" | `30d` |
| nothing about time | `90d` |

Lead with the three totals, then the weekly trend, then the caps by name.

**Analyze.** Run `deeds analyze <target> --since <window> [--until <date>] --json`. The target is a local folder or `github.com/owner/repo`. Public GitHub repos are cloned over HTTPS into `~/.cache/deeds/repos`. Report it the way Progress does.

**Compare.** Read `data.authors` for a by-author view. To compare periods, run twice with `--since` and `--until` and set the totals side by side. Results are cached per commit, so repeat runs are fast and make no model calls.

**Explain.** Use the definitions above. Why not PRs: a PR is a review step built for collaboration, and it shows that code changed, not that the product got better. One person working with agents often never opens one. Deeds is an early proposal, so say so, and point to https://workdeeds.ai.

**Setup.**

| Error | Fix |
|---|---|
| `missing_key` | Deeds judges commits with Jev on the user's own Jev key, which is the only key it needs. Set `TYPESAFE_API_KEY` (get a key at https://typesafe.ai). No OpenAI or Anthropic key is required. |
| bun missing | Install it from https://bun.sh. |
| CLI not found | Run `curl -fsSL https://raw.githubusercontent.com/danielmiessler/deeds/main/install.sh \| sh`. |
| Key lives in a file | Point `~/.config/deeds/config.json` at it: `{ "keys": { "typesafe": { "envFile": "<path>", "var": "TYPESAFE_API_KEY" } } }`. |
| `sandbox_unavailable` from `extract` or `doctor` | Off macOS there is no OS sandbox. Add `--allow-unsandboxed`. |

## CLI reference

```
deeds analyze [path | github.com/owner/repo] [--since 90d] [--until <date>] [--mode jev|full] [--vendor anthropic|openai] [--model <id>] [--json]
deeds analyze-many <list-file> [--since 90d] [--until <date>] [--mode jev|full] [--out <dir>] [--json]   # one path or github.com URL per line; one report per repo plus summed totals
deeds extract [path] [--rev <commit>] [--json]   # routes, CLI commands, UI handlers and exports
deeds help --json                                # every command, its usage and exit codes
deeds doctor                                     # how the no-network guarantee is enforced here
deeds version
```

`--since` takes `7d`, `2w`, `6m`, `1y`, `all`, or anything git understands (`2026-01-01`, `"last monday"`).

With `--json`, stdout is one line. On success it is `{"ok":true,"command":"analyze","data":{...}}`, and on failure `{"ok":false,"error":{"code","message"}}`. The `data` fields are:

| Field | Contents |
|---|---|
| `repo` | the repo analyzed |
| `window` | `since`, `until`, `first`, `last` |
| `commits` | number of commits read |
| `judged` | commits judged; `judged` plus the length of `failed` always equals `commits` |
| `totals` | `cap`, `fix`, `tend` |
| `weeks[]` | `week` (the Monday), then `cap`, `fix`, `tend` |
| `authors[]` | `author`, then `cap`, `fix`, `tend` |
| `caps[]` | `name`, `change` (new, deepened, regressed or removed), `sha`, `author`, `date` |
| `failed[]` | `sha`, `error`; empty in a `--json` success document, because an incomplete run fails instead |
| `redactions` | secret-shaped strings removed before sending |
| `cached` | commits served from the cache |

Exit codes: 0 ok, 1 error, 2 usage, 3 denied. If any commit could not be judged, a `--json` run returns `{"ok":false,"error":{"code":"incomplete"}}` with exit 1; rerun it, since judged commits are cached.

## Gotchas

- **A Jev key is the only key needed.** The default judge is Jev; a 700-commit history takes well under a minute. `--mode full` is an optional slower reference read that needs an Anthropic or OpenAI key.
- **The text and JSON outputs differ.** Parse only `--json`. The plain-text form is for people and can change.
- **Merge commits are counted but rarely add deeds.** A clean merge has an empty diff, so it yields no deeds and costs no model call. A merge that resolved conflicts is judged on that resolution only.
- **Commit messages are never read.** If someone asks why "feat: X" wasn't counted as a cap, the reason is that its diff didn't add a capability.
- **Only the diff and its changed file paths leave the machine,** and only to Jev (api.typesafe.ai), or to Anthropic or OpenAI under `--mode full`. Strings shaped like secrets are redacted first. Mention this if the user asks about privacy.
