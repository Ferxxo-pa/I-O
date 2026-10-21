# Set up I/O with Codex

On the shop Windows computer, open a new Codex chat. Copy everything in the box below, paste it as your first message, and send it. Codex then walks you through setup. You type secrets only in the settings file or on the I/O page. You do not paste them into the chat.

~~~~text
You are setting up I/O on this Windows shop computer for the owner. He is not a programmer. Work one step at a time. Wait for him whenever you need a choice or a value. After you clone the repo, read SETUP.md and follow it. If this prompt and SETUP.md disagree on a safety rule, follow the safer rule below.

Safety rules, the whole time:
- Never ask him to paste a secret into the chat. Secrets include the Square access token, the shop PIN, a phone bearer token, the owner key, RELAY_SHOP_SECRET, BACKUP_ENCRYPTION_KEY, a webhook key, and the update signing private key (update-private.pem or any PEM that says PRIVATE KEY).
- When a secret belongs in .env, open that file in Notepad, put the cursor on the empty line, and ask him to type it there and save. Do not read the secret back. Do not print it. Do not put it on a command line.
- The Square token stays in .env only. You never ask him to paste it here.
- Leave SQUARE_PRESENCE_MIRROR unset. Square stays a dry run. I/O must not write wages or an hourly rate to Square. Do not set SQUARE_PRESENCE_MIRROR=live unless he explicitly says to, and even then do not put an hourly rate in any Square request.
- Leave UPDATE_ENABLED off until you offer overnight updates and he says yes.
- Do not run npm run deploy:cf, npm run relay:deploy, or wrangler deploy.
- Do not commit .env, pem files, or anything under data\.
- Do not merge pull requests. Leave draft pull requests alone.
- Run one copy of I/O. Two copies fight over port 5000.

Steps:

1. Check this PC. Confirm it is Windows. Check git and Node. Node must be major version 22. Show him `node -v` and `git --version`. If one is missing, ask before installing. If he says yes, you may run:
   winget install --id OpenJS.NodeJS.22 -e --accept-package-agreements --accept-source-agreements
   winget install --id Git.Git -e --accept-package-agreements --accept-source-agreements
   Then open a new terminal so PATH updates. If winget is not there, send him to https://nodejs.org/ for Node.js 22 and https://git-scm.com/download/win for Git, and wait until both commands work.

2. Ask where to put the app. The default is C:\io. If that folder is already this repo, use it. Otherwise clone https://github.com/Ferxxo-pa/I-O.git and check out main. Stay on main. Do not check out a draft branch.

3. Read SETUP.md, docs\updates.md, and deploy\windows\install-boot.cmd.

4. If .env is missing, copy .env.example to .env. Then ask him for the shop address. Run ipconfig, find the Wi-Fi IPv4 address, and suggest LAN_BASE_URL=http://THAT_IP:5000. Also tell him http://io.local:5000 sometimes works, and the IP is the reliable one. Write the line he confirms into .env. Leave HOST unset. Leave IO_MODE unset so the shop stays on the local relay.

5. Ask if he wants a Square token now. If yes, open Notepad on .env, point at the SQUARE_ACCESS_TOKEN line, and leave the room while he types it and saves. You do not watch, copy, or repeat the token. If he has a Square location id, he can type SQUARE_LOCATION_ID the same way. Leave SQUARE_PRESENCE_MIRROR unset.

6. Show him the non-secret lines you wrote (LAN_BASE_URL, and that Square mirror and updates are still off). Ask him to confirm before you start.

7. Start I/O with scripts\start-shop.cmd. Leave that window open. The first run installs and builds.

8. Verify. Open http://127.0.0.1:5000/api/health?probe=1 and confirm it says {"ok":true}. Open the LAN_BASE_URL in the browser on this PC. Walk him through the page, still following SETUP.md:
   - Click +, then Change. He types the company name and presses Enter.
   - He types a person's name and hourly rate and presses Enter. Tell him that rate stays on this PC and is not sent to Square.
   - He clicks Consent, then Phone. The link is for that person's phone.
   - He closes Change, clicks +, then the gear, and types a 4 to 8 digit PIN on the page. He clicks elsewhere so it saves. He does not tell you the PIN.
   Do this in the browser on the shop PC. That browser stores the owner key. Later Change, Consent, and Phone have to be in this same browser.

9. Phone. He opens the Phone link once, on that person's phone, while the phone is on the shop Wi-Fi (Premiere). iPhone: tap Copy both automations and paste into Shortcuts. Android: install MacroDroid, tap Download the automations, and import ez-designs.macro. Then tap Test it. That tap does not clock anyone in. The page already contains the address and the phone password. Do not ask him to read the password to you. Details are in SETUP.md and docs\presence-phone-automations.md. Use the note on the phone, not a sample website.

10. Check /presence on this PC. It should say Square dry run. If the health check failed, fix that before you continue. Say what you tried and what the page showed.

11. Ask if I/O should start when Windows starts. If he says yes, run deploy\windows\install-boot.cmd from an Administrator prompt (right-click, Run as administrator, or an elevated terminal). That task starts I/O at boot and keeps the PC awake while it is plugged in. Then close the scripts\start-shop.cmd window so only one copy is running, run the scheduled task if the script did not, and check the health URL again.

12. Offer overnight updates. Explain it in plain language: around 2:15 AM Chicago time, this computer can download a signed update and undo it if the new version does not start. It stays off until he says yes. The PC has to be on around then, which is why the boot task matters.
    If he says no, leave UPDATE_ENABLED unset and tell him the lines are in docs\updates.md when he wants them.
    If he says yes:
    - Set UPDATE_ENABLED=1, UPDATE_CHANNEL=stable, UPDATE_AT=02:15, UPDATE_TZ=America/Chicago, and UPDATE_WINDOW_MIN=90 in .env.
    - The shop needs the public key only. If he already has update-public.pem, set UPDATE_TRUST_PUBKEY to that file path.
    - If he does not, ask before generating a key pair. If he says yes, run a node command that writes update-private.pem and update-public.pem into the repo folder and does not print the private key. Set UPDATE_TRUST_PUBKEY to the public file path. Do not open, print, copy, or upload update-private.pem. Tell him to add that file himself as the GitHub Actions secret UPDATE_SIGNING_KEY on an environment named release, using the GitHub website, then delete update-private.pem from this PC. The private key never goes in chat and never goes in .env.
    - Restart I/O so it reads .env.
    - Tell him nothing installs until he runs the Release workflow on main and then publishes the draft. Drafts are ignored. The steps are in docs\updates.md. You do not run that workflow and you do not publish a release.

13. Stop. Summarize, in plain language: where I/O is installed, the LAN address, that Square is a dry run, whether the boot task is on, whether overnight updates are on, and anything he still has to do himself (Square token in Notepad, GitHub signing secret, publishing a draft later). Do not include any secret in that summary.
~~~~
