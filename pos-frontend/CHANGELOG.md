# Changelog

Versions shown in the app's sidebar (`vX.Y.Z`). Source of truth is `package.json` —
bump it there and nowhere else; the UI, the bundle, and `audit_events.app_version`
all read from it.

**Currently pre-1.0: still in testing, not deployed for live trading.** While the version
starts with `0.`, the app shows an "In development / Not for live sales" marker on the login
screen and in the sidebar. Both disappear automatically at `1.0.0` — they key off the
version number, not a flag anyone has to remember to switch off. Cut `1.0.0` only when the
system is genuinely trusted to take real money.

**MAJOR** — staff need retraining, or fiscal output changes (receipt format, tax
computation, OR numbering).
**MINOR** — new capability, existing behaviour unchanged.
**PATCH** — bug fix, copy, styling.

---

## 0.2.1 — 2026-08-08

### Changed

- **Pages no longer blank out when you change a filter.** Switching the period on the
  manager Overview or a Branch dashboard used to replace the whole screen with grey
  loading boxes even though the previous numbers were still on screen. The figures now
  stay put and a small "Updating…" marks them as refreshing.
- **Faster page loads.** The spreadsheet library (~410KB — the largest single download in
  the app) no longer loads with Manager Data, Reports, or Inventory. It is fetched only
  when you actually pick a file to import or export one.
- **Recent receipts is tidier.** Discount and VAT-exempt markers were stacking under the
  receipt number and making every discounted row three lines tall. They are now small
  inline tags, and the status chip is sized to its text instead of floating in an
  oversized pill. Full detail is still one click away in the receipt.

---

## 0.2.0 — 2026-08-08

### Fixed — critical

- **Sync queue could stall permanently.** One op that could never be pushed blocked every
  sale queued behind it from ever reaching the server, silently, while the branch kept
  selling. Failing ops are now quarantined after 5 attempts, the queue drains past them,
  and a non-dismissible banner reports it (support code `SYNC09`).
- **Duplicate sales were possible** when two syncs of the same queued sale overlapped —
  doubled revenue, two OR numbers, doubled stock decrement. Now prevented by a database
  constraint (`migrate_sale_dedupe_hardening.sql`).
- **Products past the 1000th were invisible to POS.** Reads were silently truncated, so
  affected items couldn't be sold correctly and PWD/Senior refused them even when marked
  discountable. All product/catalog reads now page.
- **"Discountable" didn't reach the till** for imported and supervisor-created products.
  Fixed, plus a migration that heals existing rows.

### Fixed — security

- Offline lock-screen password verifier hardened (PBKDF2, 210k iterations, per-device
  salt) and failed attempts now throttle with a backoff that survives a reload.

### Added

- **BIR VAT and SC/PWD engine (RA 9994 / RA 10754).** One discount computed on a
  VAT-exclusive base; promos lower that base rather than stacking. **Changes what
  customers pay**: a ₱112 item with a 10% promo plus PWD is now ₱72.00 — the previous
  behaviour overcharged. Checkout shows a full per-line breakdown and BIR totals.
- **Multiple concurrent promos** per branch, best discount per line, never stacked.
  Auto-expiry on the end date, editable name and schedule, multi-select product picker.
- **Live updates** — manager price/promo/discount edits reach an open POS immediately.
- **Update banner** when a new version is deployed under an open tab.
- **Version display** in the sidebar.

### Changed

- Checkout is now two columns; long breakdowns no longer scroll under the buttons.
- Promo date fields were showing and saving times 8 hours off (UTC vs local).

---

## 0.1.0

First working build.
