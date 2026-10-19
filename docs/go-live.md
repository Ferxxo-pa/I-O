# Go live

One spare computer is the I/O server. It can sit at the shop or at home, as long as it stays on. That process is the only copy of the company, the roster, the clock, the wages and collected book, Square polling, Square webhooks, and the phone endpoints.

Employee computers do not run the server. Each one opens the spare computer's public HTTPS address and runs only the strip. The browser remembers one person. The shop PIN is unchanged. Phones call that same address. Two computers and a phone for one person share one clock and one Square timecard.

Do not open a port on the router. Cloudflare Tunnel or Tailscale Funnel makes the HTTPS address. Do not host this on Vercel. The clock is a long-running Node process, and `DATA_DIR` has to be a real disk.

`npm run dev` on a computer you are working at is only for trying a change. Point phones and the other computers at the spare machine's public URL when you are done.

## What Ezven does

1. Pick the spare computer. Plug it into power. Put a UPS on it if you have one, so a short outage does not cut the disk while it is writing. A power cut mid-write is the failure a UPS is for. The nightly backup is the recovery when that still happens.
2. Turn sleep off, and turn automatic OS updates on. Commands are below.
3. Install Node 22. Clone this repo, for example to `/opt/io` (Mac or Linux) or `C:\io` (Windows).

   ```sh
   cd /opt/io
   npm ci
   npm run build
   cp .env.example .env
   ```

   Edit `.env` and do not commit it. Set:

   - `HOST=127.0.0.1` so the shop Wi-Fi cannot reach the process, only the tunnel on this machine can
   - `DATA_DIR` to a folder on this computer's disk (`/var/lib/io` or `C:\io-data`)
   - `BACKUP_DIR` to a different disk or a USB drive that stays plugged in
   - `BACKUP_CLOUD_DIR` only if you also want a copy in a private synced folder
   - `SQUARE_ACCESS_TOKEN` and `SQUARE_LOCATION_ID` (the token stays in this file)
   - `SQUARE_WEBHOOK_SIGNATURE_KEY`
   - `PRESENCE_DEVICE_HASH_PEPPER` to a long random string
   - Leave `VITE_IO_SERVER_URL` unset

   You will fill `PRESENCE_PUBLIC_URL` and `SQUARE_WEBHOOK_NOTIFICATION_URL` in step 5, after the tunnel prints the address.
4. Start I/O on boot, and restart it if it exits. Use the block for this computer's OS below. `GET http://127.0.0.1:5000/api/health?probe=1` returns `{ "ok": true }` when the process is up.
5. Give it a stable HTTPS name with one of these. Both are free. Neither needs an open router port.

   **Tailscale Funnel**, if you do not have a domain. Install Tailscale, sign in, and in the Tailscale admin turn on HTTPS certificates and Funnel. Then, on the spare computer:

   ```sh
   tailscale funnel --bg 5000
   tailscale funnel status
   ```

   The status line is the URL, like `https://shop.your-tailnet.ts.net`. Enable the Tailscale service so it starts on boot, then run the funnel command once. On Linux, keep the funnel across reboots with:

   ```sh
   sudo cp deploy/io-funnel.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now io-funnel
   ```

   **Cloudflare Tunnel**, if you already have a domain. Install `cloudflared`, then:

   ```sh
   cloudflared tunnel login
   cloudflared tunnel create io
   cloudflared tunnel route dns io io.yourdomain.com
   ```

   Copy `deploy/cloudflared/config.yml` to `/etc/cloudflared/config.yml`. Put in the tunnel id and the credentials file that `tunnel create` printed. Set the hostname to `io.yourdomain.com`. Then:

   ```sh
   sudo cloudflared service install
   sudo systemctl enable --now cloudflared
   ```

   On Windows, `cloudflared service install` registers the service. On Mac, `brew services start cloudflared` after the config is in place.

   Set both of these in `.env` to that exact origin, with `https://` and no path:

   - `PRESENCE_PUBLIC_URL`
   - `SQUARE_WEBHOOK_NOTIFICATION_URL` = that origin plus `/api/square/webhook`

   Restart I/O so it reads the file.
6. In Square, send webhooks to `POST https://<that-host>/api/square/webhook` for `invoice.published`, `invoice.payment_made`, `labor.timecard.created`, and `labor.timecard.updated`.
7. Open `https://<that-host>` once. Create the company, set the shop PIN, and confirm the roster comes from Square. This app does not write wages.
8. Run the backup once, by hand, and check **+ → Ready**. Backup should show an age, not "No backup yet". Public URL should show the hostname.

   ```sh
   node scripts/backup-data.mjs
   ```

   Then schedule it nightly. The script copies every file in `DATA_DIR` (including `io-state.json`, `presence-punches.jsonl`, and `presence-phone.jsonl`) into `BACKUP_DIR/io-YYYY-MM-DD`, and into `BACKUP_CLOUD_DIR` when that is set. It keeps 14 days. It writes `DATA_DIR/backup.json` only after the copy works. Ready stays green for 36 hours (`BACKUP_MAX_AGE_MS`).
9. Send each employee `https://<that-host>/?join=<company code>`. They do not install Node and they do not get `.env`. In Chrome or Edge, install I/O from the address bar. The window is the strip. They pick their own name once. Clock in still asks for the shop PIN. If the browser will not install, the same link as a bookmark is enough. A native app is not required.
10. Phones use that same `https://` origin. The Shortcuts and MacroDroid note is in `docs/presence-phone-automations.md`.

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

`deploy/io.service` listens on `127.0.0.1` and restarts after a crash. The timer runs the backup at 02:15 and, if the computer was off then, runs it on the next boot.

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

`KeepAlive` starts it at login and starts it again if it exits. The backup plist runs at 02:15. The Mac user has to be logged in, so turn on automatic login for that user, or the process will not start until someone logs in.

