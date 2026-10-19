# Security

This is the threat model for the shop computer that runs I/O in `IO_MODE=local-relay`, and the checklist Ezven keeps. The code enforces the rows marked as enforced. The other rows are things only the person with the computer can do.

## What we are protecting

The shop clock, each person's hours, the Square token, the phone tokens, and the seal key. A person on the shop Wi-Fi, a person who finds a phone, and the mailbox operator should not be able to clock someone else, read wages, or read the Square token.

## Threats and what is in place

| Threat | What happens | Mitigation |
| --- | --- | --- |
| Stolen or lost phone | The bearer token on that phone can clock that one person until it is revoked. | The token is stored only as `sha256$`. `POST /api/presence/devices/:id/revoke` with the owner key rejects the bearer and ignores a sealed mailbox message for that token. The phone holds a per-phone seal key, not the shop key, so it cannot open another phone's box. Rotate `RELAY_SEAL_KEY` and re-enroll if you believe the shop key itself leaked. |
| Replayed mailbox message | The same firing is delivered twice, or an old box is sent again with a new timestamp. | The mailbox stores one row per ciphertext (`sha256(token hash + box)`). The shop accepts each `eventId` once for 72 hours. A direct post that is too old does not consume that id, so the mailbox copy can still apply. `ts` has to sit inside the window (10 minutes on the LAN, 72 hours from the mailbox, 15 seconds ahead). |
| Forged mailbox message | Someone edits the box or writes a new one. | Each box is AES-256-GCM and HMAC-SHA256 under a per-phone key derived from `RELAY_SEAL_KEY`. The HMAC covers the token hash and the ciphertext. A flipped byte fails closed, the clock does not move, and the bad row is acked so the queue drains. |
| Person on the shop Wi-Fi | They can open `http://io.local:5000`. | The process binds a private LAN address, not `0.0.0.0` and not a public address. A connection from a public source address is refused. Clock, company, health, presence, and settings require the shop PIN or the owner key. Phone routes require the bearer. `GET /api/health?probe=1` returns only `{ "ok": true }`. Joining with the company code does not include wages. |
| Compromised mailbox | The worker, or whoever runs it, reads what phones upload and what the shop pulls. | The worker secret is only `RELAY_SHOP_SECRET`, used for `/pull` and `/ack`. It does not have `RELAY_SEAL_KEY`. A body that is not `{ "box", "sig" }` is rejected and stored as nothing. Stored rows are the token hash plus `v2` ciphertext. No names, wages, or Square data. |
| Compromised program on the same machine | Another OS user, or an agent, reads the disk. | `.env` and `DATA_DIR` are mode `0600` / `0700`. On Windows, `deploy/windows/lock-secrets.cmd` limits ACLs to the `io` user. systemd runs as `io`, with `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome`, and `PrivateTmp`. Production refuses to start as root. |
| Square token leakage | The token is in a response, a log line, or a backup someone can read. | `SQUARE_ACCESS_TOKEN` stays in `.env`. State, company, and health responses do not include it. Logs strip `Bearer` values and `io_` tokens. Backups do not copy `.env`. |
| Backup theft | Someone takes the USB drive or the cloud folder. | Each file is AES-256-GCM (`IOB1` + iv + tag + ciphertext). `BACKUP_ENCRYPTION_KEY` stays in `.env` on the shop computer. Restore uses that key. |

## What the code does

