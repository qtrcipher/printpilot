# Releasing PrintPilot

Releases are built and published by `.github/workflows/release.yml`.
electron-builder always runs with `--publish never` — the workflow itself
creates the GitHub Release, so no publish config lives in
`electron-builder.yml`.

## Cutting a release

1. **Bump the version** (does not commit or tag):

   ```sh
   node scripts/bump-version.mjs 0.2.0        # or a prerelease: 0.9.0-beta.1
   ```

   This sets the `package.json` version, moves the CHANGELOG `[Unreleased]`
   content into a new dated section, adds a fresh empty `[Unreleased]`, and
   updates the link footer. Write release notes in `[Unreleased]` as you
   work — whatever is there becomes the release body.

2. **Commit and push** the bump (the script prints the exact git commands).
   Wait for CI on `main` to be green.

3. **Tag** — tags are for releases only (house rule):

   ```sh
   git tag v0.2.0
   git push origin v0.2.0
   ```

4. The tag push triggers the release pipeline:
   - Matrix build on Windows + Linux: `npm ci`, typecheck, unit tests, and
     the full e2e suite (xvfb on Linux). **A failing test blocks the release.**
   - Packages with `electron-builder --publish never` (NSIS + portable on
     Windows, AppImage + deb on Linux).
   - Generates a per-platform `SHA256SUMS-windows.txt` /
     `SHA256SUMS-linux.txt` covering that platform's files.
   - Creates the GitHub Release with the artifacts from both platforms and
     a body extracted from the matching CHANGELOG section. If that section
     is missing, the pipeline fails loudly — the release body is never
     auto-generated.
   - Tags containing a `-` (e.g. `v0.9.0-beta.1`) are marked **prerelease**.

5. **Verify** the published release: download an artifact and check it
   against the platform's `SHA256SUMS-*.txt` (`sha256sum -c` /
   `shasum -a 256 -c`), and give the installer a smoke run.

## Verifying the pipeline without publishing

The workflow has a manual **dry run**: Actions → Release → Run workflow →
leave `dry_run` checked. It runs the exact same build/test/package steps
and uploads the artifacts as workflow artifacts only — no GitHub Release is
created (the release job only ever runs on a `v*` tag push). Use this after
changing the pipeline, before tagging for real.
