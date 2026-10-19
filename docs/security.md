# Security

The shop computer holds the clock, the wages, and the Square token. This branch's Worker is a mailbox in front of that computer. It is not a second book.

## Mailbox

- Phones POST `{ event, trigger, ts, eventId }` with `Authorization: Bearer`. The Worker stores `sha256` of that token plus those four fields. It does not store the raw token.
- A body that includes a name, a wage, or an access token is rejected and stored as nothing.
- `/pull` and `/ack` require `RELAY_SHOP_SECRET`. Rows expire after 72 hours and the ack deletes them.
- Square webhooks are accepted only when `RELAY_SQUARE_WEBHOOK_KEY` and the notification URL are set. The stored row is kind, entity id, team member id, and time. The Square access token is not a Worker secret.
- There is no `TOKEN_KEY`, no sealed token column, and no Durable Object.

## Shop computer

The Express process keeps `data/io-state.json`, the shop PIN, and the Square token in `.env`. Do not commit `.env`. Phone setup links stay single-use. The fuller threat model for the shop computer is on the shop branch in `docs/security.md` after the local-relay pass.
