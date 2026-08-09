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

## 0.7.0 — 2026-08-09

**Cashiers need telling about one change: signing out no longer asks about your shift.**
Everything else here is layout, clearer labels, and a new history screen.

### Signing out is now just signing out

The "Leaving the till?" question is gone. Sign out signs you out — nothing else.

Your shift stays open regardless. It already survived a sign-out, a closed tab, a refresh
and a flat battery; signing back in on the same till picks up where you left off and does
not ask you to count the change fund again. So the question only ever had one safe answer,
and being asked it every single time taught people to tap through a box that occasionally
offered to close their shift by mistake.

**A shift now ends in exactly two ways:** you end it yourself from **End shift**, or the
day-end / Z-reading closes the business day.

The separate **Cash out** button in the sidebar is also gone — **End shift** is the one
place a drawer gets counted and closed, and it shows your float, expected cash and variance
while you do it.

### Change fund by shift is readable now

The old line — `Sup — main · open now — ₱0.00 ₱0.00` — made a supervisor decode a name, a
drawer, a state and two unlabelled amounts out of one string. It is a proper table now:
**Cashier · Drawer/terminal · Shift status · Opening float · Closing cash · Variance**.

A shift that ended **without the drawer being counted** now shows **Pending handoff** in
amber instead of looking exactly like a clean close. That is the row worth chasing. Open
shifts show a dash for variance rather than ₱0.00, which read as "balanced".

### Promo history tells you *why* a promo ended

Three statuses, never mixed up:

- **Active** — selling now
- **Stopped** — a manager ended it early
- **Expired** — it ran to its own end date

Previously both endings were recorded as "stopped", so "we pulled that promo" and "that
promo finished normally" were indistinguishable in the history. Existing promos are
relabelled automatically where it can be worked out safely.

### New: Inventory → Movement history

A second tab on Inventory showing every stock movement in order: what product, how much,
what kind (restock, sale, adjustment, waste/shrinkage, price change), **who did it**, and
when. Filter by product, by movement type, by date range, with Today / This week / This
month shortcuts.

### Staff page is now two tabs

**Staff** (everyone at the branch) and **Shifts** (the shift log), with one shared branch
and date filter across both.

**Supervisors could previously only see themselves in the staff list.** They now see their
whole branch. They still cannot see anyone's PIN, and still cannot create or edit accounts.

### Also

- New **Refunded today** card on the branch dashboard. The old figure was **wrong** — it
  ignored fully voided sales, so the more completely a sale was refunded, the less it
  counted. Fixed.
- Supervisor catalog: the search box sits on the filter row with the other filters.
- The login screen no longer claims "Connected to Supabase" when it has not checked. It now
  says nothing when things are fine, and warns you when the terminal is genuinely offline
  (PIN sign-in still works then).
- Search boxes across the app line up with the dropdowns next to them.

### For whoever applies the database changes

Run in the Supabase SQL editor **before deploying**. All are safe to re-run.

1. `migrate_branch_staff_roster.sql` — lets supervisors see their branch's roster **without
   exposing PINs**. (The staff table stores PINs in plaintext, so this is a narrow
   read-only function, not a widened table permission. Do not "simplify" it into an RLS
   policy change.)
2. `migrate_promo_expired_status.sql` — adds the `expired` status and relabels history.

### Environment separation — action required

**Local development and the live site have been sharing one database**, which means test
data has been landing in real fiscal records. Production sales are immutable and OR numbers
are sequential, so a test sale from a laptop consumes a real OR number permanently.

Create a second Supabase project for development and point `.env.local` at it; leave the
deployed app's hosting variables on the production project. Full instructions in
`pos-frontend/README.md` → *Environments*.

Any build not marked as production now shows a permanent badge (e.g.
`DEVELOPMENT · calepos-dev`) on the login screen and in the top bar, naming the actual
database it is writing to. An unset setting counts as development, never production.

---

## 0.6.0 — 2026-08-09

**Staff need a briefing before this goes on the floor.** Day end is now two different
screens, Shifts and Staff are one tab, petty cash has an extra step, and the TIN printed on
receipts changes. Nothing here is a small tweak.

### ⚠️ What prints on a receipt has changed

**Every sale rung up on the POS has been printing `TIN: —`.** Not the wrong TIN — a blank
one, along with a blank BIR permit number, blank machine ID and blank serial number. The
receipt printed at the counter was built without the branch's registered details. Reprints
from the Transactions screen were correct; only the receipt handed to the customer at the
time of sale was affected. Every receipt printed from now on carries the full details.

**One company TIN, one branch code per branch.** Before, each branch held its own free-text
TIN and they could quietly drift apart. Now the business has a single TIN, set once under
**Manager → Branches → Company details**, and each branch has a BIR branch code
(`00000` for head office, `00001` for the first branch, and so on). The receipt prints them
joined: `123-456-789-00001`. **Set the company TIN before trading**, or receipts fall back
to whatever that branch's old TIN field held.

### Day end is now two screens

**Cashiers see "End shift".** Their own opening float, their own expected cash, their own
count and their own variance — nothing else. No other cashier's drawer, no branch sales
totals, no restock list, and no "Submit for closing".

