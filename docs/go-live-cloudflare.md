# Cloudflare mailbox

The shop computer holds the book. This Worker is only the mailbox phones can reach when they leave Premiere. It stores a token hash, the event, the trigger, the time, and the event id. Rows expire after 72 hours and are deleted when the shop computer acks them. A Square webhook can be forwarded as kind, entity id, team member id, and time. Names, wages, and the Square access token are not stored here.

The strip is served by the shop computer. Do not point phones or the strip at this Worker for the clock. Phone Shortcuts and MacroDroid post `{ event, trigger, ts, eventId }` with the bearer token to `https://<worker>/drop`. The shop computer polls `/pull` with `RELAY_SHOP_SECRET`.

Do not merge this, and do not deploy it, until you mean to. The shop setup is `docs/go-live.md` on the shop branch.

## What you create

1. A free Cloudflare account.
2. `npx wrangler login`.
3. A D1 database named `io-mailbox`.
4. `RELAY_SHOP_SECRET`, the same value as the shop `.env`.

## Steps

```sh
npx wrangler d1 create io-mailbox --config worker/wrangler.toml
```

Paste the printed `database_id` into `worker/wrangler.toml`.

```sh
npx wrangler d1 execute io-mailbox --remote --config worker/wrangler.toml --file=worker/migrations/0001_init.sql
npx wrangler secret put RELAY_SHOP_SECRET --config worker/wrangler.toml
npx wrangler deploy --config worker/wrangler.toml
```

`npm run deploy:cf` is that deploy. It does not build or upload the strip.

Wrangler prints an origin like `https://io-mailbox.<your-subdomain>.workers.dev`. That origin is `RELAY_PUBLIC_URL` on the shop computer. There is no `TOKEN_KEY` and no `SQUARE_ACCESS_TOKEN` on this Worker.

Optional Square forward: set `RELAY_SQUARE_NOTIFICATION_URL` in `worker/wrangler.toml` to the exact URL Square calls, then `npx wrangler secret put RELAY_SQUARE_WEBHOOK_KEY`. Square's access token stays in the shop `.env`. The shop applies the hook with that local token.

## What is gone

Durable Objects, the company database, sealed Square tokens, the minute cron, R2 backups, and static strip hosting. Those kept a second copy of the book in Cloudflare. This Worker does not.
