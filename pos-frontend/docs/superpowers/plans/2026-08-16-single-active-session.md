# Single-Active-Session Policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A staff account can only be authenticated on one device at a time. Logging in on a new device evicts the previous session everywhere the server can reach it, and the old device can no longer perform authenticated writes — enforced in Postgres/RLS, not just in the UI.

**Architecture:** Reuse the existing (currently half-built) `staff.active_session_id` / `session_heartbeat_at` columns and `claim_staff_session` / `heartbeat_staff_session` / `release_staff_session` RPCs (`migrate_staff_active_session.sql`, `migrate_admin_session_release.sql`). Flip `claim_staff_session` from "reject the second login" to "evict the first," bind session identity to the tamper-proof `session_id` claim Supabase already puts on every JWT (instead of the current spoofable client-supplied uuid), and gate the three RLS choke-point functions (`current_staff_id`, `current_staff_branch`, `current_staff_role`) on that same claim so every RLS policy and every `SECURITY DEFINER` RPC in the schema stops trusting an evicted device automatically — no per-table changes needed. Client side: the existing 2.5-minute heartbeat becomes the enforcement backstop, a private Realtime Broadcast (already used for "something changed, refetch now") gives near-instant eviction, and the offline sync queue gets a pre-flight session check so a reconnecting device is turned away before any queued item is retried or quarantined.

**Tech Stack:** Supabase Postgres (SQL functions/RLS), supabase-js, React/Zustand (existing stores), Dexie/IndexedDB offline queue (existing).

**Spec:** User-provided requirements (see task description) — no separate spec doc; this plan's "Design & Constraints" section below is the spec of record.

## Global Constraints

- Single active session per staff account; a new login always wins, evicted device is denied.
- Enforcement must be server-side (RLS/RPC), not just frontend state — do not rely solely on localStorage/sessionStorage.
- Evicted device must show: "Your session has ended because this account was signed in on another device."
- Preserve auditability: record the replacement event (`audit_events`).
- Do not break offline POS — analyze and document what happens when the evicted device is offline at eviction time (see Design & Constraints).
- Reuse `staff.active_session_id`/`session_heartbeat_at` and the existing claim/heartbeat/release RPCs rather than inventing a parallel mechanism.
- No test framework in this repo — verification is `npm run lint`, `npm run build`, manual SQL queries (Supabase SQL editor), and manual two-browser exercise via `npm run dev`.
- Per `CLAUDE.md`: do not bump `package.json` version without the user's explicit go-ahead. This plan stops short of that; Task 9 flags it instead of doing it.

---

## Design & Constraints (read before implementing)

### Why the existing mechanism isn't enough today

`migrate_staff_active_session.sql` already has `staff.active_session_id`/`session_heartbeat_at` and a `claim_staff_session(p_staff_id, p_session_id)` RPC — but:

1. It **rejects** the second login ("Already signed in on another device. Sign out there first.") instead of evicting the first — the opposite of the requirement.
2. `p_staff_id`/`p_session_id` are **client-supplied** — nothing checks the caller's `auth.uid()` owns `p_staff_id`, so any authenticated caller could currently evict or lock out an arbitrary staff account. This is fixed as a side effect of this plan (session id derived server-side from the JWT, staff id derived from `auth.uid()`).
3. Nothing in RLS or any RPC ever reads `active_session_id`. Shell.jsx's periodic `heartbeatStaffSession()` call already exists but its failure is silently swallowed (`.catch(() => {})`) — so even today's "reject second login" claim has zero ongoing enforcement once a session is established. This is the core gap this plan closes.

### The enforcement mechanism

Every Supabase Auth JWT carries a `session_id` claim — a UUID naming the row in `auth.sessions`, stable across token refreshes and page reloads, but **different** for every new sign-in (confirmed via Supabase docs: "Every access token contains a `session_id` claim, a UUID, uniquely identifying the session of the user"). This is the correct source of truth for "which login is this," unlike the existing app-level `getOrCreateDeviceSessionId()` (a `localStorage` fingerprint that intentionally survives many different logins on the same browser — useful for the till/device-id used elsewhere, wrong for security).

`claim_staff_session()` (called only at a fresh, explicit sign-in) reads `staff.active_session_id`, and if it differs from the caller's own `session_id` claim, unconditionally overwrites it — evicting whoever held it — and records an `audit_events` row (`session_replaced`). `current_staff_id()`, `current_staff_branch()`, `current_staff_role()` — the three functions nearly every RLS policy and every `SECURITY DEFINER` RPC in the schema already goes through — are extended to return nothing unless the caller's live JWT `session_id` still matches `staff.active_session_id`. The instant Computer B claims the session, every subsequent request from Computer A's still-technically-valid access token resolves to "no staff row," which cascades through RLS as "no rows visible" and through RPCs as their existing "not authorized" guards. No per-table policy edits, no per-RPC signature changes.

This is deliberately **not** the same as just calling `supabase.auth.signOut({ scope: 'others' })` or the Supabase dashboard's Pro-only "Single session per user" toggle: those only revoke the *refresh* token, so the still-valid *access* token keeps working for up to its full lifetime (default 1h) until it tries to refresh. The RLS-level check here has no such gap — it's checked on every request, not just at refresh — and it works on any Supabase plan tier, and it produces our own auditable `audit_events` row, which the built-in toggle does not.

### What the evicted device can still do (and why that's fine)

