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

An excerpt of a real run over the last 30 days of [fabric](https://github.com/danielmiessler/fabric), made on 2026-10-04:

```
$ deeds analyze github.com/danielmiessler/fabric --since 30d

github.com/danielmiessler/fabric
window   2026-09-06 to 2026-10-04   191 commits read (135 from cache)

  51 caps      13 fixes      86 tends

caps
  + Use Apple Foundation Models as an AI provider   e8ad49a Kayvan Sylvan
  ^ override YouTube subtitle language filters with custom yt-dlp arguments   ea5f927 Kayvan Sylvan
  + run workflows from the command line   bc78ac7 Kayvan Sylvan
  ^ configure CORS for REST and Ollama servers   889f473 Kayvan Sylvan
  + Search the web through Serply from the CLI   f3a90d9 Kayvan Sylvan
  ...
```

`+` is a new capability and `^` is a deepened one. The full report also has a week-by-week trend and a breakdown by author, and `--json` gives you all of it as one JSON document.

## Install

You need [bun](https://bun.sh) and your own OpenAI API key. An Anthropic key works too, with `--mode full`.

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

The first run installs the CLI's locked dependencies with `bun install --frozen-lockfile`. That is the only download the plugin makes, and later runs start without touching the network. If your API key lives in a file instead of your environment, point `~/.config/deeds/config.json` at it:

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

`analyze` takes a local folder or a public GitHub repo and any window: `7d`, `2w`, `6m`, `1y`, `all`, or anything git understands, such as `2026-01-01`. It reports the totals, a week-by-week trend, a breakdown by author and the caps by name.

```sh
export OPENAI_API_KEY=...
deeds analyze . --since 30d
deeds analyze github.com/owner/repo --since all
ANTHROPIC_API_KEY=... deeds analyze . --mode full --vendor anthropic
```

There are two modes. `fast`, the default, asks a cheap OpenAI model a short set of typed questions about each commit, so it needs `OPENAI_API_KEY`. `full` has a model read each diff in full and works with either vendor, so use it with an Anthropic key.

Results are cached per commit, so a repeat run makes no model calls for commits already judged. A first run costs one model call per commit, so on a big repo start with `--since 30d` and widen from there.

`extract` and `doctor` run with the network switched off by the operating system. That uses macOS's built-in sandbox; on Linux, add `--allow-unsandboxed` to run them with the in-process guard alone.

With `--json`, stdout is exactly one JSON document: `{"ok":true,"command":...,"data":...}` on success and `{"ok":false,"error":{"code","message"}}` on failure. A run where any commit could not be judged fails with code `incomplete`; rerun it, since judged commits are cached. Exit codes are 0 ok, 1 error, 2 usage, 3 denied. `--model <id>` or `DEEDS_MODEL` picks a different model, and `deeds help --json` lists every command with its usage.

## Privacy

- Only each commit's diff and its list of changed file paths leave your machine, and only to Anthropic or OpenAI, using your own key. Model calls go to no other host. The only other network use is cloning a public GitHub repo you name.
- Anything shaped like a secret (API keys, tokens, private keys, passwords in config) is redacted from a diff before it is sent.
- Commit messages are never read.
- Deeds keeps two caches. Public GitHub repos are cloned over HTTPS into `~/.cache/deeds/repos`, and per-commit results are stored in `~/.cache/deeds/classified`.
- There is no telemetry and no account. `deeds doctor` shows how the network restriction is enforced on your machine.

## License

MIT. See [LICENSE](LICENSE).
