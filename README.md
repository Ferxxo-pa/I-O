# I/O

**Input vs Output.** A tiny trading-terminal strip that gamifies work.

```
I/O   +4.00
```

The strip is a glass widget on the right, meant to sit on a Mac or Windows desktop. **I/O** clocks you in and out. Hover it to see Clock in or Clock out. The three squares above the strip stay gray until you clock in. Then they bounce back and forth at one tempo and change color. The numbers are the shared book: green is Square money collected, red is wages. A thin bar under them shows which side is winning, green from the left and red from the right. A change flashes only `+$200` or `−$20`. Collapse it to just **I/O**. **+** opens points and Settings. **Settings** is the company. Join takes a code. Create takes a name and spins up a code that is also an invite link. Once you are in, the company name replaces the word Company, and the code sits on the right. The person who created the company can open **Change**, see everyone, and set what each person makes per hour. When Square is connected, those rates come from Square. A collected invoice flashes green. Wages flash red. A sent invoice flashes blue.
- A paid invoice, like `+$200`, is money in. Wages are money out.

## Run

```bash
npm install
npm run dev
```

Open http://localhost:5000. Each PC links to one person, then **I/O** clocks that person in and out. The green and red numbers stay the whole business.

```bash
npm run build
npm start
```

A paid hour is a real hour. Wages, collected money, the rate, and the company are written to `data/io-state.json` (or `DATA_DIR`) and survive a restart. Copy `.env.example` for Square and the port. `GET /api/health` is the process check.

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

Put a Square access token in the environment (`SQUARE_ACCESS_TOKEN`, and optionally location and team member ids). Square then sets **$/HR** from the team, and Change shows those rates instead of asking for them again. Each person picks their own name from that Square team. **I/O** opens and closes that person's timecard. Every open wage still adds into the one red number, and collected invoices stay the one green number.

Every 15 seconds it checks invoices. The first check remembers invoices that already exist so history is not replayed. After that, and on the webhook, a new invoice counts even if the process restarted while it was paid:

- Sent to a customer (unpaid or paid) → **+1** point
- Paid → a floating **+$200** (or whatever was collected)

Subscribe Square webhooks to `POST /api/square/webhook` for `invoice.published`, `invoice.payment_made`, `labor.timecard.created`, and `labor.timecard.updated`. Set `SQUARE_WEBHOOK_SIGNATURE_KEY` plus `SQUARE_WEBHOOK_NOTIFICATION_URL` to that exact URL. A timecard opened in Square still counts that person's wage here.

Square does not publish a customer-messages API. Points follow invoices you send, which is the outbound message Square records.