`current_staff_id()`/`current_staff_branch()`/`current_staff_role()` are the gate for *authorization*, not for reading your own identity: the `staff` table's own "read staff" RLS policy (`auth_user_id = auth.uid() or is_manager()`) is deliberately **not** touched, because the very first read during a fresh sign-in (`fetchSessionStaff()`, called before `claim_staff_session()` has run) depends on it succeeding unconditionally for your own row — gating it would create a chicken-and-egg deadlock on every login. The residual effect: an evicted device can still `SELECT` its own bare staff row (name/role/branch), but every actual POS action — sales, voids, refunds, stock, shifts, promos, everything gated through `current_staff_branch()`/`is_manager()` — is denied. That satisfies "cannot perform authenticated POS actions."

### Offline analysis (explicitly required by the task)

**Scenario: Computer A is offline when Computer B logs in as the same user.**

- Computer B's login succeeds fully and unconditionally — `claim_staff_session()` doesn't check Computer A's reachability, it just overwrites the row. The audit event is recorded immediately, from Computer B's side.
- Computer A has no network path at all. **There is no way to server-enforce anything on a device with no connection** — nothing can be pushed to it, and its local Dexie writes (cart building, ringing a sale, opening a shift) never touch the server by design; that's the entire point of offline-first. This is a hard physical limit, not a gap in this design — any "instant kill switch while offline" is impossible without breaking the offline-first architecture. This is called out explicitly rather than glossed over.
- Computer A keeps working locally, exactly like any offline cashier — its queued sales are not blocked, corrupted, or lost by any of this.
- Enforcement happens at the **reconnect boundary**: `pushQueue()` (the function that drains the offline outbox) now does a `heartbeat_staff_session()` pre-flight check before touching any queued item. The moment Computer A regains connectivity and a sync is attempted, that check fails immediately with a distinguishable `SESSION_REVOKED` error — the queue is **not** touched (no item is retried, no item is marked `BLOCKED`/quarantined), and the whole push is aborted with a `sessionRevoked` flag that the UI turns into the same forced-logout + message flow as the heartbeat/broadcast paths.
- **No data loss.** The queued sales stay `pending`, first-in-line, untouched. Once the cashier signs back in on Computer A (which re-claims the session — same "always wins" rule, now back in Computer A's favor), the very next sync attempt passes the pre-flight check and drains the backlog exactly as it would have otherwise.
- This is the correct and only safe answer given the architecture: single-session cannot be *instantly* enforced offline, only *guaranteed before the next authenticated write*, with zero data loss either way.

### One-time deployment note

After this migration is applied, every **currently** signed-in session's `active_session_id` holds the old app-level device fingerprint, not a real `session_id` claim — so every existing session will look "evicted" the next time it's checked (heartbeat, next RLS-gated call, or reload) and will need to sign in again once. This is expected, self-healing, and should be called out at deploy time (e.g. deploy during a lull), not treated as a bug. The DB migration and the frontend deploy must ship together — the migration drops the old `claim_staff_session(uuid, uuid)` / `heartbeat_staff_session(uuid, uuid)` / `release_staff_session(uuid, uuid)` overloads (closing the spoofing gap), so an old frontend build calling the old signatures will get a "function does not exist" error until it's redeployed.

---

## File Structure

- Create: `pos-frontend/supabase/migrate_single_active_session_enforcement.sql` — the entire DB-side change.
- Modify: `pos-frontend/src/lib/api.js` — zero-arg RPC wrappers, `isSessionRevokedError()`.
- Modify: `pos-frontend/src/utils/errors.js` — new `AUTH11` catalog entry + classifier regex.
- Modify: `pos-frontend/src/stores/posStore.js` — `login()`/`restoreSession()` updates, new `sessionRevoked()` action, `bindSessionRevokedWatcher()`.
- Modify: `pos-frontend/src/components/shared/Shell.jsx` — heartbeat error handling, new session-revoked broadcast listener.
- Modify: `pos-frontend/src/offline/syncEngine.js` — pre-flight session check in `pushQueue`, `sessionRevoked` propagation.
- Modify: `pos-frontend/src/App.jsx` — wire `bindSessionRevokedWatcher()`.
- Modify: `pos-frontend/docs/CODEMAP.md` — document the new session-lifecycle behavior.
- Modify: `pos-frontend/CHANGELOG.md` — `Unreleased` entry.
- Generated: `pos-frontend/docs/ERROR_CODES.md` — regenerated by `npm run docs:errors`, not hand-edited.

---

## Task 1: Database migration — evict-on-login + RLS enforcement + audit + broadcast

**Files:**
- Create: `pos-frontend/supabase/migrate_single_active_session_enforcement.sql`

**Interfaces:**
- Produces: `public.current_session_id()` — zero-arg, returns the caller's JWT `session_id` claim (or `null`).
- Produces: `public.claim_staff_session()` — zero-arg, `security definer`, always evicts a mismatched prior session, returns `jsonb {replaced: boolean}`, raises `STAFF_NOT_FOUND: ...` or `SESSION_CONTEXT_MISSING: ...` on failure.
- Produces: `public.heartbeat_staff_session()` — zero-arg, `security definer`, returns `true` or raises `SESSION_REVOKED: ...` (never steals).
- Produces: `public.release_staff_session()` — zero-arg, `security definer`, idempotent, only clears a session that still matches the caller.
- Modifies in place (same signatures): `public.current_staff_id()`, `public.current_staff_branch()`, `public.current_staff_role()` — now additionally require `active_session_id = current_session_id()`.
- Consumes: `public.broadcast_pos_event(p_branch uuid, p_channel text, p_event text, p_payload jsonb)` (existing, internal-only helper already used by `tg_*_broadcast()` triggers — confirmed at `schema.sql:4830`).

- [ ] **Step 1: Write the migration file**

```sql
-- Single active session per staff: evict-on-login, enforced via RLS, not just a login gate.
--
-- Supersedes the "reject the second login" behavior in migrate_staff_active_session.sql with
-- "the new login always wins, the old one is evicted everywhere the server can reach it."
-- Session identity is now the caller's own Supabase Auth JWT `session_id` claim (stable across
-- reloads/refreshes, unique per sign-in) instead of a client-supplied uuid — closes a latent gap
-- where any authenticated caller could pass an arbitrary p_staff_id/p_session_id to the old
-- claim/heartbeat/release RPCs.
--
-- Apply AFTER migrate_staff_active_session.sql and migrate_admin_session_release.sql.
-- Deploy together with the matching frontend build — this drops the old 2-arg RPC signatures.
--
-- ONE-TIME EFFECT: every currently signed-in session's active_session_id holds the old
-- device-fingerprint value, not a real JWT session_id, so every existing session will look
-- "evicted" the next time it's checked and will need to sign in again once. Expected; self-heals.

-- ---------------------------------------------------------------------------
-- 0) Session identity helper
-- ---------------------------------------------------------------------------
create or replace function public.current_session_id()
returns uuid
language sql
stable
set search_path = public
as $$
  select nullif(auth.jwt() ->> 'session_id', '')::uuid;
$$;

revoke execute on function public.current_session_id() from public, anon;
grant execute on function public.current_session_id() to authenticated;

-- ---------------------------------------------------------------------------
-- 1) Drop the old client-supplied-id overloads (closes the spoofing gap)
-- ---------------------------------------------------------------------------
drop function if exists public.claim_staff_session(uuid, uuid);
drop function if exists public.heartbeat_staff_session(uuid, uuid);
drop function if exists public.release_staff_session(uuid, uuid);

-- ---------------------------------------------------------------------------
-- 2) Claim: always evicts a mismatched prior session; audits + broadcasts the eviction
-- ---------------------------------------------------------------------------
create or replace function public.claim_staff_session()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_staff_id uuid;
  v_branch_id uuid;
  v_full_name text;
  v_prev_session uuid;
  v_new_session uuid := public.current_session_id();
  v_replaced boolean := false;
begin
  if v_new_session is null then
    raise exception 'SESSION_CONTEXT_MISSING: sign-in token has no session id';
  end if;

  select id, branch_id, full_name, active_session_id
    into v_staff_id, v_branch_id, v_full_name, v_prev_session
  from staff
  where auth_user_id = auth.uid() and is_active
  limit 1
  for update;

  if v_staff_id is null then
    raise exception 'STAFF_NOT_FOUND: no active staff row for this account';
  end if;

  v_replaced := v_prev_session is not null and v_prev_session is distinct from v_new_session;

  update staff
  set active_session_id = v_new_session,
      session_heartbeat_at = now()
  where id = v_staff_id;

  if v_replaced then
    -- Auditable trail of who got kicked, by whom, and when — same shape as the master
    -- break-glass release in migrate_admin_session_release.sql, but self-triggered by a
    -- normal login rather than an admin action.
    insert into public.audit_events (branch_id, staff_id, event_type, detail, meta)
    values (
      v_branch_id,
      v_staff_id,
      'session_replaced',
      coalesce(v_full_name, 'Staff') || ' signed in on a new device; previous session ended',
      jsonb_build_object('previous_session_id', v_prev_session, 'new_session_id', v_new_session)
    );

    -- Best-effort instant notice to the evicted device, if it's online right now. The
    -- heartbeat check below is the real enforcement; this just removes the wait for a
    -- device that happens to be connected. Never trusted as-is by the receiver — it just
    -- triggers a real heartbeat_staff_session() re-check (see Shell.jsx).
    perform public.broadcast_pos_event(
      v_branch_id,
      'operations',
      'OPERATIONS_CHANGED',
      jsonb_build_object('kind', 'session_revoked', 'staff_id', v_staff_id)
    );
  end if;

  return jsonb_build_object('replaced', v_replaced);
end;
$$;

-- ---------------------------------------------------------------------------
-- 3) Heartbeat: verify-only, never steals. This is what an evicted device fails.
-- ---------------------------------------------------------------------------
create or replace function public.heartbeat_staff_session()
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_staff_id uuid;
  v_session uuid := public.current_session_id();
begin
  select id into v_staff_id from staff where auth_user_id = auth.uid() and is_active limit 1;

  if v_staff_id is null or v_session is null then
    raise exception 'SESSION_REVOKED: session no longer valid';
  end if;

  update staff
  set session_heartbeat_at = now()
  where id = v_staff_id and active_session_id = v_session;

  if not found then
    raise exception 'SESSION_REVOKED: this account was signed in on another device';
  end if;

  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4) Release: only clears a session that still belongs to the caller. Never lets an
--    already-evicted device clear whoever now holds the claim.
-- ---------------------------------------------------------------------------
create or replace function public.release_staff_session()
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_staff_id uuid;
  v_session uuid := public.current_session_id();
begin
  select id into v_staff_id from staff where auth_user_id = auth.uid() and is_active limit 1;
  if v_staff_id is null then
    return true;
  end if;

  update staff
  set active_session_id = null,
      session_heartbeat_at = null
  where id = v_staff_id and active_session_id = v_session;

  return true;
end;
$$;

grant execute on function public.claim_staff_session() to authenticated;
grant execute on function public.heartbeat_staff_session() to authenticated;
grant execute on function public.release_staff_session() to authenticated;
revoke execute on function public.claim_staff_session() from public, anon;
revoke execute on function public.heartbeat_staff_session() from public, anon;
revoke execute on function public.release_staff_session() from public, anon;

-- ---------------------------------------------------------------------------
-- 5) The real enforcement: gate the three functions nearly every RLS policy and every
--    SECURITY DEFINER RPC in the schema already goes through. An evicted device's JWT is
--    still cryptographically valid, but current_staff_id()/current_staff_branch()/
--    current_staff_role() now return nothing for it, so RLS denies it and every RPC's own
--    "not a manager of this branch" style guard denies it too — no per-table, per-RPC edits.
--
--    Deliberately NOT applied to the "read staff" self-row policy (auth_user_id = auth.uid())
--    — fetchSessionStaff() reads that BEFORE claim_staff_session() has run on a fresh login,
--    so gating it would deadlock every login. An evicted device can still read its own bare
--    staff row; it cannot do anything current_staff_branch()/current_staff_role() gates.
-- ---------------------------------------------------------------------------
create or replace function public.current_staff_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select id from public.staff
  where auth_user_id = auth.uid()
    and is_active
    and active_session_id = public.current_session_id()
  limit 1;
$$;

create or replace function public.current_staff_branch()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select branch_id from public.staff
  where auth_user_id = auth.uid()
    and is_active
    and active_session_id = public.current_session_id()
  limit 1;
$$;

create or replace function public.current_staff_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select role from public.staff
  where auth_user_id = auth.uid()
    and is_active
    and active_session_id = public.current_session_id()
  limit 1;
$$;

-- Verify (apply in a dev/staging project first — this migration changes the behavior of
-- nearly every RLS policy in the schema):
--   -- as a signed-in staff member, after calling claim_staff_session() once:
--   select public.current_staff_id(), public.current_staff_branch(), public.current_staff_role();
--   -- should return this staff's own row, not null
--
--   -- simulate eviction: run claim_staff_session() as the SAME staff member from a second
--   -- browser/session, then re-run the query above from the FIRST session:
--   select public.current_staff_id(); -- should now be null
--   select public.heartbeat_staff_session(); -- should raise SESSION_REVOKED: ...
--
--   -- audit trail:
--   select * from public.audit_events where event_type = 'session_replaced' order by created_at desc limit 5;
```

- [ ] **Step 2: Apply in the Supabase SQL editor against a dev/staging project first**

Per `supabase/README.md` conventions (no migration runner — applied by hand). Run the file's own `-- Verify` block from Step 1 after applying, as two different browser sessions signed in as the same test staff account, to confirm eviction actually happens.

- [ ] **Step 3: Confirm `complete_sale_secure` / `void_sale_secure` / other core RPCs still resolve identity correctly**

```sql
-- As a normal signed-in staff member (freshly claimed session), confirm a real RPC still
-- authorizes normally — e.g. for a supervisor/manager account:
select public.is_manager(); -- should reflect the real role, not null/false due to a session mismatch
```

Expected: unchanged for a valid, freshly-claimed session. Only a *mismatched* session should see a change.

- [ ] **Step 4: Commit**

```bash
git add pos-frontend/supabase/migrate_single_active_session_enforcement.sql
git commit -m "feat(auth): evict prior session on login, enforce single active session via RLS"
```

---

## Task 2: `api.js` — zero-arg RPC wrappers + revoked-error helper

**Files:**
- Modify: `pos-frontend/src/lib/api.js:685-715` (current `signOut`/`claimStaffSession`/`heartbeatStaffSession`/`releaseStaffSession`)

**Interfaces:**
- Consumes: Task 1's zero-arg `claim_staff_session`/`heartbeat_staff_session`/`release_staff_session` RPCs.
- Produces: `claimStaffSession()`, `heartbeatStaffSession()`, `releaseStaffSession()` (all zero-arg now), `isSessionRevokedError(error)` — used by `posStore.js`, `Shell.jsx`, `syncEngine.js`.
- `getOrCreateDeviceSessionId()`/`clearDeviceSessionId()` (`api.js:837-860`) are **unchanged** — they remain the till/device fingerprint used by `Cart.jsx`/`CartRemoveApprove.jsx` for `deviceId` on sale/void-approval payloads, unrelated to session security after this change.

- [ ] **Step 1: Replace the three RPC wrappers**

```js
export async function claimStaffSession() {
  const { data, error } = await supabase.rpc('claim_staff_session')
  if (error) throw error
  return data
}

export async function heartbeatStaffSession() {
  const { error } = await supabase.rpc('heartbeat_staff_session')
  if (error) throw error
  return true
}

export async function releaseStaffSession() {
  const { error } = await supabase.rpc('release_staff_session')
  if (error) console.warn('release_staff_session:', error.message)
  return true
}

/** True when an error is this device's session having been evicted by a login elsewhere. */
export function isSessionRevokedError(error) {
  return /SESSION_REVOKED/i.test(String(error?.message || error || ''))
}
```

- [ ] **Step 2: Run lint to catch now-unused-arg call sites before touching other files**

Run: `cd pos-frontend && npm run lint`
Expected: errors/warnings at every old `claimStaffSession(user.id, sessionId)`-style call site (fixed in later tasks) — confirms nothing else silently swallows the signature change.

- [ ] **Step 3: Commit**

```bash
git add pos-frontend/src/lib/api.js
git commit -m "feat(auth): zero-arg session RPC wrappers, add isSessionRevokedError"
```

---

## Task 3: Error catalog — `AUTH11`

**Files:**
- Modify: `pos-frontend/src/utils/errors.js` (catalog around line 162, `formatSupportError` around line 956, `classifyError` around line 991)

**Interfaces:**
- Produces: `ERROR_CATALOG.AUTH11`, used via `appError('AUTH11')` in `posStore.js` (Task 4).
- Consumes: nothing new — follows the exact existing pattern used by `AUTH07` (content-regex match, since `error` state is stored as a plain string, not an `Error` object with `.code`).

- [ ] **Step 1: Add the catalog entry**

Insert after `AUTH10` (`errors.js:170`):

```js
  AUTH11: {
    message: 'Your session has ended because this account was signed in on another device.',
    severity: B,
    saleImpact: SALE_IMPACT.none,
    retry: true,
    cause:
      'Single-active-session policy (migrate_single_active_session_enforcement.sql): a newer login for this staff account replaced this device\'s session. Detected via the periodic heartbeat, a realtime notice, or a rejected offline-queue sync.',
    fix: 'Sign in again to resume on this device. Anything rung offline before the switch is still queued locally and syncs once signed back in.',
  },
```

- [ ] **Step 2: Add the classifier regex clause in both `formatSupportError` and `classifyError`**

In `formatSupportError` (`errors.js`, right after the existing `AUTH07` "Too many failed PIN" block, ~line 958):

```js
  if (/signed in on another device|session has ended/i.test(raw)) {
    return `${errorMessage('AUTH11')} · Code AUTH11`
  }
```

In `classifyError` (~line 993, same position relative to its `AUTH07` block):

```js
  if (/signed in on another device|session has ended/i.test(raw)) {
    return appError('AUTH11', raw)
  }
```

- [ ] **Step 3: Regenerate the docs and verify the check script**

Run: `cd pos-frontend && npm run docs:errors`
Expected: `docs/ERROR_CODES.md` gains an `AUTH11` entry, diff is additive only.

Run: `npm run check:errors`
Expected: passes (exit 0) — confirms every code referenced in `src/` now has a catalog entry.

- [ ] **Step 4: Commit**

```bash
git add pos-frontend/src/utils/errors.js pos-frontend/docs/ERROR_CODES.md
git commit -m "feat(auth): add AUTH11 for single-active-session eviction"
```

---

## Task 4: `posStore.js` — login/restore/new `sessionRevoked` action

**Files:**
- Modify: `pos-frontend/src/stores/posStore.js:58-138` (`login`), `:139-229` (`restoreSession`), add new action near `logout` (`:261-293`)

**Interfaces:**
- Consumes: `api.claimStaffSession()`, `api.heartbeatStaffSession()`, `api.isSessionRevokedError()`, `appError('AUTH11')` (already imported).
- Produces: `useAuthStore.getState().sessionRevoked()` — called by Shell.jsx (Task 5) and the sync watcher (this task's Step 3).
- Produces: `bindSessionRevokedWatcher()` — called once from `App.jsx` (Task 6).

- [ ] **Step 1: `login()` — drop args, claim still steals (this is the intended "new login wins" path)**

In `posStore.js:112-118`, replace:

```js
      const sessionId = api.getOrCreateDeviceSessionId()
      try {
        await api.claimStaffSession(user.id, sessionId)
      } catch (claimErr) {
        await api.signOut().catch(() => {})
        throw claimErr
      }
```

with:

```js
      const sessionId = api.getOrCreateDeviceSessionId()
      try {
        await api.claimStaffSession()
      } catch (claimErr) {
        await api.signOut().catch(() => {})
        throw claimErr
      }
```

(`sessionId` is still generated and used two lines later for `deviceSessionId`/`saveLocalSession` — that purpose is unchanged, only the call into `claimStaffSession` drops its args.)

- [ ] **Step 2: `restoreSession()` — verify, don't steal, on a plain reload/reopen**

In `posStore.js:139-229`, this block currently calls `claimStaffSession` on every restore, relying on the old same-device-id self-heal. Replace the comment + claim block (`:143-148` and `:193-217`):

Replace the stale comment at `:143-148`:

```js
      // Tab/browser was closed (or crashed with close mark) — never auto-login.
      //
      // Deliberately NOT calling api.clearDeviceSessionId() here: this device's id is also
      // used as the till/device fingerprint on sale and void-approval payloads
      // (Cart.jsx/CartRemoveApprove.jsx) — unrelated to session security, keep it stable.
```

Replace the claim block at `:193-217`:

```js
      await saveLocalSession(user)
      if (user?.id && isOnline()) {
        const sessionId = user.deviceSessionId || api.getOrCreateDeviceSessionId()
        try {
          // Verify-only: a plain reload keeps the same JWT session_id, so this succeeds for
          // a device that's still legitimately holding the claim. It must NOT re-steal the
          // session — that would let a mere page refresh silently take it back from whoever
          // holds it now, defeating eviction entirely.
          await api.heartbeatStaffSession()
          user = { ...user, deviceSessionId: sessionId }
          await saveLocalSession(user)
          set({ user, booting: false, deviceSessionId: sessionId })
        } catch (verifyErr) {
          await api.signOut().catch(() => {})
          await clearLocalSession()
          await api.clearManagerUnlockSecret().catch(() => {})
          const message = api.isSessionRevokedError(verifyErr)
            ? appError('AUTH11').message
            : verifyErr.message
          set({ user: null, booting: false, error: message, screenLocked: false })
          return null
        }
      } else {
        set({ user, booting: false })
      }
```

- [ ] **Step 3: Add the `sessionRevoked` action**

Insert after `logout` (`posStore.js`, after line 293's closing `},`):

```js
  /** Forced kick: this device's session was evicted by a login elsewhere (heartbeat,
   *  realtime notice, or a rejected sync push all funnel here). Mirrors logout()'s cleanup
   *  but does NOT call releaseStaffSession — the session it would try to release already
   *  belongs to whoever evicted us, and release_staff_session() only clears a session that
   *  still matches the caller, so it would be a safe no-op anyway; skipped for clarity.
   *  Does not emit its own audit event — claim_staff_session() already recorded
   *  'session_replaced' server-side at the moment of eviction, which is the authoritative,
   *  tamper-resistant trail (this device may be offline or the tab may just be closed).
   */
  sessionRevoked: async () => {
    useCartStore.getState().clear()
    set({
      user: null,
      screenLocked: false,
      deviceSessionId: null,
      loginIntroUser: null,
      error: appError('AUTH11').message,
      booting: false,
    })
    if (api.hasSupabase && isOnline()) await api.signOut().catch(() => {})
    await clearLocalSession()
    api.clearDeviceSessionId()
    await api.clearManagerUnlockSecret().catch(() => {})
    setSyncBranchId(null)
    useShiftStore.getState().forget()
  },
```

- [ ] **Step 4: Add `bindSessionRevokedWatcher()`**

Add near the bottom of `posStore.js`, after the `useAuthStore` definition (mirrors `bindSyncStore()` in `syncStore.js`):

```js
import { subscribeSync } from '../offline'
```

Add to the existing `from '../offline'` import block at the top of the file instead of a new import line (it already imports several named exports from `'../offline'` — add `subscribeSync` to that list).

Then, after the `useAuthStore` export:

```js
let sessionRevokedWatcherBound = false
/** Wires the offline sync engine's sessionRevoked signal (Task 5, syncEngine.js) to the
 *  forced-logout action above. Call once from App.jsx, alongside bindSyncStore(). */
export function bindSessionRevokedWatcher() {
  if (sessionRevokedWatcherBound) return
  sessionRevokedWatcherBound = true
  subscribeSync((state) => {
    if (state.sessionRevoked) void useAuthStore.getState().sessionRevoked()
  })
}
```

- [ ] **Step 5: Lint**

Run: `cd pos-frontend && npm run lint`
Expected: no new errors in `posStore.js`.

- [ ] **Step 6: Commit**

```bash
git add pos-frontend/src/stores/posStore.js
git commit -m "feat(auth): posStore login/restore use evict-aware session RPCs, add sessionRevoked action"
```

---

## Task 5: `Shell.jsx` — heartbeat enforcement + instant broadcast kick

**Files:**
- Modify: `pos-frontend/src/components/shared/Shell.jsx:5` (imports), `:37` (remove dead `deviceSessionId` read), `:133-143` (heartbeat effect), add new effect near it

**Interfaces:**
- Consumes: `heartbeatStaffSession()`, `isSessionRevokedError()` (`../../lib/api`), `subscribeBroadcast` (`../../offline/realtime`), `useAuthStore.getState().sessionRevoked()`.

- [ ] **Step 1: Update imports**

Replace `Shell.jsx:5`:

```js
import { fetchCompanyProfile, hasSupabase, heartbeatStaffSession, isSessionRevokedError } from '../../lib/api'
```

Add near the other hook/offline imports:

```js
import { subscribeBroadcast } from '../../offline/realtime'
```

- [ ] **Step 2: Remove the now-dead local `deviceSessionId` read**

Delete `Shell.jsx:37`:

```js
  const deviceSessionId = useAuthStore((state) => state.deviceSessionId)
```

(Confirmed unused elsewhere in this file after Step 3 — `Cart.jsx`/`CartRemoveApprove.jsx` read their own `deviceSessionId` directly from the store for the unrelated till-fingerprint purpose and are untouched.)

- [ ] **Step 3: Rewrite the heartbeat effect to enforce, not swallow**

Replace `Shell.jsx:133-143`:

```js
  useEffect(() => {
    if (!hasSupabase || !user?.id) return undefined
    const tick = async () => {
      try {
        await heartbeatStaffSession()
      } catch (err) {
        if (isSessionRevokedError(err)) void useAuthStore.getState().sessionRevoked()
        // Any other failure (offline, transient blip) — do nothing, same as before; the
        // next tick or the next RLS-gated action will catch a real revocation.
      }
    }
    tick()
    const t = window.setInterval(tick, HEARTBEAT_MS)
    return () => window.clearInterval(t)
  }, [user?.id])
```

- [ ] **Step 4: Add the instant-kick broadcast listener**

Add a new effect near the heartbeat effect (reuses the same `pos:branch:<id>:operations` topic `useBranchOperationsLive` already subscribes to for this branch — no new Realtime Authorization policy needed):

```js
  useEffect(() => {
    if (!hasSupabase || !user?.id || !user?.branchId) return undefined
    return subscribeBroadcast({
      topic: `pos:branch:${user.branchId}:operations`,
      events: ['OPERATIONS_CHANGED'],
      onEvent: (payload) => {
        if (payload?.kind !== 'session_revoked' || payload?.staff_id !== user.id) return
        // Never trust the broadcast payload as truth (see CODEMAP.md Realtime section) —
        // it only triggers an authoritative re-check against Postgres.
        heartbeatStaffSession().catch((err) => {
          if (isSessionRevokedError(err)) void useAuthStore.getState().sessionRevoked()
        })
      },
    })
  }, [user?.id, user?.branchId])
```

- [ ] **Step 5: Lint**

Run: `cd pos-frontend && npm run lint`
Expected: no new errors/warnings (confirms `deviceSessionId` removal didn't leave a dangling reference).

- [ ] **Step 6: Commit**

```bash
git add pos-frontend/src/components/shared/Shell.jsx
git commit -m "feat(auth): enforce heartbeat revocation, add instant session-revoked broadcast"
```

---

## Task 6: `syncEngine.js` — pre-flight session check on the offline queue

**Files:**
- Modify: `pos-frontend/src/offline/syncEngine.js:459-520` (`pushQueue`), `:548-609` (`drainQueueInBackground`), `:617-` (`syncBranch`, `emit()` calls)

**Interfaces:**
- Consumes: `api.heartbeatStaffSession()`, `api.isSessionRevokedError()` (already imports `* as api`).
- Produces: `pushQueue()` now returns an additional `sessionRevoked: boolean` field; `emit()` payloads in `drainQueueInBackground`/`syncBranch` carry it through to `syncStore.js`'s existing `subscribeSync` plumbing, which `bindSessionRevokedWatcher()` (Task 4) reads.

- [ ] **Step 1: Pre-flight check at the top of `pushQueue`, before any item is touched**

In `syncEngine.js:479-486`, replace:

```js
  pushInFlight = true
  try {
  await resetStuckSyncing()
  const pending = await listPending(branchId)
  let pushed = 0
  let error = null
  let pushedOnlySelfHealing = true
```

with:

```js
  pushInFlight = true
  try {
  // Verify this device's session is still valid BEFORE touching any queued item. This is
  // what makes offline-then-reconnect safe: if the account was claimed on another device
  // while this one was offline, every item would otherwise fail identically and each would
  // burn retries toward MAX_SYNC_ATTEMPTS and get wrongly quarantined as BLOCKED. Catching
  // it here means the queue is left untouched — still pending, first-in-line — until the
  // user signs back in on this device.
  try {
    await api.heartbeatStaffSession()
  } catch (heartbeatErr) {
    if (api.isSessionRevokedError(heartbeatErr)) {
      return {
        pushed: 0,
        remaining: await countPending(branchId),
        blocked: await countBlocked(branchId),
        error: null,
        pushedOnlySelfHealing: true,
        sessionRevoked: true,
      }
    }
    // Any other heartbeat failure (network blip) — don't block the push attempt on it.
  }

  await resetStuckSyncing()
  const pending = await listPending(branchId)
  let pushed = 0
  let error = null
  let pushedOnlySelfHealing = true
```

- [ ] **Step 2: Include `sessionRevoked: false` on the normal return path**

In `syncEngine.js:509-516`, replace:

```js
  const remaining = await countPending(branchId)
  return {
    pushed,
    remaining,
    blocked: await countBlocked(branchId),
    error,
    pushedOnlySelfHealing,
  }
```

with:

```js
  const remaining = await countPending(branchId)
  return {
    pushed,
    remaining,
    blocked: await countBlocked(branchId),
    error,
    pushedOnlySelfHealing,
    sessionRevoked: false,
  }
```

(Note: the early-return branches earlier in `pushQueue`, `!api.hasSupabase || !(await canSyncWithBackend())` and `pushInFlight`, at lines 460-477, stay as-is — add `sessionRevoked: false` to those two returned objects too, for a consistent shape.)

- [ ] **Step 3: Propagate through `drainQueueInBackground`'s loop and emits**

In `syncEngine.js:560-580`, the `while` loop and its `emit()` calls — add `sessionRevoked` to the emitted state and break the loop on it:

```js
    let lastPush = { pushed: 0, remaining: await countPending(branchId), error: null, sessionRevoked: false }
    let totalPushed = 0
    let allPushedOnlySelfHealing = true
    while ((await canSyncWithBackend()) && lastPush.remaining > 0) {
      lastPush = await pushQueue(branchId, { maxItems: PUSH_BATCH_SIZE })
      totalPushed += lastPush.pushed
      allPushedOnlySelfHealing = allPushedOnlySelfHealing && lastPush.pushedOnlySelfHealing
      emit({
        status: 'syncing',
        online: true,
        backendReachable: true,
        pending: lastPush.remaining,
        lastError: lastPush.error,
        sessionRevoked: lastPush.sessionRevoked,
      })
      if (lastPush.sessionRevoked) break
      if (lastPush.error && lastPush.pushed === 0) break
      if (lastPush.remaining > 0) {
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
    }
```

And the final `emit()` in that same function (~`:588-595`) — add `sessionRevoked: lastPush.sessionRevoked`:

```js
    emit({
      status: lastPush.error ? 'error' : 'idle',
      online: isOnline(),
      backendReachable: await canSyncWithBackend(),
      pending: await countPending(branchId),
      blocked: await countBlocked(branchId),
      lastError: lastPush.error,
      sessionRevoked: lastPush.sessionRevoked,
    })
```

- [ ] **Step 4: Propagate through `syncBranch`'s single `pushQueue` call**

In `syncEngine.js`, the `syncBranch()` function's `emit()` call right after its `pushQueue` (~line 628-634) — add `sessionRevoked: pushResult.sessionRevoked`:

```js
      const pushResult = await pushQueue(branchId, { maxItems: PUSH_BATCH_SIZE })
      emit({
        status: 'syncing',
        pending: pushResult.remaining,
        online: true,
        lastError: pushResult.error,
        sessionRevoked: pushResult.sessionRevoked,
      })
```

- [ ] **Step 5: Manual verification — simulate a revoked session mid-queue**

No test framework; verify manually against a dev Supabase project:
1. Sign in on Device A, go offline (devtools "Offline" network throttling), ring an offline sale so it's queued (`pending`).
2. On Device B, sign in as the same staff account online (evicts A's `active_session_id` server-side).
3. Bring Device A back online.
4. Expected: Device A's sync attempt does not mark the queued sale `BLOCKED`; `useSyncStore`'s `pending` count for that item stays untouched; the app forces Device A to the login screen with the AUTH11 message; the queued sale is still there (check `db.syncQueue` in devtools IndexedDB) with `status: 'pending'`.
5. Sign back in on Device A. Expected: the queued sale syncs normally on the next drain.

- [ ] **Step 6: Lint**

Run: `cd pos-frontend && npm run lint`

- [ ] **Step 7: Commit**

```bash
git add pos-frontend/src/offline/syncEngine.js
git commit -m "feat(auth): pre-flight session check on offline queue drain, no data loss on eviction"
```

---

## Task 7: Wire the watcher in `App.jsx`

**Files:**
- Modify: `pos-frontend/src/App.jsx:14` (import), `:158` (call site, next to `bindSyncStore()`)

- [ ] **Step 1: Import and call `bindSessionRevokedWatcher()`**

Next to the existing `import { bindSyncStore } from './stores/syncStore'` (`App.jsx:14`):

```js
import { bindSessionRevokedWatcher } from './stores/posStore'
```

Next to the existing `bindSyncStore()` call (`App.jsx:158`):

```js
    bindSyncStore()
    bindSessionRevokedWatcher()
```

- [ ] **Step 2: Lint + build**

Run: `cd pos-frontend && npm run lint && npm run build`
Expected: both pass. The build also re-runs `check:errors` (Task 3's `AUTH11` catalog entry already satisfies it).

- [ ] **Step 3: Commit**

```bash
git add pos-frontend/src/App.jsx
git commit -m "feat(auth): wire sessionRevoked watcher on app boot"
```

---

## Task 8: Manual end-to-end verification (two browsers)

**Files:** none — verification only.

- [ ] **Step 1: Start the dev server**

Run: `cd pos-frontend && npm run dev`

- [ ] **Step 2: Basic eviction, both online**

1. Sign in as the same cashier/PIN account in two different browsers (or one normal + one incognito window).
2. In Browser A, confirm normal POS use works (add to cart, etc.).
3. In Browser B, sign in as the same account.
4. Expected within a few seconds (broadcast path) and no later than ~`HEARTBEAT_MS` (Shell.jsx's interval, currently 2.5 min) as a fallback: Browser A is kicked to the login screen showing "Your session has ended because this account was signed in on another device." · Code AUTH11.
5. Confirm Browser A can no longer complete any POS action if attempted in the brief window before the kick (should be denied server-side even if attempted).
6. Confirm `audit_events` has a `session_replaced` row (Supabase dashboard or SQL editor).

- [ ] **Step 3: Master override still works end-to-end**

1. Sign in as a `master` account, force-release the evicted session via `admin_release_staff_session` (existing `Devices.jsx`/settings UI path, or SQL editor).
2. Confirm the targeted device (if it happens to still be signed in) also gets kicked — this now works for the first time since the heartbeat catch is no longer swallowed.

- [ ] **Step 4: Offline scenario from the Design & Constraints section**

Repeat Task 6 Step 5's scenario end-to-end through the actual UI (not just devtools inspection): ring an offline sale on Device A while offline, evict from Device B, bring Device A online, confirm the forced logout + message, confirm the sale is still queued (not lost, not blocked), confirm it syncs after signing back in.

- [ ] **Step 5: Regression check on unrelated device-id usage**

Ring a sale and trigger a cart-removal-approval flow; confirm `deviceId` still populates on the resulting `transactions`/audit records (Cart.jsx/CartRemoveApprove.jsx path is untouched by this plan — confirms no accidental breakage of the till fingerprint).

---

## Task 9: Documentation + changelog

**Files:**
- Modify: `pos-frontend/docs/CODEMAP.md`
- Modify: `pos-frontend/CHANGELOG.md`

- [ ] **Step 1: Update CODEMAP.md**

Add a subsection under the existing Auth session material (near where `sessionLifecycle.js`/`offline/session.js` are documented) describing: single-active-session enforcement, the `session_id`-JWT-claim mechanism, which functions gate it (`current_staff_id`/`current_staff_branch`/`current_staff_role`), the three detection paths (heartbeat, broadcast, sync pre-flight), and the offline-eviction behavior (no data loss, enforced at reconnect). Cross-reference `migrate_single_active_session_enforcement.sql`.

- [ ] **Step 2: Add a CHANGELOG.md entry under `Unreleased`**

```markdown
## Unreleased

### Added: single active session per staff account

Signing in on a second device now evicts the first everywhere the server can reach it,
instead of blocking the second login. Enforced in Postgres (RLS + the RPCs nearly every
policy already goes through), not just the UI — an evicted device cannot complete any
POS action once detected, via a periodic heartbeat, an instant realtime notice, or (for a
device that was offline at the moment of eviction) a pre-flight check the next time it
tries to sync its offline queue. No data loss in the offline case: queued sales stay
queued until the cashier signs back in. See `supabase/migrate_single_active_session_enforcement.sql`.
```

- [ ] **Step 3: Confirm the version bump with the user before committing**

Per `CLAUDE.md`: "Only update or increment Version from 0.1.0 to 0.2.0 when the user accepts and prompted to. do not automattically adjust or update the version number." Do not pick a new `package.json` version number in this task — ask the user whether this should be MINOR (new capability) given it also changes existing sign-in behavior for every role (a manager checking two branches back-to-back will now get logged out of the first), and let them decide the number.

- [ ] **Step 4: Commit**

```bash
git add pos-frontend/docs/CODEMAP.md pos-frontend/CHANGELOG.md
git commit -m "docs: document single-active-session enforcement"
```

---

## Self-Review Notes (already applied above)

- **Spec coverage:** evict-on-login (Task 1 §2) · server-side enforcement (Task 1 §5) · exact message text (Task 3, `AUTH11`) · not relying on local/sessionStorage alone (enforcement is the JWT `session_id` claim checked against a DB column on every request, not any client-stored flag) · audit trail (Task 1 §2, `audit_events` insert) · reuse existing implementation (built entirely on `migrate_staff_active_session.sql`'s existing columns/RPCs) · offline analysis (Design & Constraints section + Task 6 + Task 8 §4) — all covered.
- **Placeholder scan:** no "TBD"/"handle appropriately" — every step has literal file paths, line numbers, and complete code.
- **Type/name consistency:** `isSessionRevokedError` (api.js) used identically in `posStore.js`, `Shell.jsx`, `syncEngine.js`; `sessionRevoked` boolean field name consistent from `pushQueue()`'s return value through `emit()` through `subscribeSync`'s state through `bindSessionRevokedWatcher()`.
