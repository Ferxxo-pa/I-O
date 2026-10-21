# Set up I/O on the shop computer

This is for the person who runs the shop, on the Windows computer that stays at the shop. You do not need to be a programmer. When a step says to type something, it tells you where.

I/O is the little strip on the screen that shows the shop clocking in and out. Phones can clock people in when they arrive and out when they leave. The shop computer keeps the record. The phones do not get a new app from us.

## What you need

- The Windows computer that will stay on at the shop, plugged in, on the shop Wi-Fi. The Wi-Fi name is Premiere.
- Node.js 22. That is the program that runs I/O.
- Git. That is how this computer downloads I/O.

Employee computers and phones do not need Node or Git. They only open the address of this computer.

## Install Node.js 22 and Git

1. Download Node.js 22 for Windows from [https://nodejs.org/](https://nodejs.org/). Run the installer. Leave the boxes checked, including Add to PATH.
2. Download Git for Windows from [https://git-scm.com/download/win](https://git-scm.com/download/win). The default choices are fine.
3. Close any old Command Prompt windows, then open a new one. Type these two lines, one at a time, and press Enter after each:

```bat
node -v
git --version
```

`node -v` should start with `v22`. If Windows says it does not recognize `node` or `git`, close the window, open a new one, and try again.

## Put I/O on this computer

In Command Prompt:

```bat
git clone https://github.com/Ferxxo-pa/I-O.git C:\io
cd /d C:\io
scripts\start-shop.cmd
```

The first time, that script installs I/O, builds it, and makes a settings file named `.env` if you do not have one yet. Leave the window open. I/O is running while that window is open.

## The settings file

The settings live in `C:\io\.env`. Open it with Notepad:

```bat
notepad C:\io\.env
```

Set this line to the address of this computer on the shop Wi-Fi. If the line starts with `#`, delete the `#`. An example:

```text
LAN_BASE_URL=http://192.168.1.20:5000
```

To find the number, open another Command Prompt and type `ipconfig`. Under the Wi-Fi adapter, use the IPv4 address. Keep `http://` and `:5000`.

`http://io.local:5000` is the other address that sometimes works. If a phone or another computer cannot open `io.local`, use the number from `ipconfig` instead.

Leave these alone:

- Leave `HOST` blank. I/O listens on the shop Wi-Fi. It does not open a door from the internet.
- Leave `SQUARE_PRESENCE_MIRROR` blank. That keeps Square as a dry run. Hours and wages stay on this computer. I/O does not write wages to Square.
- Leave `UPDATE_ENABLED` blank. The overnight updater stays off until you turn it on. That choice is in [docs/updates.md](docs/updates.md).

A Square access token is optional. If you want Square connected, type the token on the `SQUARE_ACCESS_TOKEN` line in this file and save. The token stays in this file. Do not put it in a chat, a text, or an email. You can also set `SQUARE_LOCATION_ID` on its own line if you have it.

Save Notepad. In the window where I/O is running, press Ctrl+C, then run this again:

```bat
scripts\start-shop.cmd
```

On this computer, open the address you put in `LAN_BASE_URL`. You can also open `http://127.0.0.1:5000`.

These steps stay on the shop computer. You do not deploy a website from here.

## Company, person, consent, phone link, and PIN

Do this in the browser on the shop computer. That browser remembers that you are the owner. Use this same browser later for Change, Consent, and Phone.

1. Click **+**. The menu says to name the company, then set the shop PIN.
2. Click **Change**. Type the company name and press Enter.
3. Type a person's name and what they make per hour, then press Enter. That hourly rate stays on this computer. It is not sent to Square.
4. On that person's row, click **Consent**, then **Phone**.
5. The panel shows a link. You will open that link once, on that person's phone, in the next section.
6. Click **Close**. Click **+**, then the gear. Next to **PIN**, type 4 to 8 digits. Click somewhere else on the page so it saves. Type the PIN on this page. Do not send it in a chat.

If Square is connected, the names come from Square and you do not type the hourly rate. Consent and Phone are the same buttons. The rate still is not written back to Square.

## Set up a phone

The phone joins Premiere, the shop Wi-Fi. Open the Phone link on that phone while it is on Premiere. The page title is `Setting up for` and the person's name. Open it once. A second open is rejected. Click **Phone** again if you need a new link.

The page already has the shop address, the Wi-Fi name Premiere, and this phone's password. You do not type the password yourself, and you do not text it to anyone.

### iPhone

Shortcuts is already on the phone.

1. On the setup page, tap **Copy both automations**. Shortcuts opens, and the note is copied. Apple will not import an unsigned automation, so you paste the note into Shortcuts yourself.
2. In Shortcuts, open the Automation tab. Tap the plus button, then Create Personal Automation.
3. Make the automations the note lists: Arrive at 403 E Ben White Blvd, Austin. Leave that same place. Joined the Wi-Fi named Premiere. Left that Wi-Fi.
4. For each one, add Get Contents of URL. Use the address from the note. Show More, Method POST. Add a header named `Authorization` with the header line from the note. Request Body JSON, with the `event` and `trigger` lines from that part of the note.
5. Turn on Run Immediately. Ask Before Running stays off.
6. Go back to the setup page and tap **Test it**. A check means the phone reached the shop. That tap does not clock anyone in.

The field-by-field pictures are in [docs/presence-phone-automations.md](docs/presence-phone-automations.md). Use the address and the password from the note on the phone. The sample website in that other page is only a shape. Your note has the real address, which is this computer.

### Android

1. Install MacroDroid from the Play Store. Allow location all the time, including in the background, when Android asks.
2. On the setup page, tap **Download the automations**. That saves `ez-designs.macro`. Premiere and the shop geofence are already filled in.
3. Open MacroDroid and import `ez-designs.macro`.
4. Tap **Test it**. A check means the phone reached the shop. That tap does not clock anyone in.

The file is four macros: enter the shop, leave the shop, join Premiere, and leave Premiere. If the import will not save, the same four are described in [docs/presence-phone-automations.md](docs/presence-phone-automations.md).

## Check that it worked

1. On this computer, open `http://127.0.0.1:5000/api/health?probe=1`. The page should say `{"ok":true}`.
2. Open the address from `LAN_BASE_URL` on this computer. The strip should load.
3. Open `/presence` on that same address. The corner should say **Square dry run**.
4. On the phone, **Test it** should say connected. That does not clock anyone in.
5. Walk in, or fire the arrive automation. On this computer, click **I/O** and choose that person's name. The squares move while they are in.
6. Leave the shop, or leave Premiere. The leave is accepted right away. The strip clocks them out after about 15 minutes away.
7. Walk out and straight back in. They should stay clocked in. Those 15 minutes cover a short flicker.

A phone arrive clocks the strip. The day streak can still show 0 on the first test. The streak counts a shop day when the team clears the daily line. The default is one person, and the first test is still a check that the strip moved.

Square dry run means this clock did not open a Square timecard. That is what you want while you are setting up.

## Start when Windows starts

When the strip looks right, you can make I/O start on its own.

1. In File Explorer, go to `C:\io\deploy\windows`.
2. Right-click `install-boot.cmd` and choose **Run as administrator**.
3. Close the Command Prompt window that is running `scripts\start-shop.cmd`. One copy should be running. Two copies fight over the same door.

The computer stays awake while it is plugged in. After a restart, open the shop address again. `http://127.0.0.1:5000/api/health?probe=1` should still say `{"ok":true}`.

## Overnight updates

Updates are off until you turn them on. The computer can download a signed update around 2:15 AM Chicago time and put the old one back if the new one does not start. How to publish an update, and the exact lines to turn on, are in [docs/updates.md](docs/updates.md).

The computer has to be on around that time. The boot task above is what keeps I/O running overnight.

## If something goes wrong

- **Windows does not recognize `node`.** Close Command Prompt, open a new one, and check `node -v`. Install Node.js 22 again if it still fails, and leave Add to PATH checked.
- **The script says to install Node.js 22.** That is the same fix.
- **Another computer cannot open the page.** It has to be on Premiere. Use the IPv4 address, not `io.local`, if `io.local` fails. If Windows asks about a firewall, allow Node on private networks.
- **Change says only the owner can change that.** You are in a different browser than the one that created the company. Go back to that browser on the shop computer.
- **The phone link says it was already opened.** In Change, click **Phone** again and open the new link once.
- **Test it says not connected.** The phone should be on Premiere. Check that I/O is still running on the shop computer.
- **The strip does not move after an arrive.** On the shop computer, click **I/O** and choose that person. Consent has to be on for that person.
- **Two copies are running.** Close the `scripts\start-shop.cmd` window. Leave the startup task as the one that runs.
- **Square dry run is what you should see** on `/presence` while `SQUARE_PRESENCE_MIRROR` is blank. A dry run does not send a timecard or a wage.

The shorter test list is [TESTING.md](TESTING.md). The phone page in more detail is [docs/presence-phone-automations.md](docs/presence-phone-automations.md).
