<!--
Title: <type>(<scope>): <summary> — English, imperative, lowercase, no period, ≤ 72 characters.
See CONTRIBUTING.md for the conventions.
-->

## Summary

<!-- What does this change do, and why? Link issues: "Closes #123". -->

## Changes

<!-- The notable changes, grouped by area (API, server, web, CLI, docs) when that helps. -->

-

## Testing

<!-- The commands you ran and their results, manual checks, and anything you could not test. -->

- [ ] `make test`
- [ ] `make smoke` (API behaviour changed)
- [ ] `pnpm --filter web build` / checked in the browser (UI changed)

## Notes

<!-- Migrations, breaking changes, configuration changes, follow-ups. Screenshots for UI changes. -->

## Checklist

- [ ] API changes start in `docs/API.md`; `web/src/api/types.ts` and `cli/internal/api` match it
- [ ] New UI copy and error codes are in both `en` and `zh` (web `src/i18n`, CLI `internal/i18n`)
- [ ] User-visible changes are recorded under `[Unreleased]` in `CHANGELOG.md`
- [ ] `README.md` and `README.zh-cn.md` (and `cli/README*.md`) are updated together if needed
- [ ] Commit messages follow Conventional Commits (CONTRIBUTING.md)
