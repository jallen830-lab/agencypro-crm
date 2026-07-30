# AgencyPro — Automated Daily KPI Report Setup

This adds an automatic daily KPI report (sent at 5 PM Central) to your existing
AgencyPro CRM on Netlify. One-time setup, ~30 minutes.

---

## What You'll Need

1. Your existing Netlify account (already have this)
2. A Firebase service account key (free, takes 5 minutes)
3. A Gmail App Password (free, takes 3 minutes)

---

## Step 1 — Get a Firebase Service Account Key

This lets the function read your Firestore data server-side.

1. Go to https://console.firebase.google.com
2. Click your **agencypro-crm** project
3. Click the ⚙️ gear icon → **Project Settings**
4. Click the **Service Accounts** tab
5. Click **Generate New Private Key** → **Generate Key**
6. A JSON file downloads — open it and find these three values:
   - `project_id`
   - `client_email`
   - `private_key` (a long string starting with `-----BEGIN RSA PRIVATE KEY-----`)

Keep this file safe — treat it like a password.

---

## Step 2 — Create a Gmail App Password

This lets the function send email from your Gmail without exposing your password.

1. Go to https://myaccount.google.com/security
2. Make sure **2-Step Verification** is ON (required for App Passwords)
3. Search for **App Passwords** in the search bar
4. Click **App Passwords**
5. Select **Mail** as the app, **Other** as the device → type "AgencyPro"
6. Click **Generate** — copy the 16-character password shown
7. Save it somewhere safe — you can only see it once

---

## Step 3 — Set Environment Variables in Netlify

1. Go to https://app.netlify.com → click your AgencyPro site
2. Click **Site Settings** → **Environment Variables**
3. Click **Add a variable** for each of these:

| Variable Name            | Value                                      |
|--------------------------|--------------------------------------------|
| `FIREBASE_PROJECT_ID`    | `agencypro-crm`                            |
| `FIREBASE_CLIENT_EMAIL`  | The `client_email` from your JSON file     |
| `FIREBASE_PRIVATE_KEY`   | The full `private_key` from your JSON file |
| `GMAIL_USER`             | `jallen1@farmersagent.com`                 |
| `GMAIL_APP_PASSWORD`     | The 16-character App Password from Step 2  |
| `REPORT_TO_EMAIL`        | `jallen1@farmersagent.com`                 |

> **Important for FIREBASE_PRIVATE_KEY:** Copy the entire key including the
> `-----BEGIN RSA PRIVATE KEY-----` and `-----END RSA PRIVATE KEY-----` lines.
> Paste it exactly as-is — Netlify will preserve the line breaks.

---

## Step 4 — Deploy the Project

Your project folder should look like this:

```
agencypro-netlify/
├── netlify.toml                          ← tells Netlify about the function
├── package.json                          ← dependencies
├── public/
│   └── index.html                        ← your existing CRM file
└── netlify/
    └── functions/
        └── daily-kpi-report.mjs          ← the report function
```

**Deploy options:**

### Option A — Drag & Drop (easiest)
1. Zip the entire `agencypro-netlify` folder
2. Go to app.netlify.com → your site → **Deploys** tab
3. Drag the zip file onto the deploy drop zone

### Option B — GitHub (recommended for ongoing updates)
1. Create a free GitHub account if you don't have one
2. Create a new repository called `agencypro-crm`
3. Upload all files from this folder to the repository
4. In Netlify → **Site Settings** → **Build & Deploy** → connect to your GitHub repo
5. Every time you update `index.html` and push to GitHub, Netlify auto-deploys

---

## Step 5 — Test It

After deploying:

1. Go to **Netlify dashboard** → your site → **Functions** tab
2. You should see `daily-kpi-report` listed
3. To send a test report immediately:
   - Click on `daily-kpi-report`
   - Click **Test function** (or wait until 5 PM Central for the first automatic send)

---

## Schedule

The report fires automatically at **5:00 PM Central Time** every day.

To change the time, edit `netlify.toml`:
```toml
[functions."daily-kpi-report"]
  schedule = "0 23 * * *"   # 23:00 UTC = 5 PM Central (6 PM CDT in summer)
```

Cron format: `minute hour day month weekday`

Common alternatives:
- `"0 22 * * *"` → 4 PM Central
- `"0 0 * * *"`  → 6 PM Central (midnight UTC)
- `"0 23 * * 1-5"` → 5 PM Central, weekdays only

---

## What the Report Contains

Every day at 5 PM you'll receive an email with:

- **Today at a Glance** — quotes entered, policies sold, premium written
- **Folio to Date** — same three metrics for the current folio period
- **Producer Breakdown** — side-by-side today vs folio for every producer
- **Quotes Entered Today** — every individual quote line (customer, line, producer)
- **Policies Sold Today** — every closed won policy (customer, line, premium, producer)

---

## Next Steps (Phase 2)

Once this is working, the same infrastructure supports:
- Automated follow-up email sequences (via SendGrid — $20/month)
- Automated text sequences (via Twilio — ~$15/month)
- X-date renewal reminders
- Welcome workflow automation

---

## Questions?

Contact: jallen1@farmersagent.com | (817) 345-0155
