# Tester setup

About five minutes for each person, after the owner steps once. The shop computer holds the data. Phones only post arrive, leave, and NFC tap.

## Owner, once

1. Install Node 22 on the shop computer. Copy this repo to `/opt/io`. Run `npm ci` and `npm run build`.
2. Create `/opt/io/.env` from `.env.example`. Set `IO_MODE=local-relay`, `DATA_DIR=/var/lib/io`, `LAN_BASE_URL` (for example `http://io.local:5000`), `SQUARE_ACCESS_TOKEN`, and `SQUARE_LOCATION_ID`. The Square token stays in this file.
3. Choose a long `RELAY_SHOP_SECRET`. Put the same value on the Cloudflare mailbox (`npx wrangler secret put RELAY_SHOP_SECRET`) and in `.env` as `RELAY_SHOP_SECRET`. Set `RELAY_PUBLIC_URL` to that worker. Do not put the Square token on Cloudflare.
4. Generate `BACKUP_ENCRYPTION_KEY` with `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"`. Set `BACKUP_DIR` to a USB drive or second disk. The key stays in `.env`.
5. Set a shop PIN from the strip settings with the owner key. Create the company, match each person to their Square team member, and record consent.
6. Start I/O as the `io` user on boot (`deploy/io.service`). Leave `HOST` unset. Do not forward the port on the router.
7. Optional updates: `UPDATE_ENABLED=1`, `UPDATE_CHANNEL=stable` (or `beta`), `UPDATE_AT=02:15`, `UPDATE_TZ=America/Chicago`. See `docs/updates.md`.

## Each person, about five minutes

1. On the shop Wi-Fi named Premiere, open the invite link the owner sent (`/join/...`). The page says `Setting up for <Name>`.
2. iPhone: copy the two automations and paste them into Shortcuts. One is the shop geofence. One is joining and leaving Premiere. Add one more shortcut for the NFC tag using the NFC lines in the note. Android: import the MacroDroid file. The NFC tap is the short POST in the same note. MacroDroid does not get a made-up NFC trigger.
3. The token is on that page once. It is tied to this person, their Square team member, and this shop.
4. Tap Test it. The page shows connected. That tap does not clock anyone in.
5. Program one NFC tag with the tap body from the note. One tag is the backup for the whole shop. The box decides in or out.
6. Walk a test: join Premiere or enter the geofence and confirm the strip clocks that person in. Leave the geofence on cellular, or tap the NFC tag, and confirm that same person clocks out. A manual tap on the strip still overrides.

The strip on each computer is the page served by the shop computer. It updates when the box does and shows What's new. Phones do not install an app update.
