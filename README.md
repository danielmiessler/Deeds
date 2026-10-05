<p align="center">
  <a href="https://workdeeds.ai"><img src="images/workdeeds.png" alt="The workdeeds.ai home page: A New Way to Measure Work Done with AI" width="900"></a>
</p>

<h1 align="center">Deeds</h1>

<p align="center"><b>Measure the work in a code repo by what got better, not by how many PRs were opened.</b></p>

<p align="center">
  <a href="https://workdeeds.ai"><img src="https://img.shields.io/badge/site-workdeeds.ai-F2A93B" alt="workdeeds.ai"></a>
  <a href="https://github.com/danielmiessler/deeds/releases/latest"><img src="https://img.shields.io/github/v/release/danielmiessler/deeds?color=0F2C2E" alt="Latest release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-97C09F" alt="MIT license"></a>
</p>

Pull requests and commit counts measure activity. They show that code changed, not whether the product got better. A refactor, a revert and a typo fix count the same as a new feature, and someone building alone with AI agents may never open a PR at all.

Deeds reads the diff of every commit in a window and asks what that change did to the product. A change that made it better is a **deed**, and every deed is one of three kinds:

| Kind | What it means | Example |
| --- | --- | --- |
| **cap** | A capability gained or deepened. The product can do something it couldn't before, or does an existing thing more fully. | added CSV export to reports |
| **fix** | Something moved from broken to working. Security fixes count here. | stopped logging session tokens |
| **tend** | Upkeep users never see: refactors, dependency bumps, performance work, tests. | bumped hono to 4.6 |

