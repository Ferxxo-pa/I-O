# Go live on Cloudflare

The shop computer can stay as a fallback. This path does not need it. One Worker is the book for every shop. Each shop is `company.id`. Phones, the strip, and Square all talk to that Worker. Nothing on the shop PC has to stay on.

The strip is the same build the shop already uses. It is served from the Worker as static files, on the same origin as the API. Leave `VITE_IO_SERVER_URL` unset. The strip still polls. There is no visual change.

Do not merge this while you are still proving it. The shop PC path (`npm run dev`, `docs/go-live.md`) keeps working.

## What you create

1. A free Cloudflare account.
2. `npx wrangler login` on a computer that has this repo.
3. A D1 database named `io`.
4. An R2 bucket named `io-backups`.
5. Two wrangler secrets: `TOKEN_KEY` and `BACKUP_KEY`. Each is 32 random bytes, base64. They seal Square tokens and the nightly dump. They are not the Square token.
6. Square webhooks pointed at the Worker URL below.

## Steps

From the repo root:

```sh
npm ci
npx wrangler login
npx wrangler d1 create io --config worker/wrangler.toml
npx wrangler r2 bucket create io-backups --config worker/wrangler.toml
```

Paste the printed D1 `database_id` into `worker/wrangler.toml` where it says `replace-after-wrangler-d1-create`.

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
npx wrangler secret put TOKEN_KEY --config worker/wrangler.toml
npx wrangler secret put BACKUP_KEY --config worker/wrangler.toml
npx wrangler d1 migrations apply io --remote --config worker/wrangler.toml
npm run deploy:cf
```

`npm run deploy:cf` builds the strip and runs `wrangler deploy`. Wrangler prints the origin, like `https://io.<your-subdomain>.workers.dev`. That origin is the strip and the API.

Square, per company, stays out of git:

```sh
TOKEN_KEY='the same base64 you just set' npm run import:cf -- data/io-state.json --square-token 'YOUR_SQUARE_TOKEN' --location YOUR_LOCATION_ID
npx wrangler d1 execute io --remote --config worker/wrangler.toml --file=data/io-import.sql
```

`data/io-import.sql` holds the sealed token, not the plaintext. Delete that file after it loads if you do not want the ciphertext sitting on disk. The owner key in `io-state.json` is stored only as a hash. Keep the JSON, or the owner key you already wrote down. The hosted shop PIN, if the file still has an scrypt hash from the PC, will not check on the Worker. Set the PIN again in Settings after the first load. New PINs are PBKDF2.

If you have one shop and you would rather not run the import for the token, you can also:

```sh
npx wrangler secret put SQUARE_ACCESS_TOKEN --config worker/wrangler.toml
npx wrangler secret put SQUARE_WEBHOOK_SIGNATURE_KEY --config worker/wrangler.toml
```

That secret is the fallback when a company row has no sealed token. A second shop should use the import (or **Settings** is not where the token goes). The owner posts the token once:

`POST /api/company/square` with the owner key and `{ "token", "webhookKey", "locationId" }`. The response includes `webhookUrl`. The token is sealed with `TOKEN_KEY` before it is written. The Worker never logs it.

In Square, subscribe `invoice.published`, `invoice.payment_made`, `labor.timecard.created`, and `labor.timecard.updated` to:

```text
https://io.<your-subdomain>.workers.dev/api/square/webhook/<company.id>
```

The notification URL Square signs must be that exact URL. `company.id` is the id from the company response. It is not a secret. The signature key is.

Open the Worker origin. Create the company if you did not import one. Set the shop PIN. Add people, or import them. Record consent, then `POST /api/presence/phone/setup` with the owner key. Send the `inviteUrl`. The phone opens `/join/<code>` on the Worker. Test it. Arrive uses the shop geofence or Premiere. Leave posts to the same Worker from cellular. There is no mailbox and no shop PC in this path.

`GET /api/health?probe=1` is `{ "ok": true }`. The Ready list is the rest of `/api/health`.

## What runs

- A Durable Object per company serializes clock writes, so two phones cannot open two timecards for one person.
- D1 holds the company, people, devices, punches, sessions, and the ledger.
- Square webhooks are checked first. A cron every minute reconciles open timecards and recent invoices. The 15 second loop stays on the shop PC only.
- This app still does not write wages. A timecard create copies the hourly Square already has. `wage-setting` is never updated.
- Nightly at 08:00 UTC the cron seals a D1 dump and puts it in R2 at `backups/YYYY-MM-DD.json.enc`.
- The strip keeps polling `/api/state`. CORS allows only this Worker's own origin.

## Optional Google Drive copy

R2 is the backup. Drive is a second copy if you want one.

1. Install [rclone](https://rclone.org/).
2. `rclone config` and make a Cloudflare R2 remote named `io-r2` (S3 API, account id, a token that can read `io-backups`).
3. `rclone config` a Google Drive remote named `io-drive`, pointed at a private folder.
4. Nightly, after 08:00 UTC:

```sh
rclone copy io-r2:io-backups io-drive:io-backups --include "backups/*.json.enc"
```

The file stays encrypted. `BACKUP_KEY` decrypts it. Do not put `BACKUP_KEY` in Drive.

## Free tier, and where it does not fit

Checked against Cloudflare's published limits (Workers, D1, Durable Objects, R2):

| | Free | This shop |
| --- | --- | --- |
| Worker requests | 100,000 / day | Cron is about 1,440/day, plus one webhook per Square event, plus a phone post per arrive or leave. That fits. |
| Worker CPU | 10 ms / request | Clock, webhook, and cron stay under that. Network waits do not count. PBKDF2 on a PIN is only on the first check; later polls use a short reader cookie. |
| Durable Object requests | 100,000 / day, shared with Workers | Clock, phone, webhook, and cron hit the object. Polls of `/api/state` do not. |
| D1 rows read | 5 million / day | Fits if queries stay on indexed company id. |
| D1 rows written | 100,000 / day | Clock and phone writes fit. Do not write on every poll. |
| D1 storage | 5 GB total, 500 MB per database on the free plan | A shop year of punches is far under that. |
| R2 | 10 GB-month, 1 million writes / month | One small encrypted dump a night fits. |
| Cron triggers | 5 per account on the free plan | This Worker uses 2. |
| Static assets | Unlimited, not billed as requests | The strip files themselves are free. |

The gap is the open strip. The client polls `/api/state` every 200 ms so the bar stays live. One strip left open for a full shop day is on the order of 150,000 Worker requests, which is over the 100,000/day free cap. Two strips, or a strip left open overnight, pass it sooner. Phones, webhooks, cron, and D1 do fit the free plan. The polling strip is the part that does not, unless the browser is closed when nobody is looking at it.

Workers Paid is $5/month and includes 10 million requests. That covers a few strips polling through the day. Durable Objects on the free plan must be SQLite-backed. This Worker uses that.

CPU on the free plan is 10 ms. A cron that pages through a very large Square invoice history can trip it. The reconcile asks for one page. If Square is slow to respond, waiting does not count as CPU. If a request starts failing with error 1102, that is the CPU limit, and the Paid plan is the fix.

## Shop PC

`npm test` still runs the Express book. `npm run dev` still serves the strip from the computer in `docs/go-live.md`. Shared clock, phone, and Square decisions live in `shared/cloud/` and both runtimes call them. Iban's shop clock still reads `getCompany().people` on the PC.
