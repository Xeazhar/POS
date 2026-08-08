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

## 0.4.0 — 2026-08-08

### You must run two database updates for this release

Apply both in the Supabase SQL editor, in this order:

1. **`migrate_harden_grants.sql`** — closes a hole where the PIN lockout could be switched
   off by whoever was guessing. Until this is applied, the "5 wrong PINs and you're locked
   out for 15 minutes" protection can be bypassed, which matters because supervisor
   approvals for voids and price changes sit behind that PIN.
2. **`migrate_role_assignment_ceiling.sql`** — see "Who can create staff" below.

### Who can create staff has changed — read this before your next shift

Previously anyone who could open Manager → Staff could create an account at **any** level,
including Master, and could edit **their own** account. That meant a manager login, if it
ever fell into the wrong hands, could quietly promote itself to full owner access, and
nothing in the records would show it had happened.

From this release:

- You can only create or assign roles **below your own**. A manager can create supervisors
  and cashiers, but not another manager. Only Master can create Master.
- **Nobody can edit their own account** — not their role, module access, branch, or active
  status. Someone above you has to make that change. Your row shows "Your account" instead
  of an Edit button.
- Accounts at or above your level show "Locked".
- Every staff creation and change is now written to the audit trail, including what the
  role and access **were before** the change. Reveal PIN is also restricted to accounts you
  are allowed to edit.

This is enforced by the database, not just the screen, so it holds even if someone works
around the app.

### Cashiers now default to POS, Transactions and Day end only

A cashier's default access was POS, Transactions, Day end, **plus Dashboard, Inventory and
Devices**. That meant every cashier could see branch revenue and edit stock levels as a
matter of course — not because anyone decided to grant it, but because it was the default.

New cashiers now get **POS, Transactions and Day end**. Anyone who genuinely needs more is
given it per-person, and the Staff page tags that as "Elevated" so the exception stays
visible.

**Existing cashiers are not changed by this.** Anyone whose access was saved explicitly
keeps exactly what they have — but they will now show as **Elevated** on the Staff page,
because they hold more than the new default. That tag is telling you the truth. Open each
cashier, press **Reset**, and save if you want them on the new, narrower default.

### "Custom access" tag on staff was misleading — fixed

Setting a cashier to only the modules they actually use (say POS, Transactions and Day end)
was tagged **"Custom access"** in an amber warning colour, exactly the same as giving a
cashier something they shouldn't have. It looked like a problem when it wasn't.

Now there are three states, and only the last is a warning:

- **Role defaults** — matches the role.
- **Scoped · N fewer** — narrower than the role. Normal, shown in plain grey.
- **Elevated · +N** — has access **beyond** the role. Amber, because this is the one worth
  a second look.

Hover any of them to see exactly which modules differ. When editing someone, modules beyond
their role are highlighted as you tick them, and there is a **Reset to role defaults** link.

### New reports

Nine additions, mostly things accounting or BIR will actually ask for:

- **Senior Citizen / PWD Register** — the statutory record that substantiates the 20%
  discount as a tax deduction. **BIR will disallow the deduction for any sale with no ID
  number recorded**, so the report counts those for you and says how many. If that number
  isn't zero, staff are not capturing the ID at checkout.
- **Electronic Journal (EJ)** — the full chronological record of every transaction,
  **including voids**, which BIR can require on demand.
- **Discount Report (all types)** — every discount given, with promo and statutory
  discounts shown as separate columns.
- **Tender / Payment Summary** — what to reconcile the drawer and card settlements against.
- **Gross Margin (COGS)** — revenue less cost per product. A management report, not an
  audited one: it uses each product's *current* cost, not the cost on the day it sold.
- **Stock Movement Ledger** and **Price Change Register** — every stock and price change,
  with who made it.

**BIR Sales Summary now shows the full VAT breakdown** — VATable sales, VAT, VAT-exempt,
zero-rated and SC/PWD discount, each in its own column, plus a TOTAL row. A return needs
these stated separately; one combined "sales" figure cannot be split back apart afterwards.

### Price Listing is now an actual price list

It was showing stock on hand, unit **cost**, extended totals and a Low/OK status, because
it was quietly running the same query as the Inventory report. Two problems with that:

- It put your **cost and margin** on a document you might print for the shelf or hand to
  someone asking about prices.
- The total columns **went negative**, which is what you spotted. They were price ×
  quantity on hand, so any product sitting at negative stock produced a negative total.

Price Listing now shows product code, barcode, name, SKU, category, unit (per kg / per
piece), selling price and whether it is discountable. No stock, no cost — safe to print.

