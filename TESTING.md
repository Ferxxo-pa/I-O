# Test I/O on the shop PC

This is the first run on the Windows computer at the shop. The plain-language owner guide is [SETUP.md](SETUP.md). The longer owner checklist is [docs/tester-setup.md](docs/tester-setup.md). Phone trigger screens are [docs/presence-phone-automations.md](docs/presence-phone-automations.md). Overnight updates stay off for this test. How the checksum, signature, and rollback work is [docs/updates.md](docs/updates.md).

Square stays a dry run. Do not set `SQUARE_PRESENCE_MIRROR`. Do not run `npm run relay:deploy` or `deploy:cf`. Do not put a Square token anywhere except `.env` on this PC. The hourly rate you type stays on this PC. I/O does not send it to Square.

## Start

1. Install Node.js 22.
2. Clone `https://github.com/Ferxxo-pa/I-O.git` and stay on `main`.
3. From the repo folder, run:

   ```bat
   scripts\start-shop.cmd
   ```

   That installs, builds, and starts I/O. The first run copies `.env.example` to `.env` when `.env` is missing.
4. In `.env`, set `LAN_BASE_URL` to this PC on the shop Wi-Fi, for example `http://192.168.1.20:5000`. Leave `HOST` unset. Leave `SQUARE_PRESENCE_MIRROR` unset. Leave `UPDATE_ENABLED` unset. A Square token in `SQUARE_ACCESS_TOKEN` is optional and stays in this file.
5. Stop the script with Ctrl+C and run `scripts\start-shop.cmd` again so it reads `.env`.
6. On this PC, open the address you put in `LAN_BASE_URL`.

## Add a person

1. Click **+**. If the book has not loaded yet, the menu says to name the company, then set the PIN.
2. Click **Change**. Type the company name and press Enter.
3. Type a name and an hourly rate, then press Enter. That rate is not sent to Square.
4. Click **Consent** on that person, then **Phone**.
5. Close Change. Click **+**, then the gear. In **PIN**, type 4 to 8 digits and click away so it saves. The strip loads after the PIN is set.
6. Open the link the panel shows, once, on that person's phone while the phone is on Premiere. The page title is `Setting up for <Name>`.

## Clock in and out from the phone

On iPhone, tap **Copy both automations** and paste into Shortcuts. On Android, use the MacroDroid import on that same page. The field-by-field version is [docs/presence-phone-automations.md](docs/presence-phone-automations.md). Tap **Test it**. That tap does not clock anyone in.

Walk in, or fire the arrive automation. The body is a POST:

```json
{"event":"arrive","trigger":"geo"}
```

Header: `Authorization: Bearer` plus the token from that page. On the shop LAN an arrive posts to `LAN_BASE_URL/api/presence/phone` and, if you configured the mailbox, to the mailbox. A leave posts to the mailbox so it still works on cellular. For this test, with no mailbox, post the leave to the same shop URL:

```json
{"event":"leave","trigger":"geo"}
```

The arrive clocks that person in. On this PC, click **I/O** and choose their name so the strip follows them. The squares move while they are in. A leave is accepted right away. The strip clocks them out after 15 minutes away.

## Streak, week bar, dry run

1. Click **+**. Under the flame, the number and the words **day streak** are the streak. Under that are the Monday–Sunday letters. That row is the week bar.
2. Open `/presence`. The corner says **Square dry run**.
3. Those two read accepted punches, and a day counts when the team clears the threshold. The default is one person. `PRESENCE_SHOP_DAY_MIN_PEOPLE` is in `.env.example`. A phone arrive clocks the strip. It does not by itself raise the streak, so a first test still shows **0** and **Out** on `/presence` while the strip is clocked in.
4. Confirm dry run: `SQUARE_PRESENCE_MIRROR` is unset, `/presence` says Square dry run, and the phone clock does not open a Square timecard. Any planned Square calls would be only in `data/presence-square-dry.jsonl`, and that file must not contain an hourly rate.
