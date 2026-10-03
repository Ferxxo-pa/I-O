# I/O

**Input vs Output.** A tiny trading-terminal strip that gamifies work.

```
I/O   +4.00
```

The strip is a glass widget on the right, meant to sit on a Mac or Windows desktop. **I/O** clocks you in and out. Hover it to see Clock in or Clock out. The green dot hops while you are in. The number is the money collected, ticking. Collapse it to just **I/O**. **+** shows what you've made, your points, the hourly rate, and reset. **Settings**, beside reset, is where you connect Telegram, add another integration, and create a company leaderboard. Three small color squares sit just outside the top-right of the widget and hop in a wave. Wages float in green, a paid invoice in pink, a message in blue.
- A paid invoice prints the amount, like `+$200`, for everyone watching. That sale is not added to your wages.

## Run

```bash
npm install
npm run dev
```

Open http://localhost:5000 — click the strip to clock in/out.

Demo hour = 10s. Real hour:

```bash
curl -X PATCH localhost:5000/api/config \
  -H 'content-type: application/json' \
  -d '{"hourDurationMs":3600000}'
```

## Push to your empty GitHub repo

```bash
# from this folder
git init -b main
git add -A
git commit -m "Initial commit: I/O trading-terminal work HUD"
git remote add origin https://github.com/Ferxxo-pa/I-O.git
git push -u origin main
```

## Square

Put a Square access token in the environment (`SQUARE_ACCESS_TOKEN`, and optionally location and team member ids). The server reads that team member's wage into **$/HR**. Every 15 seconds it checks invoices:

- Sent to a customer (unpaid or paid) → **+1** point
- Paid → a floating **+$200** (or whatever was collected), with the invoice title

Subscribe Square webhooks to `POST /api/square/webhook` for `invoice.published` and `invoice.payment_made`, and set `SQUARE_WEBHOOK_SIGNATURE_KEY` plus `SQUARE_WEBHOOK_NOTIFICATION_URL` to that exact URL.

Square does not publish a customer-messages API. Points follow invoices you send, which is the outbound message Square records.
