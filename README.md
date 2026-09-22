# Matchday

A small self-hosted page a WhatsApp group can share to organise home games:
who brings what, when each person is around, and who helps pack down.

Sign in with your name and one shared group password. Available in **English,
German and French**. No accounts, no database server, no build step, no npm
dependencies — just Node 20+ and one JSON file.

---

## Run it

```bash
MATCHDAY_PASSWORD='pick-something-good' npm start
```

Then open <http://localhost:3000>. Share the link and the password in the group chat.

## Configuration

All settings are environment variables; every one is optional except the password,
which you should always set before sharing the link.

| Variable | Default | Purpose |
| --- | --- | --- |
| `MATCHDAY_PASSWORD` | `matchday` | The single shared password. **Always set this.** |
| `PORT` | `3000` | Port to listen on. |
| `HOST` | `0.0.0.0` | Bind address. |
| `MATCHDAY_DATA_DIR` | `./data` | Where `store.json` and `secret.key` live. |
| `MATCHDAY_SESSION_DAYS` | `30` | How long a sign-in lasts. |
| `MATCHDAY_TRUST_PROXY` | off | Set to `1` behind a reverse proxy: honours `X-Forwarded-For` and marks the cookie `Secure`. |
| `MATCHDAY_SECURE_COOKIE` | off | Force the `Secure` cookie flag without trusting proxy headers. |
| `MATCHDAY_SESSION_SECRET` | auto | Pin the signing key. Generated into `secret.key` if unset. |

There is no per-user password: the group password is the only gate, and the name
identifies who is bringing what.

## Signing in

Everyone enters **their name** plus the **shared group password**. The name is
what signs the items you bring and the hours you offer, so the lists always say
who did what; the password is the only access control.

Names are canonicalised against a roster, so "regis", "Regis" and "REGIS" all
resolve to one person instead of three. Click your name in the top bar to change
it later. The roster of everyone who has signed in is listed under Settings.

## Languages

English, German and French. The interface picks up the browser language on first
visit and can be changed under **Settings → Language**; the choice is remembered
per device. Weekday and month names come from `Intl`, so dates read naturally in
each language, and the catering presets are translated too (Coffee / Kaffee /
Café). The WhatsApp summary is generated in the active language.

Adding a fourth language means adding one block to `public/i18n.js` — copy the
`en` block, translate the values, and add the code to `LANGS` and `PRESETS`.

## What the group can do

**Home games** — date, kickoff, opponent, venue, free-text notes, and a *duty
window* (the span people can sign up inside, e.g. 13:00–18:00).

**Catering** — a shared, fully editable list. Anyone taps **"I'll bring it"** to
claim an item, **Drop** to release it, or **Take over** to swap with someone.
Items carry an optional quantity (`2 L`, `3 boxes`) and a note. One-tap chips add
the usual suspects (coffee, milk, fruit…). The card header shows `4/7 covered`.

**Availability** — each person adds the window they can help, e.g. *12:00–13:00*.
Underneath, a coverage bar shades the duty window by how many people overlap each
moment and calls out the holes: *"⚠ Nobody covering 14:00–16:00"*. That gap
warning is the thing a chat thread can never tell you.

**Teardown crew** — set a target headcount, people opt in with one tap, and the
progress bar says how many more are still needed.

**Copy for WhatsApp** — renders the whole fixture as a formatted message (bold
headers, ✅/⬜ per item, the unclaimed count, who is available when, who is on
teardown, and how many more are needed) ready to paste back into the group.

**Lock** — freeze a fixture once everything is settled so nobody edits it by
accident. Past games move to the **Past** tab by themselves the next day.

## How it works

- **Sign-in** — the password is compared by hashing both sides and using
  `timingSafeEqual`, so no timing side channel. A name is required as well, but it
  is an identity label, not a second secret — anyone with the password can sign in
  under any name. Success sets an HMAC-signed, `HttpOnly`, `SameSite=Strict`
  cookie carrying only an expiry. There is nothing to steal from the cookie and no
  server-side session table.
- **Brute force** — 10 wrong guesses from one IP triggers a 10-minute cooling-off
  period; correct guesses are rejected too while it lasts.
- **CSRF** — mutations require an `X-Matchday: 1` header, which cross-site form
  posts cannot set, on top of `SameSite=Strict`.
- **Storage** — one JSON file written atomically (temp file + `rename`) through a
  serialized queue, so a crash mid-write cannot corrupt it and concurrent
  requests cannot interleave. Every mutation bumps a revision counter.
- **Sync** — open pages poll every 20s (and whenever a tab regains focus) and
  re-render only when the revision changes, so two phones editing the same list
  converge within seconds.
- **Input** — every field is length-capped and whitespace-normalised on the
  server; dates and times must match `YYYY-MM-DD` / `HH:MM`; all rendered strings
  are HTML-escaped on the client.
- **Identity** — your name is remembered in `localStorage` for the next sign-in and
  added to a shared roster so spelling stays consistent across devices. Anyone with
  the password can edit anything; removing someone else's entry asks for
  confirmation first.
- **Language** — chosen per device in `localStorage`; it never affects what other
  members see.

## Files

```
server.js          HTTP server, routing, validation, storage (no dependencies)
public/index.html  markup and dialogs
public/styles.css  theming and layout
public/i18n.js     EN/DE/FR strings and catering presets
public/app.js      rendering and interactions
data/store.json    all shared state (created on first use)
data/secret.key    session signing key (auto-generated, chmod 600)
```

## Backups

The only state is `data/store.json` — copy it anywhere.

```bash
cp data/store.json ~/matchday-backup-$(date +%F).json
```

## Keeping it running

```bash
# systemd (Linux)
sudo tee /etc/systemd/system/matchday.service >/dev/null <<'EOF'
[Unit]
Description=Matchday
After=network.target

[Service]
WorkingDirectory=/opt/matchday
ExecStart=/usr/bin/node server.js
Environment=MATCHDAY_PASSWORD=change-me
Environment=PORT=3000
Restart=always
User=matchday

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl enable --now matchday
```

Put it behind a TLS-terminating reverse proxy (Caddy, nginx, Cloudflare Tunnel)
and set `MATCHDAY_TRUST_PROXY=1`. A password over plain HTTP travels in clear
text, so use HTTPS for anything beyond your own LAN.
