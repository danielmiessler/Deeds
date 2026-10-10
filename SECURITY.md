# Security policy

## Reporting a vulnerability

Please do not report security problems in public issues, pull requests or discussions.

Report them privately through GitHub: open the repository's **Security** tab and choose
**Report a vulnerability** (GitHub private vulnerability reporting). The report stays visible only to
the maintainers until a fix and an advisory are published.

Please include:

- the affected version (`deeds version`) or commit,
- the command you ran and the platform (macOS, Linux),
- steps to reproduce, and what an attacker controls in them,
- the impact you observed.

## What counts as a security issue here

Deeds reads repositories that other people wrote, and it holds the user's own API keys. Treat these as
security issues:

- code execution, file writes or network access triggered by the content of an analyzed repository
  (commits, file paths, author names, `.mailmap`, repository files);
- secrets from an analyzed diff leaving the machine unredacted, or anything leaving for a host outside
  the vendor allowlist;
- leaks of `TYPESAFE_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` or the user's config;
- ways around the offline guarantee of `deeds extract` and `deeds doctor`;
- terminal or HTML output that an analyzed repository can use to inject content.

Wrong deed counts, crashes on malformed input with no security impact, and performance problems are
ordinary bugs: open a normal issue for those.

## Supported versions

Only the latest release receives security fixes.
