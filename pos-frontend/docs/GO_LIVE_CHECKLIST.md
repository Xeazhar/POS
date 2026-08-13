# CalePOS — Go-live checklist

What you need to finish before taking **live money**. Keep this updated when
deploy requirements change.

**Product stage:** pre-1.0 (`0.x`). Do **not** cut `1.0.0` until you trust the
system for real sales. The “In development / Not for live sales” banner is
intentional.

**Legal note:** BIR / NPC / business-registration items are operational reminders.
Confirm final requirements with your accountant, BIR contact, and counsel — the
app alone does not complete government accreditation or registration.

---

## 1. Business & government (outside the app)

- [ ] **DTI / SEC / CDA** — business name registered for the entity that will own the stores
- [ ] **BIR registration** — TIN, books of accounts, authority to print / invoices as required for your setup
- [ ] **Mayor’s / business permit (LGU)** for each branch that will trade
- [ ] **BIR POS / PTU accreditation** — CalePOS has BIR-*oriented* controls (OR sequence, immutable sales, voids, X/Z). That is **not** the same as formal accredited POS software approval. Ask your BIR contact or tax adviser what your branch needs before using ORs for live sales
- [ ] **NPC / Data Privacy Act** — Privacy Policy in the app is **disclosure only**. Check whether the **store (Merchant)** must register with the NPC and/or appoint a DPO because you process staff data and SC/PWD ID numbers. **Policy ≠ registration**

---

## 2. Product / legal (your software)

- [ ] Keep **Terms** + **Privacy** at `/legal/terms` and `/legal/privacy` (contact: `jazpera.bustria@gmail.com` — see `src/legal/meta.js`)
- [ ] Optional: have counsel skim them before live money
- [ ] Stay on **0.x** until you trust it for cash — do **not** cut **1.0.0** just to “look live”

---

## 3. Infrastructure (hosting & database)

- [ ] Restore / use a dedicated **Production** Supabase project — do **not** use Demo as the live fiscal DB
- [ ] Prefer a **staging** project that mirrors production for testing migrations
- [ ] Apply **all** migrations in order (`supabase/README.md`) on staging, then production
- [ ] Run `supabase/audit_security.sql` on production — fix any CRITICAL rows
- [ ] Turn on **Realtime Authorization** in Supabase Dashboard (private Broadcast)
- [ ] Auth → **Turnstile** secret on each Supabase project; Cloudflare env → matching `VITE_TURNSTILE_SITEKEY`
- [ ] Auth → enable **leaked password protection**
- [ ] API **CORS**: only your real Cloudflare hostname(s), not `*`
- [ ] Cloudflare env for production:
  - [ ] `VITE_SUPABASE_URL`
  - [ ] `VITE_SUPABASE_PUBLISHABLE_KEY` (anon only — **never** service role)
  - [ ] `VITE_APP_ENV=production`
  - [ ] `VITE_TURNSTILE_SITEKEY`
  - [ ] **Do not** set `VITE_ALLOW_DEMO`
- [ ] Deploy build (`npm run build` / Wrangler) and confirm login **environment badge is gone** (env is really production)
- [ ] Revoke broad `anon` / `PUBLIC` EXECUTE on sensitive RPCs when you harden grants (still open from the earlier audit)

---

## 4. Clean go-live data

- [ ] Only when you are ready to throw away test sales: run `wipe_for_deployment.sql` **once** on the **real** DB (keeps master, resets OR to `…00000001`)
- [ ] Never wipe casually; never wipe Demo if you still need that data for testing

---

## 5. Store setup inside CalePOS

- [ ] **Settings → Business Information** — legal name, TIN, address
- [ ] Each **branch** — name, address, TIN branch code, OR prefix, MIN / serial / permit fields used on receipts
- [ ] Receipt footers (thanks / contact / official lines)
- [ ] **Idle lock** 5 / 10 / 15 minutes
- [ ] Create **real staff** (cashier / supervisor / manager) — new PINs, not leftover demo users
- [ ] Module permissions per role
- [ ] Catalog / inventory for each branch (adopt from network catalog if you use it)
- [ ] Cash drawers / till device settings (scanner / printer / drawer flags)
- [ ] Devices heartbeat visible for managers

---

## 6. Hardware & till habits

- [ ] Stable till PC/tablet, HTTPS install (PWA)
- [ ] Receipt printer + cash drawer tested
- [ ] Staff trained: **do not clear browser data** while sales are queued offline
- [ ] Know how to use **Sync Status** / blocked-queue Retry (`SYNC09`)

---

## 7. Smoke test (before first live peso)

- [ ] Cashier PIN login + manager email login (with Turnstile)
- [ ] Sale → stock drops → OR prints with correct TIN / name
- [ ] Offline sale → reconnect → syncs
- [ ] End shift + day-end dual control
- [ ] SC/PWD with ID note + register/report
- [ ] Void / refund (and remote refund if you use it)
- [ ] Idle lock → unlock
- [ ] Reprint receipt from history

---

## 8. Ongoing ops after open

- [ ] Daily day-end / Z discipline
- [ ] Supabase backups (and Manager fiscal backup if you use it)
- [ ] Support path: staff quote on-screen error codes
- [ ] Version deploys: tills refresh to new build; **never wipe IndexedDB mid-queue**

---

## Suggested priority order

1. Business + BIR clarity (can you legally issue ORs with this stack?)
2. Production DB restored + migrations + Turnstile + CORS + no demo mode
3. Company/branch fiscal identity filled in
4. Wipe-for-deployment only when ready, then real staff + catalog
5. Full smoke test on a real till
6. Privacy / NPC check for the store
7. Cut `1.0.0` only when you trust it for money

---

## Related files

| Topic | Where |
|-------|--------|
| Migration apply order | `supabase/README.md` |
| Security audit SQL | `supabase/audit_security.sql` |
| Go-live wipe | `supabase/wipe_for_deployment.sql` |
| Env template | `.env.example` |
| Terms / Privacy copy | `src/legal/` |
| Architecture map | `docs/CODEMAP.md` |
| Root publish notes | repo `README.md` → Publish checklist |