**Supervisors and above keep "Day end".** Branch sales, every shift's accountability side
by side, the restock list, the petty cash approval queue, and "Submit for closing".

**A cashier could previously see other staff members' change fund amounts**, including a
supervisor's, on the shared Day end screen. They can't any more.

### Petty cash now has three steps, not two

1. **Request** — any cashier. No money has moved.
2. **Approve** — supervisor or above. Still no money has moved.
3. **Handed over** — whoever is on the floor, including the cashier who asked, presses
   "Mark handed over" when the cash physically leaves the drawer.

**This changes the expected drawer figure.** Previously "approved" was treated as "paid",
so cash still sitting in the till was deducted and the drawer read short until someone
actually took the money. Now only cash marked as handed over is deducted. If a request is
approved but not yet handed over, Day end says so and leaves the money in the drawer.

A request can never be marked as handed over unless it has an approval recorded against it.

### Shifts and Staff are one tab

The **Staff** tab now lists each person once with their role, hours worked, shift count and
net variance for the chosen date range. Open a person's row to see their individual shifts —
drawer, float in, counted, expected, variance, and any corrections. Supervisors see their
own branch's roster and drawer detail; creating accounts, changing roles and revealing PINs
stay manager-only, exactly as before.

### Approvals now record who approved them

Voids, refunds, price overrides, cart-line removals and second-drawer overrides all record
the **name and role** of the supervisor or manager who approved them — not just that an
approval happened. It shows on the transaction detail, in the refund history, on the manager's
Recent receipts list, and in the Void/Refund Log report.

### Fixes

- **"Already signed in on another device" when you aren't.** If a device is switched off,
  loses power, or the browser is force-closed, the account stayed locked for up to 15 minutes
  with no way to clear it. A master account can now open **Staff → Signed-in devices** and
  sign out one person or everyone. Sessions no device is really holding are marked "Expired"
  so you can tell them from a live till.
- **Creating a staff login failed with a captcha error.** It now shows the same security
  check the login screen uses.
- **Refunded receipts read as if the refund was about to come off twice.** A refunded sale
  now shows the original total and the refunded amount as two clearly labelled figures.
- **"Partial"** is now **"Partial Refund"** everywhere.
- **A day-end closing can no longer be reopened once a new business day has started.** The
  current day can still be reopened by a manager; passed days are permanently locked. No
  role can override this.
- The search bar on the catalog (and everywhere else) was rendering at an unreadably small
  size. Fixed.
- Tables with edit/void/refund buttons now have an **Action** column heading.

### Also

- **Inventory**: managers and masters can pick which branch's stock to view. Other branches
  are view-only — change stock and prices from that branch's own Inventory page.
- **Branch view**: new Staff table showing who worked there and their clock-in/out hours
  over the last 30 days.
- **Catalog bulk edit** now covers name, SKU, barcode and category as well as price and
  discountable, in one cleaner editor. Row actions moved into a **⋯** menu, and the sync
  button moved next to the other catalog tools and now says what it does.
- **Lock** and **Refresh** moved to the top bar, where they are reachable on any screen size.

### For whoever applies the database changes

Run these in the Supabase SQL editor, in this order, **before deploying**:

1. `migrate_company_tin.sql` — company TIN + per-branch BIR branch code.
2. `migrate_petty_cash_fulfilment.sql` — the `fulfilled` state. **This one also rewrites
   `close_staff_shift()` and `shift_cash_summary()`.** Without it, every cash-out after
   deploy reports a false variance.
3. `migrate_admin_session_release.sql` — master force sign-out.

All three are safe to re-run. Until they are applied the app falls back to the old
behaviour rather than failing.

---

## 0.5.0 — 2026-08-09

**The change fund is now counted once per shift, not once per sign-in.** If a cashier signs
out by accident and signs back in, the app no longer asks them to count the drawer again.

### What staff need to know

**Signing out and ending a shift are now two different things.**

- **Sign out, keep shift open** — for a break, or an accidental sign-out. The change fund,
  the sales and the drawer stay on the same shift. Signing back in on the same till carries
  straight on. Nothing is counted again.
- **Cash out & end shift** — the actual handover. Count everything in the drawer, enter it,
  and the shift closes. Only then is the next cashier asked to count in.

There is a new **Cash out** button in the sidebar so a handover does not require signing out
first.

**Each cashier now counts their own change fund.** Two cashiers working the same till on the
same day get their own starting count, their own sales and their own variance. A shortage is
now attributable to the shift it happened on instead of being averaged over the whole day.

**One cashier per drawer at a time.** If the previous cashier has not cashed out, the next
one is stopped with their name on screen. A supervisor can count that drawer and close their
shift to release it — that count is recorded against the person who left, not the one
arriving.

**Handover pre-fills, it does not auto-accept.** When the previous shift cashed out with
₱4,500, the new cashier sees ₱4,500 already filled in and a tick box saying they counted it.
Typing a different figure is allowed and is flagged on screen — their count is what counts.

**Moving to a different drawer is blocked, not silently allowed.** A cashier still open on
another drawer is told so, because the cash they are answerable for is over there. A
supervisor can override if they really are working two tills.

