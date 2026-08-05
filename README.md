# CalePOS

Offline-first, multi-branch point of sale for retail and meat counters (₱).

**Author & copyright holder:** Jazper Bustria  
**License:** Proprietary — see [`LICENSE`](./LICENSE). All rights reserved.  
**Unauthorized copying, redistribution, or reuse is prohibited.**

---

## What’s included

| Area | Details |
|------|---------|
| Cashier | POS sales, inventory, transactions, day-end till lock, device settings |
| Manager | Branch overview, staff, catalog import/pricing, reports |
| Offline | IndexedDB (Dexie) + sync queue; works without network and syncs when online |
| PWA | Installable app shell (`vite-plugin-pwa`) |
| Backend | Supabase (Auth + Postgres + RLS) |

The runnable app lives in [`pos-frontend/`](./pos-frontend/).

---

## BIR / fiscal readiness (Philippines)

CalePOS includes operational controls commonly requested for POS review. **This is not a substitute for formal BIR POS accreditation** (PTU / accredited software process).

| Requirement | Status in CalePOS |
|-------------|-------------------|
| Sequential invoice / OR numbering | Server-allocated `OR-########` per branch (`allocate_or_number`) |
| Non-editable sales records | DB triggers lock financial fields; line items immutable; void-only updates |
| Void / refund logs | `sale_events` + void metadata (`voided_at`, `voided_by`, reason); stock restock on secure void |
| User login & audit trail | `audit_events` on login/logout + void; reportable in Manager → Reports |
| Daily sales reports | Z / X / BIR summary from live OR range + totals; day-end cash close |
| Data backup | Manager → **Fiscal Data Backup** JSON export; rely on Supabase project backups too |
| Receipt / invoice printing | Browser print with TIN, OR, business name, MIN, SN — thermal printer hook ready |

**Required SQL migration:** run `pos-frontend/supabase/migrate_bir_pos_compliance.sql` in Supabase.

Fill branch **TIN**, permit, MIN, and serial under Branches / Branch settings so receipts print correctly.

---

## Quick start (local)

```bash
cd pos-frontend
npm install
cp .env.example .env.local
# Edit .env.local with your Supabase URL + publishable (anon) key
npm run dev
```

Without Supabase env vars, **local `npm run dev` only** can use offline demo mode. Production builds refuse open demo login unless `VITE_ALLOW_DEMO=true` (do not enable that on a live store).

---

## Publish checklist

### 1. Database

In the Supabase SQL editor, apply in order (if not already applied):

1. `pos-frontend/supabase/schema.sql` (base schema + RLS)
2. Any `pos-frontend/supabase/migrate_*.sql` files you have not run yet  
   (day-end till lock, branch open hour, price change history, products per branch, etc.)

Confirm **Row Level Security** is enabled on all app tables. Never put the **service role** key in the frontend or in Cloudflare Pages env vars for this app — only the **publishable/anon** key.

### 2. Environment (Cloudflare Pages)

Set in **Cloudflare Pages → Settings → Environment variables**:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_PUBLISHABLE_KEY`

Optional: `VITE_APP_VERSION=1.0.0`

**Login captcha (recommended for production):**

- Set `VITE_TURNSTILE_SITEKEY` (public sitekey) in Cloudflare Pages env
- Or ship `public/captcha.json` as a fallback
- In Supabase → **Authentication** → **Bot and Abuse Protection** → enable CAPTCHA → choose **Turnstile** → paste the **Secret** key
- The login form passes `captchaToken` into `signInWithPassword` (required when Auth CAPTCHA is on)
- In Cloudflare Turnstile dashboard, allowlist your production hostname

Do **not** set `VITE_ALLOW_DEMO` in production.

### 3. Deploy (Cloudflare Pages)

- **Root directory:** `pos-frontend`
- **Build command:** `npm run build`
- **Build output directory:** `dist`
- SPA routing: `public/_redirects` (`/* /index.html 200`)
- Security/cache headers: `public/_headers`

Connect your Git repo in Cloudflare Pages, or upload `dist` after a local build.

### 4. Auth & staff

- Create staff users in Supabase Auth.
- Link each user in the `staff` table (role + branch).
- Managers/admins use manager routes; cashiers use POS routes (enforced in the app).

### 5. PWA install

After deploy (HTTPS), users can **Install** from Chrome/Edge, or Add to Home Screen on mobile. Install prompts do not appear on plain `vite` dev (PWA is production/preview only).

### 6. Smoke test before go-live

- [ ] Login as cashier and manager
- [ ] Sale + inventory decrement
- [ ] Offline sale → reconnect → sync
- [ ] Day-end closes till; manager reopen works
- [ ] Import / price edit (manager)
- [ ] No secrets in the client bundle beyond the publishable key

---

## Security notes

- Client uses only the **publishable** Supabase key; access control depends on **RLS policies** in Postgres.
- Manager vs staff routes are gated in the UI; keep RLS aligned so cashiers cannot escalate via the API.
- `.env` / `.env.local` are gitignored. Use `.env.example` as the template.
- Demo mode is blocked in production builds without explicit opt-in.
- Hosting sends basic security headers (frame deny, nosniff, HSTS, referrer policy).

---

## Scripts

```bash
cd pos-frontend
npm run dev       # local development
npm run build     # production bundle
npm run preview   # test production build + PWA locally
npm run lint      # ESLint
```

---

## Credits

Designed and developed by **Jazper Bustria**.

© 2026 Jazper Bustria. All rights reserved.  
This software is proprietary. See [`LICENSE`](./LICENSE) for terms. You may not copy, steal, borrow, fork for republication, or redistribute this project without written permission from the author.
