# Release Dalang

Dalang's public package is `dalang-cli`; the executable is `dalang`. The other workspace packages remain private. v0.7.3 is distributed through GitHub Releases as an npm-installable tarball and `SHA256SUMS`. The npm registry remains on v0.7.2.

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
$releasePackage = '.dalang-local/releases/dalang-cli-0.7.3.tgz'
$releaseHash = (Get-FileHash -LiteralPath $releasePackage -Algorithm SHA256).Hash.ToLowerInvariant()
$releaseChecksum = "$releaseHash  dalang-cli-0.7.3.tgz" + [char]10
Set-Content -LiteralPath .dalang-local/releases/SHA256SUMS -Value $releaseChecksum -Encoding ascii -NoNewline
```

On Linux, run `sha256sum dalang-cli-0.7.3.tgz > SHA256SUMS` from the artifact directory. On macOS, use `shasum -a 256 dalang-cli-0.7.3.tgz > SHA256SUMS`.

## Commit, tag, and publish

Commit the reviewed source and documentation, then create an annotated version tag on that exact commit. Push the commit and tag before publishing the release. For v0.7.3:

```bash
git tag -a v0.7.3 -m "Dalang v0.7.3: native Windows support"
git push origin main
git push origin v0.7.3
```

Create a GitHub release for the existing tag through the authenticated GitHub CLI or API. Upload `dalang-cli-0.7.3.tgz` and `SHA256SUMS`, then publish it as the latest stable release. The release notes should cover the concrete changes, install command, test results, platform limits, and distribution channel.

Verify the published tag resolves to the committed SHA, both assets can be downloaded, and the downloaded tarball matches `SHA256SUMS`. Use this installation command in the release notes:

```bash
npm install -g https://github.com/azmifauzan/dalang/releases/download/v0.7.3/dalang-cli-0.7.3.tgz
dalang doctor
dalang
```

Creating a GitHub release does not publish to npm. Registry publication is a separate maintainer action; do not describe `npx dalang-cli@latest` as installing v0.7.3 while the registry still serves v0.7.2.