- **Bind.** `listenHost` uses the LAN address. `0.0.0.0`, an empty `HOST`, and a public address become the first private IPv4 on the machine, or `127.0.0.1` when there is none. Set `HOST` only to a specific private address. In public mode, `0.0.0.0` becomes `127.0.0.1`.
- **Source check.** In local-relay, `req.socket.remoteAddress` must be loopback, RFC1918, IPv6 ULA, or link-local. `X-Forwarded-For` is not consulted.
- **Routes.** With local-relay, or with `PUBLIC_BASE_URL` set, the shop PIN or the owner key is required for `/api/state`, `/api/company`, `/api/company/who`, `/api/presence`, `/api/presence/stream`, `/api/health`, and input posts. Clock in and clock out already require the PIN. Changes require the owner key until a PIN exists, then the PIN. The first `POST /api/company` is the bootstrap, before a PIN exists. Phone ingest uses the bearer.
- **Mailbox.** `relay/src/index.ts` accepts `{ box, sig }` only. The shop opens it with `openRelayBox`.
- **Replay.** `phone:<device>:eid:<eventId>` is remembered for 72 hours after a timestamp is accepted. A stale direct reject does not write that key.
- **Revoke.** `revokedAt` makes `findLiveDevice` and `personForTokenHash` skip the row.
- **Secrets.** Process start chmods `.env` and `DATA_DIR`. Windows uses `deploy/windows/lock-secrets.cmd`. The installer still runs `chown io:io` and `chmod 0600` on `/opt/io/.env`, because the systemd sandbox cannot write `/opt`.
- **Backups.** `scripts/backup-data.mjs` encrypts. `scripts/restore-backup.mjs` decrypts. Neither script copies `.env`.
- **Logs.** Request lines are method, path, and status. `/join/:code` is redacted. The silence line logs the person id.

## Owner checklist

Do these on the shop computer. The app cannot do them for you.

1. **Dedicated machine, or a separate OS user.** Run I/O as `io`, a standard user, not an admin and not root. Do not run an AI agent, a browser profile, or a shared login as that user. An agent that runs as `io` or as root can read `.env`. A different OS user cannot.
2. **Disk encryption.** FileVault, BitLocker, or LUKS on the shop disk. The backup key and the Square token live on that disk. Encryption of the USB does not replace this.
3. **Automatic updates.** Unattended upgrades, `softwareupdate --schedule on`, or Windows Update. Restart when they ask.
4. **A UPS.** A short outage should not cut power while the disk is writing.
5. **No router port forwards.** Do not forward 5000, 80, or 443 to this computer. Do not put it in a DMZ. Binding a LAN address does not stop a forward: the router would still deliver those packets, and the source-address check is what refuses a public source. Leave the forward off anyway.
6. **Shop Wi-Fi.** WPA2 or WPA3. Do not share the Premiere password with people who should not clock in. The LAN is HTTP. Someone who can sniff Premiere can see a PIN or a bearer token on the wire. If that password leaks, change it and revoke the phone tokens.
7. **Lost phone.** Revoke that device the same day. If the setup note might have been copied, re-enroll and, if you are unsure, rotate `RELAY_SEAL_KEY` and enroll again.
8. **Backups.** `BACKUP_ENCRYPTION_KEY` in `.env` only. Confirm Ready shows a backup age. Practice one restore.

## Residual risks

These are real. They are not fixed by another setting in this repo.

- **Shortcuts and MacroDroid cannot seal.** They cannot compute AES-GCM or HMAC over a timestamp that changes every firing. The copied automation posts plain JSON to the shop computer on Premiere. It does not post that JSON to the mailbox. A cellular leave is not captured until someone taps the strip or the 7 PM Chicago auto-close runs. A future client that can seal may use the per-phone key from the one-time note. There is no pretend cipher in the shortcut.
- **The LAN is HTTP.** A passive sniffer on Premiere sees bearer tokens and the shop PIN. Use WPA2 or WPA3, and revoke tokens if the Wi-Fi password leaks. There is no local certificate authority in this setup.
- **The backup key is on the shop computer.** Theft of the USB alone does not decrypt the copy. Theft of the computer, or of a disk image, does, unless the disk itself is encrypted and the machine is off.
- **An agent or a person running as `io` or root** reads every secret. The file modes stop other accounts. They do not stop the service account.
- **The first company create is open** until a PIN exists. Create the company and the PIN before other devices join Premiere. After the PIN is set, that route requires it.
- **The join link is a capability URL.** It shows the person's name before the token is revealed. The token and the per-phone seal key appear only on the one-time open, not in the page HTML. Treat the link like a password and send a new one if it leaks.
- **A router port-forward with a spoofed private source** is not stopped by the bind address. Normal NAT does not spoof that. Leave the forward off.
- **The mailbox operator** can drop or delay messages. They cannot read or forge a sealed box without the phone's key. They can see token hashes and timing.
- **iPhone Shortcuts still cannot import an unsigned automation.** The person pastes the note. That limit is Apple's, and it is unchanged.