Renames, reverts and busywork produce no deeds. Commit messages are never read, so a commit called "feat: X" only counts as a cap if its diff adds one. The three counts stay separate and are never blended into one score. The argument for all of this is at [workdeeds.ai](https://workdeeds.ai).

## What you get

A real run over the last 90 days of [microsoft/TypeScript](https://github.com/microsoft/TypeScript), 396 commits, judged with nothing but a Jev key:

<p align="center"><img src="examples/typescript.svg" alt="deeds terminal report for github.com/microsoft/TypeScript over 90 days: 73 caps, 195 fixes, 172 tends, week by week, by author, and the newest caps by name" width="760"></p>

Add `--html report.html` and you also get a self-contained page with the same numbers: totals with weekly sparklines, a week-by-week chart, authors and every cap by name. It opens offline and can be mailed as is.

<p align="center"><a href="https://workdeeds.ai/example-report"><img src="examples/typescript-html.png" alt="The deeds HTML report for microsoft/TypeScript over 90 days: 73 caps, 195 fixes and 172 tends with weekly sparklines, a week-by-week chart per kind, and a by-author table" width="800"></a></p>

Open [the full page for this run](https://workdeeds.ai/example-report). Its source is [`examples/typescript.html`](examples/typescript.html), with the plain-text and JSON forms beside it.

`+` is a new capability, `↑` a deepened one, `↓` a regressed one and `−` a removed one. Cap names come from the code itself: the route, command, UI handler or export the commit added, or else the part of the product it changed most. The full report also has a week-by-week trend and a breakdown by author, and `--json` gives you all of it as one JSON document.

## Install

You need [bun](https://bun.sh) and a Jev key. That is the only key deeds needs: no OpenAI or Anthropic key. Get one at [typesafe.ai](https://typesafe.ai), then:

```sh
export TYPESAFE_API_KEY=...
```

```sh
curl -fsSL https://raw.githubusercontent.com/danielmiessler/deeds/main/install.sh | sh
```

That runs [`install.sh`](install.sh) from this repo. It puts the CLI in `~/.local/share/deeds` and a `deeds` command in `~/.local/bin`, and never uses elevated privileges. It downloads one tarball from this repo's latest release, checks its sha256 against the published checksum, and refuses to install if they differ. To pin the checksum yourself, set `DEEDS_SHA256`.

Check it worked:

```sh
deeds version
```

## Claude Code plugin

The plugin bundles the CLI and a skill that knows how to run it, so you can ask in plain words.

```
/plugin marketplace add danielmiessler/deeds
/plugin install deeds@workdeeds
```

Then ask Claude Code something like "show me deeds progress". It runs `deeds analyze . --json` on the repo you are in and answers with the three counts, the week-by-week trend and the caps by name.

The first run installs the CLI's locked dependencies with `bun install --frozen-lockfile`. That is the only download the plugin makes, and later runs start without touching the network. If your Jev key lives in a file instead of your environment, point `~/.config/deeds/config.json` at it:

```json
{ "keys": { "typesafe": { "envFile": "~/.secrets/.env", "var": "TYPESAFE_API_KEY" } } }
```

## Usage

```sh
deeds analyze [path | github.com/owner/repo] [--since 90d] [--until <date>] [--mode jev|full] [--vendor anthropic|openai] [--model <id>] [--html <file>] [--color|--no-color] [--json]
deeds analyze-many <list-file> [--since 90d] [--until <date>] [--mode jev|full] [--out <dir>] [--json]
deeds extract [path] [--rev <commit>] [--json]
deeds help --json
deeds doctor
deeds version
```

`analyze` takes a local folder or a public GitHub repo and any window: `7d`, `2w`, `6m`, `1y`, `all`, or anything git understands, such as `2026-01-01`. It reports the totals, a week-by-week trend, a breakdown by author and the caps by name.

```sh
export TYPESAFE_API_KEY=...
deeds analyze . --since 30d
deeds analyze github.com/owner/repo --since all
deeds analyze-many repos.txt --since 90d --out reports/
deeds analyze . --since 6m --html report.html
```

The terminal report is in colour on a terminal and plain when piped; `--color` and `--no-color` override that, and `NO_COLOR` is honoured. A long window is shown by month instead of by week.

`analyze-many` takes a file with one local path or github.com URL per line (blank lines and `#` comments are skipped) and writes one JSON report per repo, plus totals across all of them.

Every commit is judged by Jev: code reads the diff into exact facts (files touched, routes and commands added or removed, how big the change is), Jev answers a short set of typed questions about it, and a fixed policy turns facts and answers into deeds. In our benchmark on a public repo with 717 commits, Jev judged every commit in about 16 seconds and landed within 10% of a full GPT model's counts for caps, fixes and tends. A first run through the CLI also clones the repo and reads each diff, so it takes longer. `--mode full` is an optional reference mode in which a large model reads each diff in full; it is slower and needs an Anthropic or OpenAI key, and nothing else does.

With `--json` the same run is one JSON document. A recorded one is in [`examples/typescript.json`](examples/typescript.json).

Results are cached per commit, so a repeat run makes no calls for commits already judged. A first run costs one Jev call per commit that needs judging; commits code can settle on its own (docs-only, lockfiles, merges, release snapshots) cost nothing.

`extract` and `doctor` run with the network switched off by the operating system. That uses macOS's built-in sandbox; on Linux, add `--allow-unsandboxed` to run them with the in-process guard alone.

With `--json`, stdout is exactly one JSON document: `{"ok":true,"command":...,"data":...}` on success and `{"ok":false,"error":{"code","message"}}` on failure. A run where any commit could not be judged fails with code `incomplete`; rerun it, since judged commits are cached. Exit codes are 0 ok, 1 error, 2 usage, 3 denied. `--model <id>` or `DEEDS_MODEL` picks a different model for `--mode full`, and `deeds help --json` lists every command with its usage.

## Privacy

- Only each commit's diff and its list of changed file paths leave your machine, and only to Jev (api.typesafe.ai) on your own key. `--mode full`, if you choose it, sends them to Anthropic or OpenAI instead. No other host is ever called for judgments. The only other network use is cloning a public GitHub repo you name.
- Anything shaped like a secret (API keys, tokens, private keys, passwords in config) is redacted from a diff before it is sent.
- Commit messages are never read.
- Deeds keeps two caches. Public GitHub repos are cloned over HTTPS into `~/.cache/deeds/repos`, and per-commit results are stored in `~/.cache/deeds/classified`.
- There is no telemetry and no account. `deeds doctor` shows how the network restriction is enforced on your machine.

## License

MIT. See [LICENSE](LICENSE).
