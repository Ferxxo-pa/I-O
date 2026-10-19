# Updates

The shop computer updates itself. Each strip is a page served by that computer, installed as a PWA, so it picks up the new files and the What's new notice when the box restarts. Phone Shortcuts and MacroDroid only post events. They do not contain clock rules, so a phone does not need an update.

## Channel

`UPDATE_CHANNEL=stable` installs the newest GitHub release that is not a draft and not a prerelease. `beta` also accepts prereleases. Drafts are ignored.

Set `UPDATE_REPO` if the GitHub repo is not `Ferxxo-pa/I-O`. Or set `UPDATE_MANIFEST_URL` to JSON:

```json
{
  "version": "0.2.0",
  "asset": "https://example.invalid/io-0.2.0.tar.gz",
  "sha256": "64 hex characters",
  "signature": "base64 ed25519 signature of the checksum line",
  "notes": "What changed"
}
```

The asset name is `io-<version>.tar.gz`. A GitHub release also carries `SHA256SUMS` and, when you sign it, `SHA256SUMS.sig`.

## Check, backup, swap, roll back

`UPDATE_ENABLED=1` turns the check on. Dev and tests leave it unset.

The check downloads the archive, then:

- If `UPDATE_TRUST_PUBKEY` is set (a PEM Ed25519 public key), the signature over the checksum text is required.
- If that key is unset, the sha256 checksum is enough.
- A bad checksum or a bad signature does not replace `dist`.
- The data directory is copied first. When `BACKUP_ENCRYPTION_KEY` and `BACKUP_DIR` are set, that copy is the encrypted backup. Otherwise the files are copied to `data.pre-update` and `.env` is left out.
- `dist` moves to `dist.previous`, the archive is extracted, and `update-pending.json` is written.
- systemd restarts I/O. `scripts/run-with-env.mjs` starts the new build and asks `GET /api/health?probe=1` for about 25 seconds. A healthy answer deletes the pending file. A failed answer restores `dist.previous` and starts that build once.

The probe tries `127.0.0.1`, then `HOST`, then `LAN_BASE_URL`. Set `LAN_BASE_URL` to an address this computer can open.

## Overnight

`UPDATE_AT=02:15`, `UPDATE_TZ=America/Chicago`, and `UPDATE_WINDOW_MIN=90` allow the swap only in that local window. Outside it, the check exits without changing files. `UPDATE_APPLY=now` swaps on the next check.

`deploy/io-update.timer` runs the check hourly. The process also schedules the same script when `UPDATE_ENABLED=1`. The script no-ops outside the window.

`deploy/io.service` starts through `scripts/run-with-env.mjs` so the health check can roll back. `ReadWritePaths` includes `/opt/io` so that restore can replace `dist`.

## Release workflow

`.github/workflows/release.yml` runs on `workflow_dispatch`. The `build` job always installs, typechecks, tests, builds, packs `dist`, writes `SHA256SUMS`, and uploads the artifact. It does not publish.

The `publish` job runs only when the `publish` input is true. It uses the GitHub environment named `release`. Add required reviewers on that environment so the job waits for approval. The job still creates a **draft** release. The updater ignores drafts. Publishing the draft in GitHub is the last approval, and that click is Ezven's.

Do not put `UPDATE_TRUST_PUBKEY`'s private key in the repo. Sign `SHA256SUMS` on a machine you trust and attach `SHA256SUMS.sig` before you publish the draft.
