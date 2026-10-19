# Go live

One shop computer runs I/O on the shop Wi-Fi. The other computers open that address and show the strip. Phones on Premiere post arrive straight to that computer. Every arrive and every leave also goes to a free Cloudflare mailbox. A leave from cellular still lands, because the phone can reach the mailbox when it cannot reach the shop. The shop computer polls the mailbox outbound, about every 5 seconds. Nothing on the internet calls in.

This mode is `IO_MODE=local-relay`. It is the default. Square stays outbound polling. Webhooks stay off. Do not open a port on the router. Do not turn on Tailscale Funnel or a Cloudflare Tunnel for this path. Do not host this on Vercel. The clock is a long-running Node process, and `DATA_DIR` has to be a real disk.

`npm run dev` on a computer you are working at is only for trying a change. The shop computer is the one that stays on.

## What Ezven creates

You create these once. The repo does not contain them.

1. A free Cloudflare account.
2. A worker named `io-relay`, from `relay/`, with `npx wrangler deploy`.
3. A D1 database named `io-relay` (`npx wrangler d1 create io-relay`). Paste the printed `database_id` into `relay/wrangler.toml`.
4. A long random `RELAY_SHOP_SECRET`. The same value goes on the worker and in the shop `.env`. Phones never see it.
5. A seal keypair from `npm run relay:keys`. The public JWK is the worker secret `RELAY_SEAL_PUBLIC_JWK`. The private JWK is `RELAY_SEAL_PRIVATE_JWK` in the shop `.env` only. The mailbox stores ciphertext. It does not keep names, wages, or Square data.
6. The shop `.env`: `IO_MODE=local-relay`, `HOST=0.0.0.0`, `LAN_BASE_URL`, `RELAY_PUBLIC_URL`, `RELAY_SHOP_SECRET`, `RELAY_SEAL_PRIVATE_JWK`, `DATA_DIR`, `BACKUP_DIR`, `SQUARE_ACCESS_TOKEN`, `SQUARE_LOCATION_ID`, `PRESENCE_DEVICE_HASH_PEPPER`.
7. The shop computer set to start I/O on boot, sleep off.
8. Each phone enrolled from `/join/:code` while that phone is on Premiere.

## Steps

1. Pick the shop computer. Plug it into power. Put a UPS on it if you have one, so a short outage does not cut the disk while it is writing. Turn sleep off, and turn automatic OS updates on. Commands are below.
2. Install Node 22. Clone this repo, for example to `/opt/io` (Mac or Linux) or `C:\io` (Windows).

   ```sh
   cd /opt/io
   npm ci
   npm run build
   cp .env.example .env
   npm run relay:keys
   ```

   `relay:keys` prints two JSON values. Put the public one in Cloudflare in the next step. Put the private one in `.env` as `RELAY_SEAL_PRIVATE_JWK`. Do not commit `.env`. Do not put the private key on Cloudflare.
3. Deploy the mailbox from this repo, on any computer, after `npx wrangler login` with the free Cloudflare account:

   ```sh
   cd relay
   npx wrangler d1 create io-relay
   ```

   Paste the printed database id into `relay/wrangler.toml` where it says `replace-after-wrangler-d1-create`. Then:

   ```sh
   npx wrangler secret put RELAY_SHOP_SECRET
   npx wrangler secret put RELAY_SEAL_PUBLIC_JWK
   npx wrangler d1 execute io-relay --remote --file=schema.sql
   npx wrangler deploy
   ```

   `npm run relay:deploy` from the repo root is the same deploy. Wrangler prints the worker URL, like `https://io-relay.<your-subdomain>.workers.dev`. That is `RELAY_PUBLIC_URL`.
4. Edit the shop `.env`:

   - `IO_MODE=local-relay`
   - `HOST=0.0.0.0`
   - `LAN_BASE_URL=http://io.local:5000` or `http://192.168.x.x:5000` if you reserve a fixed address on the router
   - `RELAY_PUBLIC_URL` the worker origin, no path
   - `RELAY_SHOP_SECRET` the same string you gave the worker
   - `RELAY_SEAL_PRIVATE_JWK` the private JSON from `relay:keys`
   - `DATA_DIR` on this computer's disk (`/var/lib/io` or `C:\io-data`)
   - `BACKUP_DIR` a different disk or a USB drive that stays plugged in
   - `SQUARE_ACCESS_TOKEN` and `SQUARE_LOCATION_ID`
   - `PRESENCE_DEVICE_HASH_PEPPER` a long random string
   - Leave `PUBLIC_BASE_URL`, `SQUARE_WEBHOOK_SIGNATURE_KEY`, and `VITE_IO_SERVER_URL` unset

   Square timecards keep updating because I/O polls Square. You do not add a webhook.
