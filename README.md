# CritSit Dashboard

Live view of the AA / AE / gStore ticket reports and the IM Bridge case list
from Salesforce, refreshing automatically every minute (plus a manual
refresh button).

## How it works

- A small Node/Express server holds the Salesforce credentials and talks to
  Salesforce on the backend only — the browser never sees the client secret.
- It authenticates with the **OAuth 2.0 Client Credentials Flow**
  (`grant_type=client_credentials`), which requires the Connected App to
  have that flow enabled with a "Run As" user assigned.
- Ticket counts come from the Analytics REST API, running the same three
  reports (`AA Tickets`, `AE Tickets`, `gStore Tickets`) already configured
  in Salesforce, so the numbers always match what you'd see there.
- The IM Bridge table comes from the Case List View Results API, using
  the same columns and filters as the `IM_Bridge` list view as-is — no
  additional server-side filtering is applied.
- The frontend polls `/api/dashboard` every 60 seconds and on manual
  refresh; there's no build step, just static HTML/CSS/JS served by the
  same server.

## Setup

1. Install dependencies:
   ```
   npm install
   ```
2. `.env` is already filled in with the credentials and report IDs you
   provided. If you ever need to recreate it, copy `.env.example` and fill
   in:
   - `SF_CLIENT_ID` / `SF_CLIENT_SECRET` / `SF_INSTANCE_URL` — from the
     Connected App
   - `SF_REPORT_AA` / `SF_REPORT_AE` / `SF_REPORT_GSTORE` — report IDs
     (open each report, copy the ID from the URL)
   - `SF_CASE_LISTVIEW` — the list view's developer name (from
     `?filterName=` in its URL) or its 18-character ID

   **`.env` is gitignored — never commit it.** If this repo is ever pushed
   somewhere, rotate the client secret first if there's any doubt it was
   exposed.

## Run

```
npm start
```

Then open http://localhost:4000 (or whatever `PORT` is set to).

For local development with auto-restart on file changes:
```
npm run dev
```

## Salesforce-side requirements

- The Connected App must have **Client Credentials Flow** enabled, with a
  "Run As" user that has access to the three reports and the Case object/
  list view.
- If you rotate the client secret in Salesforce, update `SF_CLIENT_SECRET`
  in `.env` and restart the server.

## Troubleshooting

- **502 / "Salesforce authentication failed"** — check `SF_CLIENT_ID`,
  `SF_CLIENT_SECRET`, `SF_INSTANCE_URL`, and that Client Credentials Flow is
  enabled and active for the Connected App.
- **"Case list view ... not found"** — the "Run As" user may not have
  access to that list view, or `SF_CASE_LISTVIEW` doesn't match its
  developer name/ID.
- **Counts don't match Salesforce** — the report tiles count detail rows
  in the report's grand-total bucket; a report with groupings may need
  different handling (see `getReportRowCount` in `server/salesforce.js`).
# CritSit_Dashboard
# CritSit_Test