### Windows

No extra installer is required. Task Scheduler runs the restart loop and the nightly copy. From an Administrator prompt, with the repo in `C:\io`:

```bat
schtasks /Create /TN "I/O" /SC ONSTART /RL HIGHEST /TR "C:\io\deploy\windows\start-io.cmd"
schtasks /Create /TN "I/O backup" /SC DAILY /ST 02:15 /RL HIGHEST /TR "C:\io\deploy\windows\backup-io.cmd"
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
```

Leave Windows Update set to automatic. The start script runs `scripts\run-with-env.mjs`, which reads `.env`, binds `127.0.0.1`, and starts again 3 seconds after an exit.

If you would rather have a Windows service, install [nssm](https://nssm.cc/) and point it at `node.exe` with arguments `C:\io\scripts\run-with-env.mjs`, AppDirectory `C:\io`, and exit action Restart. pm2 (`pm2 start scripts/run-with-env.mjs --name io` then `pm2 save` and `pm2 startup`) is the other service option. The Task Scheduler commands above are the one that does not add a tool.

## Restore

1. Stop I/O (`sudo systemctl stop io`, or unload the Mac plist, or end the Windows task).
2. Pick a day folder, `io-YYYY-MM-DD`, from the USB drive or the cloud folder.
3. Copy those files over `DATA_DIR`, replacing `io-state.json` and the punch logs. Leave the spare computer's `.env` where it is. The backup does not contain `.env`.
4. Start I/O again.
5. Open the public URL. The company, the open shifts, and the punch log should be that day's copy. Clock anyone out who was left in by the outage, then let Ready go green after the next backup.

## When the power or the internet drops

The strip keeps the last state it loaded. A refresh that cannot reach the server does not clear those numbers.

Phones retry, inside a limit. The server accepts a phone `ts` up to 10 minutes old (`PRESENCE_PHONE_MAX_AGE_MS`). The MacroDroid loop in the phone doc sends that same `ts` a few times, 20 seconds apart. Shortcuts has no queue: if the request fails, the next Arrive or Wi-Fi trigger sends a new one, and it counts only when that time is still inside 10 minutes. Older than that, the server ignores it.

After that window, the person taps the strip once the server is back. That tap is the normal clock-in. If they already clocked in on Square, the tap joins that timecard instead of opening a second one.

An open shift is saved in `DATA_DIR`. When the spare computer boots, the shift is still open and the hours it was off are counted, because the clock continues from the saved hour. A phone day that was still open at 7:00 PM Chicago closes at 7:00 PM once the process is running again. A manual tap does not. After an outage, clock out anyone who was not working.

While the process is off, Square timecards that were already open stay open in Square. This server cannot close them until it is back.

## Hardening

- No inbound ports. Do not forward 5000, 80, or 443 on the router. `HOST=127.0.0.1`.
- The public address is HTTPS only. Ready rejects an `http://` `PRESENCE_PUBLIC_URL`.
- Phone clock-in is the bearer token on `POST /api/presence/phone`. A token is one person, stored only as a hash.
- The shop PIN gates clock in, clock out, and settings. The owner key gates company changes and phone enrollment.
- Phone and signal routes are rate limited.
- `.env` is not committed. The Square token is only in that file, on this computer.
- The nightly copy is a second disk, and optionally a private folder. It is not a public link.

Open **+ → Ready** after setup. Backup shows the age. Public URL shows the hostname when `https://<host>/api/health?probe=1` answers. The other rows are the Square token, a signed webhook, the PIN, pay rates, rent, and each person having clocked in once.

## Other hosts

Use the spare computer unless it cannot stay on. Then:

| | Spare computer + Tunnel or Funnel | Oracle or Google always-free VM | Railway or Fly |
| --- | --- | --- | --- |
| Cost | $0. Funnel needs no domain. A Cloudflare tunnel uses a domain you already have. | $0 compute inside the always-free allowance. A billing account is required to sign up. | About $5 a month for a machine that stays on, plus a small disk. |
| Safety | No open router ports. The disk is in your shop. You patch the OS and keep the UPS. | The provider's network. You still patch the VM. Ports 80 and 443 are open for Caddy. | The host runs the process. Secrets are in their dashboard. The volume is their disk. |
| Effort | One sitting: Node, boot script, tunnel, backup disk. | Create a VM, open 80 and 443, install Node, systemd, and Caddy. Free capacity is sometimes unavailable; try another region. | Connect the repo, set secrets, add a volume at `/data`. |
| Power or internet at the shop | Server stops. Strips show the last state. Phones retry for about 10 minutes, then someone taps the strip when it is back. Open shifts keep the missed time unless you clock them out. | Shop power does not stop the server. Shop internet still blocks the strips and the phones the same way. People already clocked in keep accruing on the server. | Same as the VM. |

Oracle Cloud Always Free: an Ampere A1 instance, or the Always Free AMD micro, Ubuntu. Google Cloud: one `e2-micro` in `us-west1`, `us-central1`, or `us-east1`. On that VM, `deploy/io.service`, `deploy/io-backup.timer`, and `deploy/Caddyfile` are the same files. Replace the name in the Caddyfile. The tunnel is optional there because Caddy has a public address; still do not put the Square token anywhere but `.env`.

Fly: `fly volumes create io_data --size 1 --region dfw`, `fly secrets set` for each `.env` value, `DATA_DIR=/data` is already in `fly.toml`, then `fly deploy`. `auto_stop_machines` is off so the clock keeps running. Railway: `railway.toml` builds the Dockerfile. Add a volume at `/data`, set `DATA_DIR=/data`, and turn sleep off.

`npm test` and `npm run check` should pass before you leave the spare computer running.