**If your branch has one cash box, nothing here needs setting up** — every device already
counts as the same drawer, which is what makes the rule above work across a phone and a
counter PC. Only a till with its own separate cash box needs its own name, under
**Settings → Devices → This terminal's drawer**.

### For supervisors and managers

- **Shifts** (was "Staff shifts") now shows change fund in, cash counted, expected and
  variance for every shift, with cash sales / refunds / paid-outs / pickups when you open a
  row. Short and over counts are totalled at the top.
- **Closed shift figures cannot be edited.** Correcting one records an adjustment — old
  value, new value, your name and a written reason — and the original stays readable. Same
  principle as sales records, for the same BIR reason.
- **Day end** now lists the change fund per shift instead of one figure for the day, and cash
  pickups and petty cash are charged to whichever shift holds the drawer.

### Database — apply before deploying

Run `supabase/migrate_shift_cash_accountability.sql` in the Supabase SQL editor.

**Apply it outside trading hours if you can.** It requires one open shift per till, and the
old system allowed several — so anyone still clocked in, other than the most recently
started person at each branch, is clocked out by the migration with a note explaining why.
Have staff cash out normally first and this does nothing.

### Fixed

- **The Transactions table headers did not line up with the columns underneath them.** The
  header row was not laid out as a grid at all, so the labels ran together and sat over the
  wrong data. Headers and rows now share one column definition, and the Promo column — which
  had the widest column in the table for a short name — has been narrowed so Total and
  Status are no longer squeezed at the right edge.

---

## 0.4.1 — 2026-08-09

Follow-up fixes to 0.4.0.

### URGENT — if you applied `migrate_role_assignment_ceiling.sql`, re-run it now

**The version in 0.4.0 stopped cashiers and supervisors signing in**, with the error
"a cashier cannot assign the cashier role". Signing in updates your own staff record (it
stamps a session heartbeat), and the check wrongly treated that as an attempt to give
yourself your own role.

If tills are locked out and you cannot run the migration immediately, this restores sign-in
straight away:

```sql
drop trigger if exists staff_role_ceiling on public.staff;
```

Then apply the corrected `migrate_role_assignment_ceiling.sql` when you can. **After
running it, sign in as a cashier before you walk away** — the file now says so at the end,
and the check itself now ignores any change that does not touch role, access, branch or
active status, so a normal login cannot trip it again.

Two further corrections in the same file:

- **It blocked ordinary self-edits.** Changing your own display name was rejected for the
  same reason. Only role, access, branch and active status are protected now.
- **It let a deactivated account through.** Someone switched off but still holding an open
  browser session skipped the checks until their session expired — the very case the
  control exists for. Those are now refused.

### Fixed

- **Void / Refund Log and Login & Audit Trail only ever showed the most recent 500
  entries**, no matter what date range you picked, with nothing saying so. They now cover
  the whole range. **Re-run either report if you used it to investigate something.**
- **The Inventory and Price Listing reports stopped at 1000 products.** A branch with more
  than that was missing items from the price list and had valuation totals — including the
  new negative-stock count — calculated from an incomplete set.
- **The "Today" figure on the manager dashboard could include part of yesterday.** The
  day boundary was computed in UTC rather than local time, so before 8am it started on the
  wrong day. The headline Revenue and Orders figures were also capped at 1000 sales per
  branch and now read everything.
- The Revenue figure and the new up/down percentage beside it were coming from two
  different calculations, so the arrow could describe a slightly different number than the
  one shown. Both now come from the same source.
- The Senior Citizen / PWD Register was **listing voided sales**, and counting them in the
  "no ID number recorded" warning. Voided sales never happened, so including them in the
  register risked claiming a deduction for a cancelled sale. The register is now completed
  sales only, and carries a TOTAL row.
- **"Re-sync discountable to branches" could change items it should not have.** It matched
  branch products by SKU when they had no catalog link, so an item a branch had
  deliberately marked not discountable could be switched on by a coincidental SKU match —
  changing what a customer pays. It now only touches products genuinely linked to the
  catalog, and tells you how many were left alone.
- Six error codes staff could see on screen (`IMP01`, `IMP02`, `PETTY01`, `PETTY02`,
  `PRICE01`, `SHIFT01`) had no entry in the support guide. They do now, and the check that
  was supposed to catch this has been fixed — it was only looking for codes it already knew
  about.
- **A failed petty-cash, import or price-override could show the "the customer may be
  charged twice" warning** even though no sale was involved. That warning now only appears
  for failures that genuinely touched a sale.
- Import now refuses oversized or wrong-type files with a message instead of freezing the
  till while it tries to read them.

### Changed

- **Transactions list now has its own Promo and Discount columns.** They used to be
  squeezed underneath the OR number, which crammed three unrelated things into one cell and
  cut off the promo name. A sale with no promo shows a dash, so you can tell "no promo"
  apart from "not loaded". On phones the columns collapse back under the OR number as
  before.
- The app no longer reloads itself on the login screen while someone is part-way through
  typing a PIN, and waits for the new version to finish downloading before switching to it.

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
