# Security

The shop PC and the Cloudflare Worker enforce the same doors. The Worker adds tenant isolation, sealed tokens, and a locked browser origin.

## Who can call what

- The strip, the clock, and presence require the shop PIN or the owner key once the server is public. On the Worker that is always true. `GET /api/health?probe=1` stays open so a monitor can see that the process is up.
- Clock in and clock out require the shop PIN. The linked person in `x-person-id` has to match the body.
- Phone arrive and leave use the bearer token from `/join`. The token is bound to one person and that person's Square team member. A token from shop A is rejected if it is presented as shop B.
- Owner routes (people, consent, phone setup, sealing a Square token) require the owner key. The key is returned once, when the company is created. The database stores `sha256` of it.
- Square webhooks require the signature over the exact notification URL plus the raw body. A bad signature is 403.
- The shop PIN is 4 to 8 digits. The PC stores scrypt. The Worker stores PBKDF2. A wrong PIN is 401. Repeated posts are rate limited.
- After a good PIN, the Worker sets an HttpOnly reader cookie so the strip can poll without running PBKDF2 on every 200 ms request. The cookie is bound to one company and expires in 12 hours.

## Tenants

One Worker holds every shop. Every row is keyed by `company.id`. A request with shop B's owner key does not read shop A's book. Phone tokens resolve the company from the token hash, not from a header the caller can swap.

Clock writes for one company run inside that company's Durable Object, one at a time. A second arrive while the first timecard is opening attaches the open card. It does not create another.

## Square

- Tokens and webhook signature keys are sealed with AES-GCM before they land in D1. The key is the wrangler secret `TOKEN_KEY`. It is not in git.
- A single-shop fallback secret `SQUARE_ACCESS_TOKEN` is used only when that company has no sealed token.
- The Worker never writes a wage. Calls to `wage-setting` with anything other than GET are refused. A timecard create copies the hourly amount Square already stored so labor cost is recorded. It does not change the team member's wage.
- Webhooks are the primary signal. The minute cron only reconciles. An invoice id already on the ledger is not counted again. An open timecard id already on the shift is not opened again.

## Browser

- CORS allows the Worker's own origin and no other. A page on another host cannot read the book. Phones do not send `Origin`, and they still pass.
- The PC build can still list origins in `IO_CORS_ORIGINS`. The Worker does not honor `*`.
- The strip is static assets on the same host. `VITE_IO_SERVER_URL` stays unset, so the browser does not call a second origin.

## Logs and backups

- Audit rows store an action and a role (`owner`, `pin`, `phone`, `square`, `cron`). They do not store a name, a token, a wage, or a raw body.
- Log lines run through a redaction pass that strips bearer tokens, email addresses, and long ids.
- Nightly, the cron exports D1 and seals the file with `BACKUP_KEY` into R2. The Square token inside that dump is still the sealed column, and the file is sealed again. An optional rclone copy to Google Drive is in `docs/go-live-cloudflare.md`. Drive never sees `BACKUP_KEY`.

## Shop PC

The Express process is the fallback. It still keeps `data/io-state.json` on disk, the shop PIN hash, and the relay mailbox for cellular leaves when `IO_MODE=local-relay`. Do not commit `.env`. `PUBLIC_BASE_URL` turns on the same PIN-or-owner door the Worker always uses.

Phone setup links stay single-use. The token is sealed until the phone opens `/join/<code>`.
