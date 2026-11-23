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

Build all packages before packing: the CLI build bundles the private workspace packages and copies the web distribution. Inspect the tarball contents and install it with npm into a separate test directory. Check `dalang --version`, `doctor`, the UI, and `/api/health` using that installed package. Browser tests need the built UI and an installed browser. Windows tests run serially; platform-only tests may skip when their OS facilities or privileges are unavailable. Report those skips rather than counting them as coverage on another platform.

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

Create a GitHub release for the existing tag through the authenticated GitHub CLI or API. Upload `dalang-cli-<version>.tgz` and `SHA256SUMS`, then publish it as the latest stable release. The release notes should cover the concrete changes, install command, test results, platform limits, and distribution channel.

Verify the published tag resolves to the committed SHA, both assets can be downloaded, and the downloaded tarball matches `SHA256SUMS`. Use this installation command in the release notes:

```bash
npm install -g dalang-cli@latest
dalang doctor
dalang
```

Publish the same tarball to the npm registry with an account that owns `dalang-cli`:

```bash
npm publish .dalang-local/releases/dalang-cli-<version>.tgz
npm view dalang-cli dist-tags
```

Creating a GitHub release does not publish to npm, so run both steps. After publishing, `npm view dalang-cli dist-tags` must show `latest` at the new version before the release notes recommend `npm install -g dalang-cli@latest`.
