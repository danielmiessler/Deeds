# Deed canon

Worked examples that pin what each kind of deed means. The classifier reads these as precedent and
judges a commit's diff by the nearest example, so the same change gets the same kind in every run and
every year. A change to this file changes the definition of a deed; treat it as a versioned
decision, never as tuning.

A deed is one unit of work that changed the product. There are three kinds.

- cap: a capability gained or deepened. A user can now do something they could not, or do an existing thing more fully. Its change is new, deepened, regressed or removed. Regressed and removed are negative.
- fix: something that was broken is now sound. Bugs and security holes alike.
- tend: invisible upkeep. The product does what it did before. Refactors, dependencies, performance, tests, docs, tooling.

A commit yields zero or more deeds, judged from its diff alone. A message, a branch name or a PR title is
never evidence. Lines changed never decide a kind.

## Example format

One example per line: `- [kind] what the diff does`, or `- [cap:change] what the diff does` for a cap.
The words after the bracket describe the diff, never a commit message.

## Caps

- [cap:new] Adds a `GET /export.csv` route that returns the user's orders as a CSV download, where no export existed.
- [cap:new] Adds a `deeds init` subcommand to a CLI that had only `run` and `help`.
- [cap:new] Adds a "Share" button and its click handler that creates a public link to a document.
- [cap:new] Adds OAuth login with a new provider alongside the existing password login.
- [cap:new] Adds a new exported function `parseDuration` to a library's public entry point, with behavior the library lacked.
- [cap:deepened] Adds category, price range and in-stock filters to a search route that already returned matches by name.
- [cap:deepened] Adds `--format json` to a CLI command that previously printed only text.
- [cap:deepened] Adds pagination parameters to a list endpoint that previously returned every row at once.
- [cap:deepened] Lets an existing upload form accept PNG and WebP where it accepted only JPEG.
- [cap:deepened] Adds sorting by date and by name to an existing table view that had a fixed order.
- [cap:regressed] Removes the price-range parameter from a search route while the route and its other filters stay.
- [cap:regressed] Changes an export route so it silently drops every row after the first thousand.
- [cap:removed] Deletes the `GET /export.csv` route and its handler with nothing replacing it.
- [cap:removed] Deletes a CLI subcommand and its registration.
- [cap:removed] Drops the "Share" button and its handler from the UI with no other way to share.

## Fixes

- [fix] Rejects file names that escape the upload directory with `../`, closing a path traversal on a download route.
- [fix] Escapes user-supplied text before it is inserted into an HTML page, closing a stored cross-site-scripting hole.
- [fix] Replaces string-built SQL with a parameterized query to stop injection through a search field.
- [fix] Handles an empty array in a total calculation that threw "cannot read properties of undefined" and crashed the page.
- [fix] Corrects an off-by-one in a loop that skipped the last row of every report.
- [fix] Awaits a database write that was fired and forgotten, which lost data when the process exited early.
- [fix] Corrects a time-zone conversion that showed every event an hour early after a daylight-saving change.
- [fix] Stops a retry loop from spinning forever on a permanent error by giving up after a bounded number of attempts.

## Tends

- [tend] Moves rounding logic into a shared helper and rewrites loops as reductions, with identical behavior.
- [tend] Renames a function, a file or a type across the code with no behavior change.
- [tend] Bumps dependency versions in the manifest and lockfile with no source change.
- [tend] Rewrites one query per customer into a single grouped query so the page loads faster, with identical output.
- [tend] Adds a cache in front of a slow lookup that returns the same answers sooner.
- [tend] Adds unit tests for existing behavior, changing no source outside the test files.
- [tend] Updates the README and code comments, changing no source behavior.
- [tend] Edits a CI workflow or build configuration so builds run faster or on a newer runner.
- [tend] Reformats files with the project formatter and sorts imports.
- [tend] Deletes dead code that nothing imports or calls, leaving every route, command and handler as it was.
- [tend] Adds a lint configuration and a pre-commit hook that run checks on future changes.

## Mixed commits

- A commit that adds a `--format json` flag and, in the same diff, patches a null-pointer crash yields two deeds: [cap:deepened] and [fix].
- A commit that adds a new route and bumps a dependency to support it yields [cap:new] and [tend].
- A commit that renames a module and fixes a bug found while moving it yields [tend] and [fix]; the rename adds no cap.

## Judgment lines

- Extending something that already works is [cap:deepened]. Making something that did not exist is [cap:new]. When a route existed and answered, a new parameter on it is deepened.
- A change that makes the same behavior faster or lighter is [tend], however large the speedup. A change that makes impossible work possible is a cap.
- A security patch is [fix], not [tend], even when the diff is small and invisible to users.
- A refactor never adds a cap, however many files it touches.
- Tests, docs and dependency bumps are [tend] unless they come with a source change that does one of the other things.
