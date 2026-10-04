# Deeds

Deeds counts the work in a code repo by what changed in the product, not by how many PRs or commits there were. It reads each commit's diff and reports three separate numbers:

- **caps**: a capability gained or deepened. The product can do something it could not, or does an existing thing more fully.
- **fix**: something moved from broken to sound, security fixes included.
- **tend**: upkeep nobody sees, such as refactors, dependency bumps, performance work and tests.

The same repo and window give the same answer in any language. Refactors, reverts, renames and busywork do not inflate the caps. The three counts are never added into one score. The idea and the argument for it are at [workdeeds.ai](https://workdeeds.ai).

## Install

You need [bun](https://bun.sh) and your own OpenAI API key. An Anthropic key works too, with `--mode full`.

```sh
curl -fsSL https://raw.githubusercontent.com/danielmiessler/deeds/main/install.sh | sh
```

This puts the CLI in `~/.local/share/deeds` and a `deeds` command in `~/.local/bin`. It never uses elevated privileges. The installer downloads one tarball from this repo's latest release, compares its sha256 with the published checksum, and refuses to install if they differ. You can pin the checksum yourself with `DEEDS_SHA256`.

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

The first run installs the CLI's locked dependencies with `bun install --frozen-lockfile`. That is the only download the plugin makes. Later runs start without touching the network. If your API key lives in a file instead of your environment, point `~/.config/deeds/config.json` at it:

```json
{ "keys": { "openai": { "envFile": "~/.secrets/.env", "var": "OPENAI_API_KEY" } } }
```

## Usage

```sh
deeds analyze [path | github.com/owner/repo] [--since 90d] [--until <date>] [--mode fast|full] [--vendor anthropic|openai] [--model <id>] [--json]
deeds extract [path] [--rev <commit>] [--json]
deeds help --json
deeds doctor
deeds version
```

`analyze` takes a local folder or a public GitHub repo and any window: `7d`, `2w`, `6m`, `1y`, `all`, or anything git understands such as `2026-01-01`. It reports totals, a week-by-week trend, a per-author breakdown and the named caps.

There are two modes. `fast`, the default, asks a cheap OpenAI model a short set of typed questions about each commit, so it needs `OPENAI_API_KEY`. `full` has a model read each diff in full and works with either vendor; use it with an Anthropic key.

`extract` and `doctor` run with the network switched off by the operating system. That uses macOS's built-in sandbox; on Linux, add `--allow-unsandboxed` to run them with the in-process guard alone.

```sh
export OPENAI_API_KEY=...
deeds analyze . --since 30d
deeds analyze github.com/owner/repo --since all
ANTHROPIC_API_KEY=... deeds analyze . --mode full --vendor anthropic
```

Results are cached per commit, so repeating a run makes no model calls for commits already judged. A first run on a large window takes one model call per commit, so start with `--since 30d` on a big repo.

With `--json`, stdout is exactly one JSON document: `{"ok":true,"command":...,"data":...}` on success and `{"ok":false,"error":{"code","message"}}` on failure. A run where any commit could not be judged fails with code `incomplete`; rerun it, since judged commits are cached. Exit codes are 0 ok, 1 error, 2 usage, 3 denied. `--model <id>` or `DEEDS_MODEL` picks a different model. `deeds help --json` lists every command with its usage.

## Privacy

- Only each commit's diff and its list of changed file paths leave your machine, and only to Anthropic or OpenAI, using your own key. Model calls go to no other host; the only other network use is cloning a public GitHub repo you name.
- Strings shaped like secrets are redacted from a diff before it is sent.
- Commit messages are never read.
- Deeds keeps two caches. Public GitHub repos are cloned over HTTPS into `~/.cache/deeds/repos`, and per-commit results are stored in `~/.cache/deeds/classified`.
- There is no telemetry and no account. `deeds doctor` shows how the network restriction is enforced on your machine.

## License

MIT. See [LICENSE](LICENSE).
