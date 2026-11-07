# Contributing to blift

Thanks for helping out. blift is a small internal tool: keep changes focused and light, and read
the product boundaries in [AGENTS.md](AGENTS.md) before proposing a feature. AGENTS.md also
describes the architecture, the steps for changing the API and the Cloudflare limits that server
code must respect; it applies to human contributors as much as to agents.

The working language of the project is **English**: code, comments, docs, commit messages, pull
requests, issues and reviews. The product UI is bilingual (English and Chinese), and so are the
user docs (`README.md` + `README.zh-cn.md`, `cli/README.md` + `cli/README.zh-cn.md`); when you
change one of those docs, change its translation in the same commit.

## Workflow

1. Open an issue first for anything bigger than a small fix, so the approach can be agreed on.
2. Branch from `main` as `<type>/<short-topic>`, using the commit types below:
   `feat/api-keys-inbox`, `fix/inbox-rename`, `docs/english-docs`.
3. Make the change. For API changes, follow "Changing the API" in AGENTS.md (docs/API.md first).
4. Record user-visible changes under `[Unreleased]` in [CHANGELOG.md](CHANGELOG.md).
5. Run `make test` (required for every commit) and `make smoke` when API behaviour changes (needs
   Docker); for UI-only changes run at least `pnpm --filter web build`.
6. Open a pull request against `main` and get CI green.

## Commit messages

Commits follow [Conventional Commits 1.0](https://www.conventionalcommits.org/en/v1.0.0/):

```text
<type>(<scope>): <summary>

<body>

<footer>
```

**Type** (required):

| Type | Use for |
| --- | --- |
| `feat` | a new feature or user-visible capability |
| `fix` | a bug fix |
| `perf` | a performance improvement without behaviour change |
| `refactor` | restructuring code without behaviour change |
| `docs` | documentation only (README, docs/API.md, AGENTS.md, comments) |
| `test` | adding or fixing tests only |
| `build` | the build system, Makefile, Dockerfile, dependencies |
| `ci` | GitHub Actions workflows and other CI configuration |
| `chore` | maintenance that fits nothing above (dependency bumps use `chore(deps)`) |
| `revert` | reverting an earlier commit |
| `release` | the release commit only: `release: vX.Y.Z` (see [RELEASING.md](RELEASING.md)) |

**Scope** (optional): the part of the repository or the feature the change is confined to, such
as `server`, `web`, `cli`, `api`, `gc`, `install.sh`, `deploy`, `brand` or `deps`. Leave it out
when the change spans several parts.

**Summary** (required):

- English, imperative mood: "add API key login", not "added" or "adds".
- Starts with a lowercase letter (identifiers and proper names keep their case), no trailing period.
- At most 72 characters including the type and scope; aim for about 50.
- Says what the change does for the reader of `git log`, not how.

**Body** (optional for small changes, expected otherwise):

- Separated from the summary by a blank line and wrapped at 72 columns.
- Explains what changed and why: the problem, the approach, anything surprising. Mention
  migrations, configuration changes and user-visible behaviour.
- Plain prose or `-` bullet lists.

**Footer** (optional):

- `Closes #123` / `Fixes #123` to close an issue, `Refs #123` to link one.
- Breaking changes (see [RELEASING.md](RELEASING.md) for what counts as breaking) add `!` after the
  type or scope and a `BREAKING CHANGE: <what users must do>` footer.
- Trailers such as `Co-authored-by:` go last.

Keep one logical change per commit, and make sure each commit passes `make test`. Squash "fix
typo" and "address review" commits into the commit they fix before the pull request is merged.

Examples:

```text
feat(cli): add login with API keys

`blift login --api-key` and BLIFT_API_KEY exchange an API key for a CLI
session, so machines can sign in without a browser. install.sh signs in
right after installing when BLIFT_API_KEY is set.

Closes #12
```

```text
fix(server): rename taken inbox uploads instead of failing

An anonymous upload whose name was taken failed with name_taken at
complete. Inbox uploads now get the first free "name (n).ext" instead,
since uploaders cannot see or replace the project's files.
```

```text
feat(cli)!: rename share create --expires to --ttl

BREAKING CHANGE: scripts that call `blift share create --expires` must
use `--ttl` instead.
```

## Pull requests

- **Title**: the same format as a commit summary, e.g. `feat: API key login and project inbox`.
  For a single-commit pull request, use that commit's summary.
- **Description**: fill in the [template](.github/pull_request_template.md):
  - *Summary*: what the change does and why, in a few sentences, with `Closes #n` for the issues
    it fixes.
  - *Changes*: the notable changes, grouped by area (API, server, web, CLI, docs) when that helps.
  - *Testing*: the commands you ran (`make test`, `make smoke`, manual checks) and their results;
    say what you could not test.
  - *Notes*: migrations, breaking changes, configuration changes, follow-ups. Add screenshots for
    UI changes (light and dark mode when colours change).
- Keep pull requests focused: one feature or fix each. Open a draft pull request for work in
  progress.
- Before asking for review, tick the checklist in the template: docs/API.md, CHANGELOG.md, both
  README translations, both i18n files, tests.
- A pull request is merged once CI is green and review comments are resolved. Its commits land on
  `main` as they are, so clean up the history before merging.

## Issues

Use the issue forms ([bug report](.github/ISSUE_TEMPLATE/bug_report.yml),
[feature request](.github/ISSUE_TEMPLATE/feature_request.yml)); a blank issue is fine for
anything else.

- **Title**: a plain sentence that describes the problem or the need, not the solution and without a
  type prefix: "Inbox upload fails for files over 5 GiB", "Allow renaming a share". Labels (`bug`,
  `enhancement`, `documentation`, `question`) classify issues.
- **Bug reports** include the blift version (server: `GET /api/info`; CLI: `blift version`), how
  the server runs (Cloudflare Workers or Docker), the storage provider, the steps to reproduce, the
  expected and the actual result, and logs or error codes. Remove secrets, tokens, API keys and
  presigned URLs from anything you paste.
- **Feature requests** describe the use case first: who needs it, what they do today and why that
  is not good enough, then the proposal and the alternatives considered. Check the product
  boundaries in AGENTS.md: folders, billing, rate limiting and routing file traffic through the
  server are out of scope.
- Search existing issues before opening a new one, and keep one problem per issue.

Do not report security vulnerabilities in a public issue: contact the maintainer,
[@davidliyutong](https://github.com/davidliyutong), privately instead.
