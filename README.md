# Front Desk

One-card-at-a-time front desk for a flooring store. Reads GoHighLevel (leads, calls, texts) and QuickBooks (estimates, deposits), tells the receptionist exactly what to do next, drafts the texts, and reports to the owners.

Live: https://frontdesk-app.netlify.app · Supabase project `rzaptykiirntegysuulr` (front-desk)

## Layout

```
web/            the app — one static page
  app.html      structure (placeholders for css/js/icons)
  app.js        all behaviour (supabase-js UMD, magic-link auth, hash routes)
  focus.css     card / panel / note styles      base.css   app chrome
  blueprint.css Palantir Blueprint 6 (Apache-2.0), bp6- prefix
  icons.svg     inline icon sprite
build.py        inlines everything into web/dist/index.html (+ _redirects, manifest)
netlify.toml    Netlify builds with `python3 build.py`, publishes web/dist
supabase/
  migrations/   schema: stores, members, invites, leads, lead_events, tasks, appointments,
                estimates, invoices, payments, daily_reports, desk_settings, integrations,
                team_tasks (the Board: internal Sales / Ops / Marketing tasks, separate from the lead-card `tasks`)
  functions/
    ghl-sync    GHL → leads/lead_events (full / incremental / backfill)
    desk-rules  the task engine: SLA, cadence, chases, confirms, focus/eod
    desk-tick   app nudge: sync + rules (+ push walk-in to GHL)
    ghl-send    send one SMS through GHL
    desk-note   note on a lead → mirrored to GHL; "I promised…" → task
    qbo-connect / qbo-callback / qbo-sync   QuickBooks OAuth + sync
    _shared/    ghl.ts, qbo.ts (copied into each function at deploy — Supabase MCP deploys don't follow ../_shared)
```

## Working on it

Edit `web/*`, then:

```
python3 build.py                 # → web/dist/index.html
# deploy: Netlify builds from this repo once it's linked (Site settings → Build & deploy → Link repository),
# or manually: cd web/dist && netlify deploy --prod --dir .
```

Edge functions: deploy with the Supabase MCP / CLI (`supabase functions deploy <name> --project-ref rzaptykiirntegysuulr`).
`ghl-sync` runs with `verify_jwt=false` (it checks the service key / `x-desk-key` itself); every other function needs a signed-in user.

## Board

`#board` — the team's Sales / Ops / Marketing tasks (`team_tasks`). Owners come from `desk_settings.settings.team`
(a list of names; people don't need a login to own a task). Nothing here feeds the Today stack.

## Config (never in the repo)

- `web/app.js` holds only the Supabase URL + publishable anon key.
- GHL token, cron key: `integrations` table (service role only).
- `QBO_CLIENT_ID`, `QBO_CLIENT_SECRET`: Supabase → Edge Functions → Secrets.

## Cron (Supabase → Integrations → Cron)

- `desk-rules` every minute, `ghl-sync` (incremental) every 2 minutes, body `{"store_id":"<store uuid>"}` with header `x-desk-key`.
