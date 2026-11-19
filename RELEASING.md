# Releasing Perihelion

This is the repeatable process for cutting a tagged release. The short summary
is in [CONTRIBUTING.md](./CONTRIBUTING.md#release-process); this file covers the
mechanics and what is still manual.

Every package currently moves together at `0.1.0` (see the CHANGELOG preamble).
A release means one version number across the root, `sdk/`, `relayer/`,
`solver/`, `mempool/`, `test/`, and the Soroban settlement contract.

## What the tag automates

`.github/workflows/release.yml` runs when a tag matching `vX.Y.Z` is pushed. It:

1. Fails unless every workspace `package.json` version and a
   `## [X.Y.Z] - YYYY-MM-DD` section in `CHANGELOG.md` match the tag.
2. Runs `npm ci` and `make build-ts`.
3. Packs `@perihelion/sdk`, `relayer`, `solver` and `mempool` into `.tgz`
   tarballs and writes `SHA256SUMS`.
4. Creates a GitHub release for the tag with those files attached and generated
   notes.

## What is still manual

- **Contract artefacts.** The workflow does not build or attach the Soroban
  `.wasm` or the EVM bytecode. Attach them by hand once the contracts build
  cleanly, and record their SHA-256 hashes in the release notes, so auditors can
  match a deployed bytecode to a tagged release. Build commands are in
  [docs/deployment.md](./docs/deployment.md) and the `build-soroban` target in
  the Makefile. Do not claim a contract artefact in a release until it has been
  built from the tagged commit.
- **npm publication.** `@perihelion/sdk` is published by a maintainer after the
  GitHub release is verified, using a token held by the maintainer:

  ```sh
  npm publish --workspace=sdk --access public --provenance
  ```

  Publish only the tarball whose hash appears in `SHA256SUMS`.

## Steps

1. **Prepare the release PR.**
   - Rename `## [Unreleased]` in `CHANGELOG.md` to `## [X.Y.Z] - YYYY-MM-DD` and
     add a fresh empty `## [Unreleased]` above it.
   - Set every workspace version to `X.Y.Z`:

     ```sh
     npm version X.Y.Z --workspaces --include-workspace-root --no-git-tag-version
     npm install --package-lock-only
     ```

   - Make sure `main` is green in CI, including the contract workflows.
   - Merge the PR.
2. **Tag the merge commit** with a signed tag and push it:

   ```sh
   git switch main && git pull
   git tag -s vX.Y.Z -m "Perihelion vX.Y.Z"
   git push origin vX.Y.Z
   ```

3. **Watch the Release workflow.** If the version or changelog check fails, the
   tag points at the wrong commit. Delete the tag locally and remotely, fix the
   PR, and tag again. Do not move a tag that has already produced a release.
4. **Verify the release.** Download the tarballs and check them:

   ```sh
   sha256sum -c SHA256SUMS
   ```

5. **Attach contract artefacts and record hashes** (see above), then publish
   `@perihelion/sdk` to npm if this release includes an SDK change.

## Changelog link

`CHANGELOG.md` links `[0.1.0]` to the commits page for `main`, because no tag
existed when the link was written. Once `v0.1.0` is tagged, change that link to
`https://github.com/Perihelion-Protocol/Perihelion/releases/tag/v0.1.0`, so that
it resolves to the release the notes describe.

## Tags to date

None. The first tag is cut once the contracts build from `main`.