5. Start I/O on boot, and restart it if it exits. Use the block for this computer's OS below. `GET http://127.0.0.1:5000/api/health?probe=1` returns `{ "ok": true }` when the process is up. From another computer on Premiere, open `http://io.local:5000` (or the fixed LAN IP). The strip should load. If `io.local` does not resolve, use the fixed IP in `LAN_BASE_URL` and on the other computers.
6. Do not forward port 5000, 80, or 443. The shop Wi-Fi can reach the computer. The internet cannot.
7. Open the shop computer's address once. Create the company, set the shop PIN, and confirm the roster comes from Square. This app does not write wages.
8. Run the backup once, by hand, and check **+ → Ready**. Backup should show an age. Shop LAN should show `io.local:5000` (or your fixed host). Webhook should say Square is polled and webhooks are off.

   ```sh
   node scripts/backup-data.mjs
   ```

   Then schedule it nightly. The script copies every file in `DATA_DIR` into `BACKUP_DIR/io-YYYY-MM-DD`, and into `BACKUP_CLOUD_DIR` when that is set. It keeps 14 days. Ready stays green for 36 hours (`BACKUP_MAX_AGE_MS`).
9. On each employee computer, open `http://io.local:5000` (or the fixed LAN IP). They do not install Node and they do not get `.env`. In Chrome or Edge, install I/O from the address bar. The window is the strip. They pick their own name once. Clock in still asks for the shop PIN. A bookmark works if the browser will not install. A native app is not required. `VITE_IO_SERVER_URL` is only for a strip built on another host. Leave it unset when the shop computer serves the strip.
10. Enroll each phone while it is joined to Premiere. From the owner key, record consent, then `POST /api/presence/phone/setup`. Send that person the `inviteUrl`. They open it on the phone. The page is three steps. Test it does not clock them in. The copied note posts arrive to the shop and to the mailbox, and posts leave only to the mailbox. Premiere and the shop geofence (403 E Ben White Blvd) are already filled in. The Shortcuts and MacroDroid note is in `docs/presence-phone-automations.md`.

## Start on boot

### Linux

```sh
sudo useradd --system --create-home --home-dir /var/lib/io io
sudo mkdir -p /var/lib/io
sudo chown io:io /var/lib/io
sudo cp deploy/io.service deploy/io-backup.service deploy/io-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now io
sudo systemctl enable --now io-backup.timer
```

`deploy/io.service` reads `HOST` from `.env` and restarts after a crash. local-relay sets `HOST=0.0.0.0`. The timer runs the backup at 02:15 and, if the computer was off then, runs it on the next boot.

Sleep off, security updates on:

```sh
sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target
sudo apt install unattended-upgrades
sudo dpkg-reconfigure -plow unattended-upgrades
```

### Mac

Replace `/usr/bin/node` in both plists with the path from `which node`. Copy the repo to `/opt/io`. Log directory: `mkdir -p ~/Library/Logs`.

```sh
cp deploy/mac/com.ezdesigns.io.plist ~/Library/LaunchAgents/
cp deploy/mac/com.ezdesigns.io.backup.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.ezdesigns.io.plist
launchctl load ~/Library/LaunchAgents/com.ezdesigns.io.backup.plist
sudo pmset -a sleep 0 disksleep 0 displaysleep 10
sudo softwareupdate --schedule on
```

`KeepAlive` starts it at login and starts it again if it exits. The backup plist runs at 02:15. The Mac user has to be logged in, so turn on automatic login for that user, or the process will not start until someone logs in. `scripts/run-with-env.mjs` reads `.env`. With `IO_MODE=local-relay` and no `HOST`, it binds `0.0.0.0`.

### Windows

No extra installer is required. Task Scheduler runs the restart loop and the nightly copy. From an Administrator prompt, with the repo in `C:\io`:

```bat
schtasks /Create /TN "I/O" /SC ONSTART /RL HIGHEST /TR "C:\io\deploy\windows\start-io.cmd"
schtasks /Create /TN "I/O backup" /SC DAILY /ST 02:15 /RL HIGHEST /TR "C:\io\deploy\windows\backup-io.cmd"
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
```

Leave Windows Update set to automatic. The start script runs `scripts\run-with-env.mjs`, which reads `.env` and starts again 3 seconds after an exit.

