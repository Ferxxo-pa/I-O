# Updates

The shop computer updates itself. Each strip is a page served by that computer, installed as a PWA, so it picks up the new files and the What's new notice when the box restarts. Phone Shortcuts and MacroDroid only post events. They do not contain clock rules, so a phone does not need an update.

Updates stay off until `UPDATE_ENABLED=1`. A fresh shop leaves that line unset.

## Turn updates on

On the shop computer, edit `.env` and set:

```text
UPDATE_ENABLED=1
UPDATE_CHANNEL=stable
UPDATE_AT=02:15
UPDATE_TZ=America/Chicago
UPDATE_WINDOW_MIN=90
UPDATE_TRUST_PUBKEY=C:\io\update-public.pem
```

`UPDATE_TRUST_PUBKEY` is the public key only. It can be a path to a PEM file, or one line with `\n` between the PEM lines. The private key does not go in `.env`. If you write the private key on the shop computer only long enough to upload it to GitHub, delete that file after the secret is saved.

`stable` installs the newest GitHub release that is not a draft and not a prerelease. `beta` also accepts prereleases. Drafts are ignored.

Restart I/O after saving `.env`. On Windows, close the extra `scripts\start-shop.cmd` window if the startup task is already running, so only one copy is up. The setup prompt in [CODEX_SETUP.md](../CODEX_SETUP.md) offers this choice and leaves it off until you say yes.

Nothing installs until a release is actually published. A draft does not count. The computer also has to be on around 2:15 AM Chicago time. `deploy\windows\install-boot.cmd` is what keeps it running and awake while it is plugged in.

Set `UPDATE_REPO` if the GitHub repo is not `Ferxxo-pa/I-O`. Or set `UPDATE_MANIFEST_URL` to JSON:

```json
{
  "version": "0.2.1",
  "asset": "https://example.invalid/io-0.2.1.tar.gz",
  "sha256": "64 hex characters",
  "signature": "base64 ed25519 signature of the checksum line",
  "notes": "What changed"
}
```

The asset name is `io-<version>.tar.gz`. A GitHub release also carries `SHA256SUMS` and `SHA256SUMS.sig`.

## Check, backup, swap, roll back

`UPDATE_ENABLED=1` turns the check on. Dev and tests leave it unset.

The check downloads the archive, then:

- If `UPDATE_TRUST_PUBKEY` is set, the signature over the checksum text is required. A release without `SHA256SUMS.sig` is refused.
- If that key is unset, the sha256 checksum is enough. Set the key before you rely on updates.
- A bad checksum or a bad signature does not replace `dist`.
- The data directory is copied first. When `BACKUP_ENCRYPTION_KEY` and `BACKUP_DIR` are set, that copy is the encrypted backup. Otherwise the files are copied to `data.pre-update` and `.env` is left out.
- `dist` moves to `dist.previous`, the archive is extracted, and `update-pending.json` is written.
- The running app restarts. On Linux, `systemctl restart io`. On Windows, the updater stops the shop `node` process that is running `dist\index.js`. `deploy\windows\start-io.cmd` starts it again a few seconds later. `scripts\run-with-env.mjs` asks `GET /api/health?probe=1` for about 25 seconds. A healthy answer deletes the pending file. A failed answer restores `dist.previous` and starts that build once.

The archive includes `dist/version.json`. The updater reads that as the installed version. `package.json` stays on the shop disk and is not inside the archive, so a finished update does not install itself again the same night.

The probe tries `127.0.0.1`, then `HOST`, then `LAN_BASE_URL`. Set `LAN_BASE_URL` to an address this computer can open.

## Overnight

`UPDATE_AT=02:15`, `UPDATE_TZ=America/Chicago`, and `UPDATE_WINDOW_MIN=90` allow the swap only in that local window. Outside it, the check exits without changing files. `UPDATE_APPLY=now` swaps on the next check.

While I/O is running with `UPDATE_ENABLED=1`, it checks about 15 seconds after start and then on each clock hour. The script no-ops outside the window. `deploy/io-update.timer` is the same hourly check on Linux, including when you want the timer even if you are not relying on the process.

`deploy/io.service` starts through `scripts/run-with-env.mjs` so the health check can roll back. `ReadWritePaths` includes `/opt/io` so that restore can replace `dist`.

## Publish an update from main

Merging to `main` does not publish an update. You run the Release workflow when you want one. It builds, checksums, and signs. It can open a draft release. You publish that draft yourself when the shop should install it. Do not publish a release just to try the button.

One-time, on a computer you trust:

1. Create an Ed25519 key pair. This writes two files and does not print the private key.

   ```sh
   node -e "const {generateKeyPairSync}=require('node:crypto'); const fs=require('node:fs'); const {publicKey,privateKey}=generateKeyPairSync('ed25519'); fs.writeFileSync('update-private.pem', privateKey.export({type:'pkcs8',format:'pem'}), {mode:0o600}); fs.writeFileSync('update-public.pem', publicKey.export({type:'spki',format:'pem'})); console.log('Wrote update-private.pem and update-public.pem');"
   ```

2. In GitHub, open this repo, then Settings, Environments. Create an environment named `release`. Add a secret named `UPDATE_SIGNING_KEY` whose value is the contents of `update-private.pem`. Optional: require a reviewer on that environment so the publish job waits. Delete `update-private.pem` from the computer after the secret is saved. Do not commit it. Do not paste it into chat.
3. Copy `update-public.pem` to the shop computer and set `UPDATE_TRUST_PUBKEY` to that path. The public file is the one the shop uses to check the signature.

Each release:

1. On `main`, set `package.json` `"version"` to the new number, such as `0.2.1`. Commit that. The workflow refuses to run if the number you type does not match `package.json`.
2. GitHub, Actions, Release, Run workflow. Choose the branch `main`. Channel `stable` (or `beta`). Version `0.2.1`. Leave publish off for a rehearsal. The build job installs, typechecks, tests, builds, writes `dist/version.json`, packs `io-0.2.1.tar.gz`, and writes `SHA256SUMS`. It does not publish.
3. Run it again from `main` with publish on when you want a draft. The publish job signs `SHA256SUMS` with `UPDATE_SIGNING_KEY` and uploads `SHA256SUMS.sig`. The job log prints the public key so you can confirm it matches the shop. The private key is removed from the runner at the end of the step. If the secret is missing, the job stops and no release is created.
4. The release is a draft. The shop updater ignores drafts. Open the draft in GitHub and publish it when you want shops to install it. That click is yours.

`beta` marks the draft as a prerelease. Shops on `stable` ignore prereleases.

The workflow file is `.github/workflows/release.yml`. Pull requests run `.github/workflows/ci.yml`, which tests, builds, and packs a throwaway archive. That pack is not a release.