Negative stock has moved to where it belongs: the **Inventory** report now flags those rows
as **"NEGATIVE — recount"** and says how many there are, because it means the POS sold more
than the system thought existed, and the valuation totals below it are wrong until you
recount.

### Manager Overview dashboard

- **Revenue and Orders now show the change against the previous period** — up or down, with
  a percentage. The comparison always matches the period you picked: Day against yesterday,
  Week against the previous 7 days, and so on. A shop with no earlier data shows "New"
  rather than an invented percentage.
- **Payment methods is now a bar chart instead of a pie**, matching Top products and Top
  categories, with each method's share of the total. Bars are much easier to compare than
  pie slices. Methods you never take are no longer listed as permanent empty rows.
- **Revenue over time now has hover tooltips** — hover or tap any point for the full date,
  exact revenue, and **how many orders** made it up. ₱8,400 from 4 orders and ₱8,400 from 90
  are very different days.
- **"Revenue by branch" is hidden when you only have one branch** (it was a single bar
  repeating the number above it). The remaining panels widen to fill the space.
- "Menu items on today" is a restaurant feature and is no longer shown.

### Fixed

- **Reports covering a busy period were silently short.** Any report over more than about
  1000 sale lines stopped at that point and still printed a total, with no error and no
  sign anything was missing. Long date ranges now read every record. **If you filed
  anything from a wide date range, re-run it and check the figure.**
- **The manager dashboard had the same problem on the Year view** — revenue, the branch
  split and the payment mix all silently stopped after 1000 sales. Now reads everything.
- The BIR Sales Summary over a long range was fetching one day at a time; a full year now
  loads in one pass instead of hundreds.
- The promo status tag on the all-branches list was stretching across its whole column
  instead of sizing to its text.

### Error messages now tell you whether the money went through

When something fails at the till, the message says outright whether the sale was recorded —
"The sale was NOT recorded, ring it up again", "The sale IS saved on this device, do not
ring it up again", or "Check Transactions for the OR number BEFORE ringing it again". That
last one prevents the worst case: charging a customer twice for one basket.

There is also a new support guide at `docs/ERROR_CODES.md` covering all 46 codes — what
each one means, whether it is safe to retry, and the first thing to try. Read the code off
the screen, look it up there. Several codes staff could already see on screen (`CAT01`–
`CAT06`, `DEV05`) previously had no entry anywhere, so quoting them told support nothing.

### The app now keeps itself up to date

Terminals sitting on the **login screen** — overnight, or between shifts — never checked for
new versions, so a shop that left the browser open could start every morning on an old
build. They now check and update themselves while signed out, which is the safest possible
moment. When an update is found, the new version is downloaded **before** the reload, so a
terminal on unreliable shop wifi can't get stranded halfway.

### Changed

- **Bulk edit in the network catalog** is tidier: Discountable and Prices are now one
  grouped control instead of two loose buttons, and once you are in bulk mode the selected
  count is shown large and unmissable, with **Select all** (across everything matching your
  current filters, not just the visible page) and **Clear**.
- Consistent colours across every screen. All the greys, borders and status colours now
  come from one defined set rather than being written by hand per screen, so the app looks
  the same everywhere. No behaviour change.
- "Reset to role defaults" on the Staff form is now just **Reset**.

## 0.3.1 — 2026-08-08

### Fixed

- **"Discountable" showing Yes in the catalog but refused at the till, again.** The previous
  repair reconnected products to their catalog entries but never copied the setting itself
  down, so anything switched on before that fix stayed out of step. Run
  `migrate_sync_discount_eligible.sql` once to reconcile every item. There is now also a
  **Re-sync discountable to branches** button on Manager → Data so this never needs a
  database console again.

### Changed

- **Selection boxes only appear when you ask for them.** Manager → Data now has *Bulk edit:
  Discountable / Prices* beside the filters. Pick one and the tick-boxes appear; press Done
  and the table goes back to normal.
- **Bulk price editing.** Tick the products, press Edit prices, and set each one
  individually in a single table, then save. Only changed rows are written.
- More catalog filters: **Discountable** (all / only / not) and, for retail,
  **Barcode** (all / has / missing) for spotting items that cannot be scanned.

---

## 0.3.0 — 2026-08-08

### Added

- **Reports can now cover all records, not just a date range.** New Range buttons —
  Today, Last 7 days, This month, **All records** — sit above the From/To dates. "All
  records" runs from the branch's very first sale up to today, so you can export a
  complete history without knowing when trading started. Typing your own dates still
  works and switches the range back to Custom.
- X-Read and Z-Read deliberately refuse "All records": each is a reading for one trading
  period (a Z-Read *is* the end-of-day reset), so an all-time version would be a number
  nobody should file. Use a date range for those.

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
