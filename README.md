# Growisto Nurture Dashboard — Auto-refresh Deploy Guide

Free, fully automated: every day at ~8:07 AM IST, GitHub Actions pulls fresh
data from Zoho CRM, rebuilds the dashboard, and deploys it to Cloudflare
Pages. No server, no paid plan, no manual zip uploads.

## Folder structure (do not change)
```
deploy/
├── index.html                          ← dashboard UI (STATIC_DATA gets rewritten daily)
├── dashboard_data.json                 ← latest data snapshot (for reference/debugging)
├── scripts/
│   └── refresh-data.mjs                ← pulls Zoho data, rebuilds index.html
└── .github/
    └── workflows/
        └── daily-refresh.yml           ← the daily cron job
```

---

## STEP 1 — Get Zoho API credentials (10 min)

1. Go to https://api-console.zoho.com
2. Click **Add Client** → **Self Client** → Create
3. Copy your **Client ID** and **Client Secret**
4. Click **Generate Code** tab
   - Scope: `ZohoCRM.modules.ALL,ZohoCRM.users.ALL,ZohoCRM.settings.ALL`
   - Time Duration: 10 minutes
   - Click **Create** → copy the **code** (expires in 10 min!)
5. Open PowerShell and run (replace CLIENT_ID, CLIENT_SECRET, CODE):

```powershell
$body = "grant_type=authorization_code&client_id=CLIENT_ID&client_secret=CLIENT_SECRET&code=CODE&redirect_uri=https://www.zoho.com"
$r = Invoke-RestMethod -Method Post -Uri "https://accounts.zoho.in/oauth/v2/token" -Body $body -ContentType "application/x-www-form-urlencoded"
$r | ConvertTo-Json
```

6. From the JSON response, copy the **refresh_token** value — save it somewhere safe

You now have 3 values: `client_id`, `client_secret`, `refresh_token`

---

## STEP 2 — Push this folder to a private GitHub repo (5 min)

1. Go to https://github.com → **New repository**
   - Name: `nurture-dashboard`
   - **Private** ✓
   - Click **Create repository**
2. Download GitHub Desktop: https://desktop.github.com
3. Open GitHub Desktop → **File** → **Add Local Repository** → point to this `deploy` folder
4. Click **Publish repository** → keep **Private** → **Publish**

---

## STEP 3 — Create a Cloudflare Pages project + API token (10 min)

1. Go to https://dash.cloudflare.com → sign up / log in (free)
2. **Workers & Pages** → **Create application** → **Pages** → **Direct Upload**
   - Project name: `nurture-dashboard` (must match `projectName` in the workflow file)
   - Upload the `index.html` once manually just to create the project (any deploy works — GitHub Actions will overwrite it daily after this)
3. Get your **Account ID**: right sidebar of any page in the Cloudflare dashboard, or **Workers & Pages** overview page
4. Create an **API Token**: go to https://dash.cloudflare.com/profile/api-tokens → **Create Token** → use the **"Edit Cloudflare Workers"** template (it includes Pages edit permission) → **Continue to summary** → **Create Token** → copy it (shown once!)

You now have 2 values: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`

---

## STEP 4 — Add all 5 secrets to GitHub (5 min)

In your GitHub repo → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**

Add these 5 (exact names, no spaces):

| Secret name | Value |
|---|---|
| `ZOHO_CLIENT_ID` | from Step 1 |
| `ZOHO_CLIENT_SECRET` | from Step 1 |
| `ZOHO_REFRESH_TOKEN` | from Step 1 |
| `CLOUDFLARE_API_TOKEN` | from Step 3 |
| `CLOUDFLARE_ACCOUNT_ID` | from Step 3 |

---

## STEP 5 — Trigger the first run

Go to your repo → **Actions** tab → **Daily Nurture Dashboard Refresh** →
**Run workflow** → **Run workflow** (this is the manual-trigger button; after
this it also runs automatically every day at ~8:07 AM IST).

Wait ~1 minute, then check the **Workers & Pages** dashboard in Cloudflare for
your live URL, e.g. `https://nurture-dashboard.pages.dev`.

Share that URL with anyone — no password, no login needed.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| Action fails at "Pull fresh data" step | Check the 3 Zoho secrets are correct; refresh_token may have expired — redo Step 1 |
| Action fails at "Deploy to Cloudflare Pages" step | Check `CLOUDFLARE_API_TOKEN` has Pages edit permission and `CLOUDFLARE_ACCOUNT_ID` is correct |
| Dashboard shows old data | Check the Actions tab — did today's run succeed? Click into it to see the log |
| Want to force an immediate refresh | Actions tab → **Run workflow** button (works anytime, not just on schedule) |