If you would rather have a Windows service, install [nssm](https://nssm.cc/) and point it at `node.exe` with arguments `C:\io\scripts\run-with-env.mjs`, AppDirectory `C:\io`, and exit action Restart. pm2 (`pm2 start scripts/run-with-env.mjs --name io` then `pm2 save` and `pm2 startup`) is the other service option. The Task Scheduler commands above are the one that does not add a tool.

## Restore

1. Stop I/O (`sudo systemctl stop io`, or unload the Mac plist, or end the Windows task).
2. Pick a day folder, `io-YYYY-MM-DD`, from the USB drive or the cloud folder.
3. Copy those files over `DATA_DIR`, replacing `io-state.json` and the punch logs. Leave the shop computer's `.env` where it is. The backup does not contain `.env`, and it does not contain the seal private key.
4. Start I/O again. It polls the mailbox and applies anything still waiting, using the original phone time.
5. Open the LAN address. The company, the open shifts, and the punch log should be that day's copy.

## When the shop computer, the Wi-Fi, or the mailbox drops

The strip keeps the last state it loaded. A refresh that cannot reach the shop computer does not clear those numbers.

On Premiere, arrive posts to the shop computer and to the mailbox. Leave posts only to the mailbox, so a phone that has already gone to cellular still clocks out. The shop computer dedupes the two copies by `eventId` and `ts`. Capture that id once per firing (the current time in milliseconds) and send the same number on both posts.

The mailbox keeps a message for 72 hours. If the mailbox is down, the phone's direct arrive still hits the shop computer when the phone is on Premiere. If the shop computer is off, messages wait in the mailbox. When it is back, a late leave clocks out at the original `ts`, not at the time the computer woke up.

A direct post to the shop computer, with no mailbox copy, is still only accepted for 10 minutes (`PRESENCE_PHONE_MAX_AGE_MS`). The mailbox path is the one that covers a computer that was off, up to 72 hours. After that, the person taps the strip. That tap is the normal clock-in.

An open shift is saved in `DATA_DIR`. When the shop computer boots, the shift is still open. A phone day that was still open at 7:00 PM Chicago closes at 7:00 PM once the process is running again. A manual tap does not. After an outage, clock out anyone who was not working and whose phone never sent a leave.

While the process is off, Square timecards that were already open stay open in Square. This server cannot close them until it is back. Polling resumes on its own. A webhook is not required.

## Hardening

- No inbound ports. Do not forward 5000, 80, or 443. The bind is `0.0.0.0` so the shop LAN can connect. The router is what keeps the internet out.
- The mailbox is outbound only. The shop computer calls it. It does not call the shop.
- The mailbox stores a hash of the phone token and a sealed payload. The worker seals with the shop public key during the request, then forgets the body. Do not log the worker. The private key stays in `.env` on the shop computer.
- Phone posts use `Authorization: Bearer`. A token is one person, stored only as a hash. The shop secret is a different value and is what `/pull` and `/ack` require.
- With `PUBLIC_BASE_URL` set (public mode only), `GET /api/state`, `GET /api/presence`, the team list, and input posts require the shop PIN or the owner key. Leave `PUBLIC_BASE_URL` unset in local-relay. The shop PIN still gates clock in, clock out, and settings. The owner key gates company changes and phone enrollment.
- Phone and mailbox routes are rate limited. Messages expire after 72 hours.
- `.env` is not committed. The Square token and the seal private key are only in that file, on this computer.
- The nightly copy is a second disk, and optionally a private folder. It is not a public link.

Open **+ → Ready** after setup. Backup shows the age. Shop LAN shows the host when the mailbox secrets are set. The other rows are the Square token, the webhook row (polled, off), the PIN, pay rates, rent, and each person having clocked in once.

## Public mode, later

Set `IO_MODE=public` when the shop computer should be reachable off the LAN. Then `HOST=127.0.0.1`, set `PUBLIC_BASE_URL`, and put a tunnel in front. Phones post only to that public origin. The mailbox is not required.

**Tailscale Funnel**, if you do not have a domain. Install Tailscale, sign in, and in the Tailscale admin turn on HTTPS certificates and Funnel. Then, on the shop computer:

```sh
tailscale funnel --bg 5000
tailscale funnel status
```

The status line is the URL, like `https://shop.your-tailnet.ts.net`. On Linux, keep the funnel across reboots with `deploy/io-funnel.service`.

**Cloudflare Tunnel**, if you already have a domain. Install `cloudflared`, create a tunnel named `io`, route DNS, and use `deploy/cloudflared/config.yml`. That tunnel is not the mailbox worker. Leave it off in local-relay.

Set `PUBLIC_BASE_URL` to that exact origin, with `https://` and no path. Restart I/O. In Square, send webhooks to `POST https://<that-host>/api/square/webhook` for `invoice.published`, `invoice.payment_made`, `labor.timecard.created`, and `labor.timecard.updated`. Ready then checks that a signed webhook has arrived, and that `https://<host>/api/health?probe=1` answers.

Fly or Railway is the paid always-on path, about $5 a month, after the shop computer has run for a week. `fly.toml` and `railway.toml` are in the repo. `DATA_DIR=/data` on a volume. Not Vercel.

| | Shop LAN + mailbox | Spare computer + Tunnel or Funnel | Railway or Fly |
| --- | --- | --- | --- |
| Cost | $0. A free Cloudflare account for the mailbox. | $0. Funnel needs no domain. A tunnel uses a domain you already have. | About $5 a month. |
| Who can connect | Shop Wi-Fi for the strip and for arrive. Cellular for the mailbox. | Anyone with the https address. | Anyone with the https address. |
| Inbound ports | None. | None. The tunnel dials out. | The host's ports. |
| Shop computer off | Mailbox holds events for 72 hours. Late leaves use the original time. | The server is down until that computer is back. | The host keeps running. |

## MVP pilot

Merge the clock work in this order, and do not skip ahead: PR #6 (the geofence clock) first, then this draft. One shop, one process. Do not merge this draft until you mean to.

On the shop computer, `.env` needs the local-relay values in the steps above. Enroll two phones first, not the whole roster. For one week, the manual tap on the strip is the backup: if a phone misses, they tap in. An arrive while they are already in does not open a second timecard. At the end of the week, check Ready and that each person's Square timecard matches the strip.

`npm test` and `npm run check` should pass before you leave the shop computer running.
