# Go live

I/O runs on one central server. That process is the only copy of the company, the roster, the clock, the wages and collected book, Square polling, Square webhooks, and the phone endpoints.

Each employee computer opens that server and runs only the strip. The computer remembers one person. The shop PIN is the same rule as on a single machine. Phones call the same server. Two computers and a phone for one person share one clock and one Square timecard.

A shop computer, including one you reach with Tailscale, is only for development. Do not leave it as the server the other computers and phones use.

Do not host this on Vercel. The clock is a long-running Node process, and `DATA_DIR` has to be a real disk.

## What Ezven does

1. Pick a host from the choice below and give it a public name, such as `io.ezdesigns.com`. The name needs an A record to the machine, or the host's own HTTPS name (Fly and Railway give you one).
2. Put the secrets only on that server. Copy `.env.example` to `.env` and do not commit it. Set at least:
   - `DATA_DIR` on a disk that survives a restart
   - `SQUARE_ACCESS_TOKEN` and `SQUARE_LOCATION_ID`
   - `SQUARE_WEBHOOK_SIGNATURE_KEY`
   - `SQUARE_WEBHOOK_NOTIFICATION_URL` = `https://<your-host>/api/square/webhook`
   - `PRESENCE_PUBLIC_URL` = `https://<your-host>`
   - `PRESENCE_DEVICE_HASH_PEPPER` to a long random string
   Leave `VITE_IO_SERVER_URL` unset. The strip is served by this same host, so its API calls stay on that host.
3. Start the process so it comes back after a reboot (`systemd`, Fly, or Railway below). `GET /api/health` returns `{ "ok": true }` when it is up.
4. In Square, point webhooks at `POST /api/square/webhook` for `invoice.published`, `invoice.payment_made`, `labor.timecard.created`, and `labor.timecard.updated`. The token never goes on an employee computer.
5. Open `https://<your-host>` once. Create the company, set the shop PIN, and confirm Square shows the roster. Rates stay in Square. This app does not write wages.
6. Send each employee `https://<your-host>/?join=<company code>`. The company code is the one already on the company. The host in that link is the server. They do not install Node and they do not get a copy of `.env`.
7. On that computer, in Chrome or Edge, use the install icon in the address bar (or the menu item **Install I/O**). It opens a window that is the strip. They pick their own name once. That browser keeps that person. Clock in and clock out still ask for the shop PIN.
8. Phones use `https://<your-host>` in the Shortcuts or MacroDroid note from `docs/presence-phone-automations.md`.

If a browser will not show an install icon, the same link as a bookmark is enough. A separate native app is not required. The install step is the browser's own app window. Building an Electron wrapper, or a tool such as Pake, would only repeat that window.

`IO_CORS_ORIGINS` can stay unset. A browser on another host may call the server, and the shop PIN and the phone token still apply. Set it to a comma-separated list of origins only when you want to refuse other sites.

## Free or paid

**Free, if you can set up a Linux VM once.** Use either of these. Both need a billing account to sign up, and the compute stays inside the always-free allowance.

- Oracle Cloud Always Free: an Ampere A1 instance (or the Always Free AMD micro). Ubuntu. Open ports 80 and 443 in the Oracle security list and on the VM. Regions sometimes have no free capacity; try another region.
- Google Cloud: one `e2-micro` in `us-west1`, `us-central1`, or `us-east1`, with a standard persistent disk (the free tier includes a small disk). Open ports 80 and 443. This is the always-free instance, separate from the trial credit.

On that VM:

```sh
sudo useradd --system --create-home --home-dir /var/lib/io io
sudo mkdir -p /var/lib/io /opt/io
sudo chown io:io /var/lib/io
# Node 22, then clone this repo into /opt/io
cd /opt/io
npm ci
npm run build
sudo cp deploy/io.service /etc/systemd/system/io.service
sudo systemctl daemon-reload
sudo systemctl enable --now io
```

Install Caddy, copy `deploy/Caddyfile`, replace `shop.example.com` with the real name, and reload Caddy. Caddy gets the certificate. The Node process listens on port 5000 and is not exposed directly.

`.env` lives at `/opt/io/.env`. `DATA_DIR=/var/lib/io`.

**About $5 a month, if you would rather not run a VM.** The process must stay running. Do not let the host sleep it.

- Fly.io: install `flyctl`, then `fly apps create`, `fly volumes create io_data --size 1 --region dfw`, and `fly secrets set` for each `.env` value (`DATA_DIR` is already `/data` in `fly.toml`). Put the app name in `fly.toml` and run `fly deploy`. `fly.toml` keeps one machine on and mounts the volume at `/data`.
- Railway: connect the repo. It reads `railway.toml` and builds the `Dockerfile`. In the service settings, add a volume mounted at `/data` and set `DATA_DIR=/data` plus the other secrets. Turn off app sleeping.

Use the free VM when the bill should be $0 and a one-time Linux setup is fine. Use Fly or Railway when signup capacity, patches, or Caddy are the part you do not want to own. Fly is the paid path already described in `fly.toml`.

## Development only

On your own computer:

```sh
npm install
cp .env.example .env
npm run dev
```

That serves the strip and the API together on port 5000. Point phones and other employee computers at it only while you are sitting there testing. When you are done, they go back to the central host.

`npm test` and `npm run check` should pass before you deploy.
