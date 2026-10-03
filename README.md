# I/O

**Input vs Output.** A tiny trading-terminal strip that gamifies work.

```
I/O   +4.00
```

The strip is a glass widget on the right, meant to sit on a Mac or Windows desktop. **I/O** clocks you in and out. Hover it to see Clock in or Clock out. The green dot hops while you are in. The number is today's shared balance: money in minus money out, for the America/Chicago day. The thin bar is green from the left for what came in and red from the right for what went out. Collapse it to just **I/O**. **+** opens personal pay, the clock, and Settings. **Settings** shows the hourly rate, a Telegram handle, and Company. Join takes a code. Create takes a name and spins up a code that is also an invite link. Once you are in, the company name replaces the word Company, and the code sits on the right. A new amount flashes as `+$300` or `−$60` and, when a bot is configured, the same text goes to the company Telegram group.
- A completed Square payment counts after its processing fee, once. Cash and check income count too. Closed-shift labor and operating expenses count against the day. Investment activity does not. A refund or correction replaces the original amount instead of adding a second one.

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
