# Grab I/O — portable handoff

This folder is a **clean, standalone** copy of I/O. No CastAloud history.

## Option A — your machine → GitHub I-O

```bash
unzip io_portable.zip   # or tar -xzf io_portable.tar.gz
cd i-o   # or whatever folder name
npm install && npm run dev
# then push (see README)
```

## Option B — new Cursor Cloud Agent on I-O

1. New agent @ https://cursor.com/agents
2. Repo: **Ferxxo-pa/I-O**
3. Upload/unzip this package into the workspace (or paste README + ask it to recreate from GRAB_ME)
4. `git add -A && git commit && git push`

## Option C — git bundle

```bash
git clone io_portable.bundle I-O
cd I-O
git remote add origin https://github.com/Ferxxo-pa/I-O.git
git push -u origin main
```
