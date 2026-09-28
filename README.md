# Wishly — never miss a birthday again

A tiny, elegant web app for birthdays, anniversaries and events. Friends sign up with just a
**name + password** and get their own private space. Reminders arrive by email (EmailJS), dates can be
added to Google Calendar, and it installs to iPhone/Android home screens like an app.

| Piece | What it does |
|---|---|
| `index.html` | The app (dark by default, installable PWA) |
| `admin.html` → `/admin` | Admin dashboard: users, what they're adding, activity feed, remove users |
| `netlify/functions/api.mjs` | Accounts, per-user dates, admin API — stored in **Netlify Blobs** (auto-created, no DB setup) |
| `netlify/functions/reminders.mjs` | Runs every 30 min and emails each user their due reminders via EmailJS |
| `emailjs-template.html` | Paste into your EmailJS template |
| `icons/`, `manifest.webmanifest`, `sw.js` | Home-screen app icon + offline shell |
| `email-icons/` | PNG icons the email loads (Gmail blocks SVG) |

Birthdays email at **9 PM the evening before** (India time by default). Each date can also remind
1 week before, same day 8 AM, or 1 hour before (timed events).

## 1. EmailJS
Template `template_8o97oyb`:
- **Content → Edit Content → Code editor:** replace everything with `emailjs-template.html`
- **Subject:** `{{subject}}`
- **To Email:** `{{to_email}}`
- **From Name:** `Wishly`
- **Reply To:** leave empty

Then **Account → Security** → enable **"Allow EmailJS API for non-browser applications"**, and copy the
**Public Key** and **Private Key** from **Account → General**.

Free plan = 200 emails/month shared by all users (one email per reminder).

## 2. Deploy to Netlify (new site from this GitHub repo)
Netlify → **Add new site → Import an existing project → GitHub → `dates`**.
Build command: *(empty)* · Publish directory: `.` · Functions directory is read from `netlify.toml`.

## 3. Environment variables (Site configuration → Environment variables)
| Variable | Value |
|---|---|
| `ADMIN_PASSWORD` | Password for `/admin` (also signs login sessions) |
| `EMAILJS_PUBLIC_KEY` | From EmailJS |
| `EMAILJS_PRIVATE_KEY` | From EmailJS |
| `SESSION_SECRET` | optional — a long random string; if set, changing `ADMIN_PASSWORD` won't log everyone out |
| `EMAILJS_SERVICE_ID` / `EMAILJS_TEMPLATE_ID` | optional, default `service_ls3809j` / `template_8o97oyb` |
| `REMINDER_TZ` | optional, default `Asia/Kolkata` |

Redeploy after adding them.

## Using it
- Everyone opens the site → **Create account** (name + password) → **Settings → Email reminders** to add their email.
- **Admin:** open `https://<your-site>.netlify.app/admin` and enter `ADMIN_PASSWORD`.
- **Phone app:** iPhone Safari → Share → *Add to Home Screen*. Android Chrome → ⋮ → *Install app*.
