# I/O

**Input vs Output.** A tiny trading-terminal strip that gamifies work.

```
I/O   +4.00
```

The strip is a glass widget on the right, meant to sit on a Mac or Windows desktop. **I/O** clocks you in and out. Hover it to see Clock in or Clock out. The green dot hops while you are in. The number is the shared balance: Square collected minus wages. It moves as money moves. A thin bar under it shows which side is winning, green from the left and red from the right. A change flashes only `+$200` or `−$20`, and that same text goes to the company Telegram group when `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` are set. Collapse it to just **I/O**. **+** opens points and Settings. **Settings** shows the hourly rate, a Telegram handle, and Company. Join takes a code. Create takes a name and spins up a code that is also an invite link. Once you are in, the company name replaces the word Company, and the code sits on the right. Three small color squares sit just outside the top-right of the widget, hop in a wave, and change color. A collected invoice flashes green. Wages flash red. A message flashes blue.
- A paid invoice, like `+$200`, is money in. Wages are money out.

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
