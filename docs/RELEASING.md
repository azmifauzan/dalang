# Release Dalang

Dalang's public package is `dalang-cli`; the executable is `dalang`. The other workspace packages remain private. Each release is published to the npm registry and to a GitHub release with the npm-installable tarball and `SHA256SUMS`. The examples below use `<version>`, such as `0.8.0`.

## Prepare the version

Update the root `package.json`, all five `packages/*/package.json` versions, and `DALANG_VERSION` in `packages/shared/src/schemas.ts` together. Add the dated changelog entry and update the install, update, platform, and troubleshooting guides. Keep earlier release notes as historical records.

## Validate and package

Use the pnpm version pinned in `package.json`:

```bash
npm install -g pnpm@10.34.9
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm test
node -e "require('node:fs').mkdirSync('.dalang-local/releases', { recursive: true })"
npm pack ./packages/cli --pack-destination .dalang-local/releases
```

Build all packages before packing. The CLI build bundles the terminal room and private workspace packages, then copies the web distribution. Inspect the tarball contents and install it with npm into a separate test directory. Check `dalang --version` and `dalang doctor`. Run `dalang` in a PTY to check the terminal room and `dalang web --no-open` to check the browser UI and `/api/health`. Use an isolated `DALANG_HOME` for these checks. Browser tests need the built UI and an installed browser. Windows tests run serially. Report platform-only skips with the platform verification results.

Run Linux regression checks for shared changes. macOS sandbox profile tests check generated policy and detection; native macOS execution must be reported separately when Apple hardware is available. Live provider tests consume model quota and should use isolated repositories.

Generate the release checksum in PowerShell:

```powershell
$releasePackage = '.dalang-local/releases/dalang-cli-<version>.tgz'
$releaseHash = (Get-FileHash -LiteralPath $releasePackage -Algorithm SHA256).Hash.ToLowerInvariant()
$releaseChecksum = "$releaseHash  dalang-cli-<version>.tgz" + [char]10
Set-Content -LiteralPath .dalang-local/releases/SHA256SUMS -Value $releaseChecksum -Encoding ascii -NoNewline
```

On Linux, run `sha256sum dalang-cli-<version>.tgz > SHA256SUMS` from the artifact directory. On macOS, use `shasum -a 256 dalang-cli-<version>.tgz > SHA256SUMS`.

## Commit, tag, and publish

Commit the reviewed source and documentation, then create an annotated version tag on that exact commit. Push the commit and tag before publishing the release:

```bash
git tag -a v<version> -m "Dalang v<version>: <release title>"
git push origin main
git push origin v<version>
```

Publish the tested tarball to the npm registry with an account that owns `dalang-cli`:

```bash
npm publish .dalang-local/releases/dalang-cli-<version>.tgz
npm view dalang-cli dist-tags
```

Once npm shows `latest` at the new version, create the GitHub release for the existing tag. Upload the same `dalang-cli-<version>.tgz` and `SHA256SUMS` and mark it as the latest stable release. The notes cover the changes, tests, platform limits, and how to install. Use `npm install -g dalang-cli@latest`, followed by `dalang doctor`. Start the terminal team room with `dalang` or the browser workspace with `dalang web`.

Verify that the published tag resolves to the committed SHA. Download both assets and verify the tarball against `SHA256SUMS`. Check the npm version and tarball integrity against the artifact you published.
