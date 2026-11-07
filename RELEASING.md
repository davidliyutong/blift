# Releasing

Versions follow [semantic versioning](https://semver.org/). The tag is the source of truth for
the CLI (`-X main.version` from `git describe`); the server reports `server/src/version.ts`, and
the release workflow refuses a tag that does not match it.

1. Start from a clean `main` with green CI. Locally: `make test` and `make smoke`.
2. Set the version in `server/src/version.ts` (and the `version` fields of the `package.json`
   files, which are not published but should not drift).
3. In `CHANGELOG.md`, rename `[Unreleased]` to `[X.Y.Z] - YYYY-MM-DD`, start a new empty
   `[Unreleased]` section and update the compare links at the bottom. Commit as `release: vX.Y.Z`.
4. Tag and push: `git tag -a vX.Y.Z -m vX.Y.Z && git push origin main vX.Y.Z`.
5. The `release` workflow ([.github/workflows/release.yml](.github/workflows/release.yml)):
   - checks the tag against `server/src/version.ts` and `CHANGELOG.md`, runs `make test`;
   - builds the CLI for linux/darwin × amd64/arm64 (`make cli-dist`), each archive with the
     binary, `LICENSE` and `README.md`;
   - builds and pushes the Docker image `ghcr.io/davidliyutong/blift` for linux/amd64 and
     linux/arm64, tagged `X.Y.Z`, `X.Y` and `latest`;
   - writes `SHA256SUMS`, attests build provenance for the archives and the image (public
     repository only) and creates the GitHub release with the changelog section as notes.

   Nothing is published unless every job succeeds.
6. Check the release: `sha256sum -c SHA256SUMS`, `blift version`, and
   `docker run --rm -p 8080:8080 ghcr.io/davidliyutong/blift:X.Y.Z` serving `/api/health`.

Changes that require users to act (configuration renamed, data moved without migration, API
changes that break older CLIs) are breaking. Database migrations are append-only, so upgrading
never needs a manual step.
