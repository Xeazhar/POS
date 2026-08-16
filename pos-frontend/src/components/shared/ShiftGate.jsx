import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { FiCheck } from 'react-icons/fi'
import { Eyebrow, Field, Modal, ModalActions, PrimaryButton, SecondaryButton } from '../ui'
import SupervisorApprove from './SupervisorApprove'
import { logApprovalEvent } from '../../lib/api'
import { useInventoryStore } from '../../stores/posStore'
import { useShiftStore } from '../../stores/shiftStore'
import { formatSupportError } from '../../utils/errors'
import { businessDate, dayEndForBusinessDate, isDayFullyClosed, money } from '../../utils/format'
import { decimalOnly, formatMoneyOnBlur } from '../../utils/validate'

function defaultShiftPeriod() {
  return new Date().getHours() < 12 ? 'am' : 'pm'
}

function sinceLabel(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/**
 * Blocks everything until this terminal has a shift to sell under (or explains why it
 * cannot, yet).
 *
 * Cases, each with its own remedy:
 *   start        — auto-starts with startingCash 0, no prompt — UNLESS today's business
 *                  day is already closed (see `dayClosed` below) or was reopened after a
 *                  close (see `needsFreshCount`), the one case that still asks for a
 *                  counted figure.
 *   moved        — this cashier is open on another till, so their cash is somewhere else.
 *   ended        — this session just cashed out; sign out (Shell exempts /day-end from
 *                  this so Request day end stays reachable first — see Shell's
 *                  `shiftBlocking`).
 *   day closed   — `gate === 'start'` but today's day-end already closed; no new change
 *                  fund is accepted until the next business day rolls in or a manager
 *                  reopens the closing.
 *
 * There is no "drawer still open under someone else" case: starting a shift auto-closes a
 * stale one on the same drawer server-side (no count required — see endShift), so a new
 * cashier is never blocked waiting on the previous one to formally cash out.
 *
 * Resuming is not one of the cases: when a shift is already open for this cashier on this
 * drawer, the store answers `ready` and this component never renders. That is what makes
 * an accidental sign-out cost nothing.
 */
function ShiftGate({ user, holdsDrawer: holdsDrawerDefault = true, onSignOut }) {
  const navigate = useNavigate()
  const gate = useShiftStore((state) => state.gate)
  const blocker = useShiftStore((state) => state.blocker)
  const handoff = useShiftStore((state) => state.handoff)
  const restartPrompt = useShiftStore((state) => state.restartPrompt)
  const drawerLabel = useShiftStore((state) => state.drawerLabel)
  const startShift = useShiftStore((state) => state.startShift)
  const resolve = useShiftStore((state) => state.resolve)
  const dayEnds = useInventoryStore((state) => state.dayEnds)
  const dayOpenHour = useInventoryStore((state) => state.dayOpenHour)
  const requestDayReopen = useInventoryStore((state) => state.requestDayReopen)

  // A supervisor is not locked into "floor only" — they may be working the register
  // themselves this shift. Shell hands this component `holdsDrawerDefault` (true only for
  // `role === 'cashier'`) as the starting assumption for the very first `resolve()` call at
  // sign-in; a supervisor can then pick here before starting, and everything below reads
  // `holdsDrawer` (the effective choice), not the role. That is what makes Open Drawer
  // (petty cash / opening float), Day End's cashier-drawer accountability list, and cash
  // impact all pick up a supervisor's drawer shift for free — they already key off
  // `shift.holdsDrawer`, never off role.
  //
  // Picking an option here is SELECTION only — it must not fire the shift itself. The actor
  // confirms with the explicit "Start shift" button below, same as every other choice on
  // this screen (AM/PM, the change-fund count); nothing on this page commits on click alone.
  const canChooseDrawer = user?.role === 'supervisor'
  const [wantsDrawer, setWantsDrawer] = useState(false)
  const holdsDrawer = canChooseDrawer ? wantsDrawer : holdsDrawerDefault

  // A closed business day has already been counted and filed — a NEW change fund entering
  // the drawer after that is cash a supervisor's Z-reading never saw, an instant
  // discrepancy nobody can explain later. Only gates the cashier's own change-fund count;
  // a floor shift (holdsDrawer false) never touches cash, so it is unaffected.
  const todayEntry = dayEndForBusinessDate(dayEnds, businessDate(new Date(), dayOpenHour))
  const dayClosed = holdsDrawer && isDayFullyClosed(dayEnds, dayOpenHour)
  // Cash counting is a DAY-END activity now, not a shift-boundary one (see endShift's own
  // doc comment) — an ordinary new shift needs no float count at all; it starts at 0 and
  // Day End's day-wide total is what reconciles the drawer (Open Drawer → Opening float
  // covers adding real cash later, and IS counted — see migrate_cash_movement_cash_in.sql).
  // The one exception: right after a manager reopens a CLOSED day. IRL the person holding
  // the drawer already took possession of the cash at that close, so the till is genuinely
  // starting over and a real count is worth asking for again. `needsFreshCount` — not bare
  // `holdsDrawer` — is what actually demands a typed figure below: a supervisor who has
  // just chosen "working the register" on an ordinary (non-reopened) day starts at ₱0 with
  // no form, exactly like a cashier's normal auto-start.
  const needsFreshCount = holdsDrawer && todayEntry?.status === 'reopened'
  const [reopenReason, setReopenReason] = useState('')
  const [reopenBusy, setReopenBusy] = useState(false)
  const [reopenError, setReopenError] = useState('')

  const doRequestReopen = async () => {
    if (!todayEntry?.id) return
    setReopenBusy(true)
    setReopenError('')
    try {
      await requestDayReopen(todayEntry.id, reopenReason)
    } catch (err) {
      setReopenError(formatSupportError(err, 'TILL03'))
    } finally {
      setReopenBusy(false)
    }
  }

  const carried = handoff?.endingCash

  const [shiftPeriod, setShiftPeriod] = useState(defaultShiftPeriod)
  const [amount, setAmount] = useState('')
  const [confirmedCount, setConfirmedCount] = useState(false)
  const [confirmNoFund, setConfirmNoFund] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  // Supervisor-gated escape hatch: 'override_drawer' (start here while their own shift is
  // open elsewhere).
  const [approving, setApproving] = useState(null)

  // Pre-fill the handoff amount, but never treat it as counted — `confirmedCount` resets
  // to false so the new cashier has to tick that they physically counted the drawer. A
  // pre-filled figure that submits itself is a count nobody did.
  //
  // Adjusted during render rather than in an effect (React's "adjusting state when a prop
  // changes" pattern): an effect would render the empty field first and then overwrite it,
  // which flashes an empty amount box at someone about to type a number into it.
  const [carriedSeen, setCarriedSeen] = useState(null)
  if (carried != null && carriedSeen !== carried) {
    setCarriedSeen(carried)
    setAmount(carried.toFixed(2))
    setConfirmedCount(false)
  }

  const amountNumber = Number(amount || 0)
  const amountValid = amount !== '' && Number.isFinite(amountNumber) && amountNumber >= 0
  const differsFromCarried =
    carried != null && Math.abs(amountNumber - Number(carried)) > 0.004
  const canStart = useMemo(() => {
    if (!needsFreshCount) return true
    if (!amountValid) return false
    // Adjusting the figure is itself a statement that they counted, so the tick is only
    // demanded when they are accepting the previous shift's number unchanged.
    if (carried != null && !differsFromCarried) return confirmedCount
    return true
  }, [needsFreshCount, amountValid, carried, differsFromCarried, confirmedCount])

  const doStart = async (opts = {}) => {
    setBusy(true)
    setError('')
    try {
      await startShift(user, {
        startingCash: holdsDrawer ? amountNumber : 0,
        shiftPeriod,
        // Link to the handoff whenever it has an actual counted ending amount, even if this
        // shift's own recount differs from it — Day End's float math (shiftFloatTotal) uses
        // this link to tell "this shift's cash is the same drawer someone recounted" from
        // "this shift's cash is a fresh float from the safe". A mismatched recount is still
        // the same physical drawer, just with a variance to flag to a supervisor (above).
        //
        // BUT: ending a shift normally records no count at all — counting moved to once per
        // BUSINESS DAY at Day End, not once per shift boundary (see endShift in
        // shiftStore.js) — so `handoff.endingCash` is null unless a supervisor specifically
        // confirmed that handoff (Day End's "Confirm received handoff", which computes and
        // writes one). With no counted amount, there is nothing genuine to carry: linking
        // anyway made every plain shift-to-shift handover on the same drawer exclude its
        // own real starting cash from the day's float total, because Day End treated it as
        // "already counted in a predecessor" that in fact was never counted at all.
        carriedFrom: handoff?.endingCash != null ? handoff : null,
        holdsDrawer,
        ...opts,
      })
      setConfirmNoFund(false)
    } catch (err) {
      setError(formatSupportError(err, 'SHIFT01'))
    } finally {
      setBusy(false)
    }
  }

  // Fires the routine case's auto-start (see needsFreshCount above) — no modal, just a
  // "Starting shift…" beat while the local-first write lands, which never waits on a
  // network round trip so this resolves almost immediately. Guarded by a ref, not just the
  // effect's own dependency array, so React StrictMode's dev-only double-invoke can't fire
  // startShift twice for the same gate transition.
  //
  // holdsDrawer-gated: a floor shift never had a count to skip in the first place (canStart
  // already lets it through immediately) — it still picks its AM/PM window on the form
  // below, same as always. Only a drawer-holding CASHIER's count gets skipped — a
  // `role === 'cashier'` shift never asked permission to hold a drawer in the first place, so
  // there is nothing left to confirm. `canChooseDrawer` is excluded on purpose: a supervisor
  // choosing "Working the register" must land on the same screen either way and confirm with
  // the Start shift button below, never fire the moment the option is picked.
  const autoStartedRef = useRef(false)
  const autoStarting =
    !canChooseDrawer &&
    gate === 'start' &&
    !dayClosed &&
    holdsDrawer &&
    !needsFreshCount &&
    !restartPrompt
  useEffect(() => {
    if (!autoStarting || autoStartedRef.current) return
    autoStartedRef.current = true
    void doStart({ startingCash: 0 })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStarting])

  const onStartClick = async () => {
    setError('')
    // A supervisor's very first resolve() (Shell mount) ran with holdsDrawer: false, which
    // skips the "already open on another till" check entirely (see resolve() in
    // shiftStore.js) — so picking "Working the register" here needs its own check before
    // committing, the same one `role === 'cashier'` gets for free at sign-in.
    let freshHandoff = handoff
    if (canChooseDrawer && wantsDrawer) {
      setBusy(true)
      const result = await resolve(user, { holdsDrawer: true }).catch(() => null)
      setBusy(false)
      // A conflict (`moved`) or an existing shift (`ready`) takes over via re-render —
      // nothing left to do here. Only a clean `start` continues to the actual open.
      if (!result || result.gate !== 'start') return
      // doStart() below is the closure captured at THIS render, still holding whatever
      // `handoff` was before the resolve() above ran (component state updates don't
      // rewrite a closure already executing) — thread the just-fetched value through
      // explicitly instead of trusting doStart to read it off (stale) component state.
      freshHandoff = result.handoff ?? null
    }
    if (needsFreshCount && amountNumber === 0) {
      setConfirmNoFund(true)
      return
    }
    void doStart({ carriedFrom: freshHandoff?.endingCash != null ? freshHandoff : null })
  }

  // Just cashed out on this session. Shell lets the End shift screen itself
  // (CashierEndShift on /day-end) stay open past this point so Request day end is still
  // reachable — this overlay only appears when they navigate somewhere else, so the "Day
  // end" shortcut below is how they get back to it without abandoning the sign-out screen
  // it's paired with. There is no "start a new shift here" escape on purpose: falling
  // through to the count-the-change-fund screen would let whoever is standing at the till
  // open the NEXT shift under THIS cashier's still-open session — the next person has to
  // authenticate as themselves first.
  if (gate === 'ended') {
    // The ended shift's OWN holdsDrawer, not the live toggle above — `wantsDrawer` is local
    // component state that resets to its default on remount (Shell hides/shows ShiftGate as
    // the gate changes), so it cannot be trusted to still describe a shift that already
    // closed. `handoff` is endShift()'s own return value, so it always carries the true
    // field regardless of remounts.
    if (!(handoff ? handoff.holdsDrawer : holdsDrawer)) {
      return (
        <Modal>
          <Eyebrow>SHIFT ENDED</Eyebrow>
          <h2 className="mb-1 text-lg">Floor shift closed</h2>
          <p className="m-0 text-xs text-brand-muted">
            Confirm received handoff and close the day before signing out. You can stay on this
            terminal until the business day is filed.
          </p>
          {error && <p className="mt-2 text-xs text-brand-danger">{error}</p>}
          <ModalActions>
            <SecondaryButton compact type="button" disabled={busy} onClick={onSignOut}>
              Sign out
            </SecondaryButton>
            <PrimaryButton compact type="button" disabled={busy} onClick={() => navigate('/day-end')}>
              Continue day end
            </PrimaryButton>
          </ModalActions>
        </Modal>
      )
    }
    return (
      <Modal>
        <Eyebrow>SHIFT ENDED</Eyebrow>
        <h2 className="mb-1 text-lg">Drawer counted &amp; shift closed</h2>
        <p className="m-0 text-xs text-brand-muted">
          {handoff?.endingCash != null ? (
            <>
              Counted <strong className="text-brand-ink">{money(handoff.endingCash)}</strong> in{' '}
              {handoff.drawerLabel || drawerLabel || 'the drawer'}.{' '}
            </>
          ) : null}
          Request day end first if this business day is done, then sign out before handing
          the terminal to the next cashier.
        </p>
        {error && <p className="mt-2 text-xs text-brand-danger">{error}</p>}
        <ModalActions>
          <SecondaryButton compact type="button" disabled={busy} onClick={() => navigate('/day-end')}>
            Day end
          </SecondaryButton>
          <PrimaryButton compact type="button" disabled={busy} onClick={onSignOut}>
            Sign out
          </PrimaryButton>
        </ModalActions>
      </Modal>
    )
  }

  // The business day already got counted and filed at Day End — a new change fund now is
  // cash nobody's Z-reading will ever see. The only way past this is a fresh business day
  // (it rolls forward automatically at the branch's open hour), someone with authority
  // reopening today's closing from Day End, or asking for that below — reopening itself
  // stays manager-only (this is a request, not a bypass).
  if (gate === 'start' && dayClosed) {
    const reopenRequested = Boolean(todayEntry?.reopenRequestedAt)
    return (
      <Modal>
        <Eyebrow>DAY CLOSED</Eyebrow>
        <h2 className="mb-1 text-lg">Today&apos;s business day is closed</h2>
        <p className="m-0 text-xs text-brand-muted">
          The drawer was already counted and the day filed. Starting a shift now would put
          new cash in a drawer nobody's Z-reading covers.
        </p>
        {reopenRequested ? (
          <p className="mt-3 rounded-md bg-brand-n50 px-2.5 py-2 text-[11px] text-brand-muted">
            Reopen requested. Waiting on a manager.
          </p>
        ) : (
          <>
            <Field
              className="mt-3"
              label="Why does this need reopening? (optional)"
              value={reopenReason}
              onChange={(e) => setReopenReason(e.target.value)}
              placeholder="e.g. forgot to ring up a sale"
            />
            {reopenError && <p className="mt-2 text-xs text-brand-danger">{reopenError}</p>}
          </>
        )}
        {error && <p className="mt-2 text-xs text-brand-danger">{error}</p>}
        <ModalActions>
          {!reopenRequested && (
            <SecondaryButton
              compact
              type="button"
              disabled={reopenBusy || !todayEntry?.id}
              onClick={() => void doRequestReopen()}
            >
              {reopenBusy ? 'Requesting…' : 'Request reopen'}
            </SecondaryButton>
          )}
          <PrimaryButton compact type="button" disabled={busy} onClick={onSignOut}>
            Sign out
          </PrimaryButton>
        </ModalActions>
      </Modal>
    )
  }

  // This cashier ended their own shift on this drawer before (see restartPrompt in
  // shiftStore.resolve()) — ask instead of silently reopening one. A genuinely first-ever
  // shift on this drawer has no restartPrompt and keeps the silent auto-start below.
  if (!canChooseDrawer && gate === 'start' && !dayClosed && holdsDrawer && !needsFreshCount && restartPrompt) {
    return (
      <Modal>
        <Eyebrow>SHIFT ENDED</Eyebrow>
        <h2 className="mb-1 text-lg">Start your shift again?</h2>
        <p className="m-0 text-xs text-brand-muted">
          Your last shift on {drawerLabel || 'this drawer'} ended
          {restartPrompt.clockOut ? ` at ${sinceLabel(restartPrompt.clockOut)}` : ''}. Start a new
          one now, or sign out.
        </p>
        {error && <p className="mt-2 text-xs text-brand-danger">{error}</p>}
        <ModalActions>
          <SecondaryButton compact type="button" disabled={busy} onClick={onSignOut}>
            Sign out
          </SecondaryButton>
          <PrimaryButton
            compact
            type="button"
            disabled={busy}
            onClick={() => void doStart({ startingCash: 0 })}
          >
            {busy ? 'Starting…' : 'Start shift'}
          </PrimaryButton>
        </ModalActions>
      </Modal>
    )
  }

  // Routine case — see needsFreshCount above. No count needed; startShift already fired
  // from the effect. This only renders long enough to cover that local-first write (usually
  // imperceptible) or to offer a retry if it genuinely failed (offline mid-write, etc.).
  if (autoStarting) {
    return (
      <Modal>
        <Eyebrow>START SHIFT</Eyebrow>
        <h2 className="mb-1 text-lg">{error ? 'Could not start shift' : 'Starting shift…'}</h2>
        <p className="m-0 text-xs text-brand-muted">
          {error || 'Setting up your drawer, this only takes a moment.'}
        </p>
        {error && (
          <ModalActions>
            <SecondaryButton compact type="button" disabled={busy} onClick={onSignOut}>
              Sign out
            </SecondaryButton>
            <PrimaryButton
              compact
              type="button"
              disabled={busy}
              onClick={() => void doStart({ startingCash: 0 })}
            >
              {busy ? 'Starting…' : 'Retry'}
            </PrimaryButton>
          </ModalActions>
        )}
      </Modal>
    )
  }

  if (gate === 'moved' && blocker) {
    return (
      <>
        <Modal>
          <Eyebrow>DIFFERENT TILL</Eyebrow>
          <h2 className="mb-1 text-lg">Your shift is open on another till</h2>
          <p className="m-0 text-xs text-brand-muted">
            You already have an open shift on{' '}
            <strong className="text-brand-ink">{blocker.drawerLabel || blocker.drawerId}</strong>
            {blocker.clockIn ? `, started ${sinceLabel(blocker.clockIn)}` : ''}. That drawer still
            holds cash you are answerable for, so this terminal cannot simply take over. Go back
            and cash out there, or have a supervisor open a separate shift here.
          </p>
          {error && <p className="mt-2 text-xs text-brand-danger">{error}</p>}
          <ModalActions>
            <SecondaryButton compact type="button" disabled={busy} onClick={onSignOut}>
              Sign out
            </SecondaryButton>
            <SecondaryButton
              compact
              type="button"
              disabled={busy}
              onClick={() => void resolve(user, { holdsDrawer })}
            >
              Check again
            </SecondaryButton>
            <PrimaryButton
              compact
              type="button"
              disabled={busy}
              onClick={() => setApproving('override_drawer')}
            >
              Supervisor override
            </PrimaryButton>
          </ModalActions>
        </Modal>
        {approving === 'override_drawer' && (
          <SupervisorApprove
            branchId={user?.branchId}
            title="Open a second drawer for this cashier"
            detail="Their other shift stays open and stays their responsibility. Only approve if they really are working two tills."
            onCancel={() => setApproving(null)}
            onApproved={async ({ staffId, name, role }) => {
              setApproving(null)
              // No row of its own carries this sign-off, so it goes to the audit trail —
              // otherwise "why does this cashier hold two drawers" has no answer later.
              void logApprovalEvent({
                branchId: user?.branchId,
                requestedBy: user?.id,
                approvedBy: staffId,
                approverName: name,
                approverRole: role,
                action: 'second_drawer_override',
                detail: `${user?.name || 'Cashier'} allowed a second open drawer`,
                meta: { other_drawer: blocker.drawerLabel || blocker.drawerId || null },
              })
              // Falls through to the normal start flow for this drawer (auto-starts at 0
              // unless today was reopened, same as any other start — see needsFreshCount).
              // The override permits a second shift; it doesn't change this drawer's rules.
              useShiftStore.setState({ gate: 'start', blocker: null })
            }}
          />
        )}
      </>
    )
  }

  return (
    <>
    <Modal>
      <Eyebrow>START SHIFT</Eyebrow>
      <h2 className="mb-1 text-lg">
        {needsFreshCount ? 'Count the drawer after reopening' : 'Start your shift'}
      </h2>
      <p className="m-0 text-xs text-brand-muted">
        {needsFreshCount
          ? `This business day was reopened, so the drawer needs a fresh count. Count the cash in ${drawerLabel || 'the drawer'} and enter it.`
          : holdsDrawer
            ? `Starts with no change fund. Add real cash into ${drawerLabel || 'the drawer'} afterward via POS → Open Drawer → Opening float.`
            : 'Choose your shift window. You are not holding a drawer, so there is no change fund to count.'}
      </p>

      {canChooseDrawer && (
        <div className="mt-3">
          <span className="mb-1.5 block text-[11px] font-medium text-brand-n700">Today you are</span>
          <div className="flex flex-col gap-2">
            {[
              {
                id: 'floor',
                selected: !wantsDrawer,
                title: 'Floor',
                detail: 'Supervising only, no drawer, no change fund',
                onClick: () => setWantsDrawer(false),
              },
              {
                id: 'register',
                selected: wantsDrawer,
                title: 'Working the register',
                detail: 'Holding a drawer this shift, same as a cashier',
                onClick: () => setWantsDrawer(true),
              },
            ].map((opt) => (
              <button
                key={opt.id}
                type="button"
                aria-pressed={opt.selected}
                className={`flex items-center justify-between gap-3 rounded-lg border px-3.5 py-3 text-left transition-colors ${
                  opt.selected
                    ? 'border-brand-success-line bg-brand-success-bg'
                    : 'border-brand-softline bg-brand-card hover:border-brand-ink hover:bg-brand-n50'
                }`}
                onClick={opt.onClick}
              >
                <span className="min-w-0">
                  <strong
                    className={`block text-sm ${opt.selected ? 'text-brand-success-text' : 'text-brand-ink'}`}
                  >
                    {opt.title}
                  </strong>
                  <span className="mt-0.5 block text-[11px] text-brand-subtle">{opt.detail}</span>
                </span>
                {opt.selected && <FiCheck className="shrink-0 text-brand-success-text" size={18} />}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="mt-3 grid grid-cols-2 gap-2">
        {[
          { id: 'am', label: 'AM', hint: 'Morning' },
          { id: 'pm', label: 'PM', hint: 'Afternoon' },
        ].map((opt) => (
          <button
            key={opt.id}
            type="button"
            className={`rounded-[5px] border px-3 py-2.5 text-left transition-colors ${
              shiftPeriod === opt.id
                ? 'border-brand-gold bg-brand-gold text-brand-on-gold'
                : 'border-brand-border bg-brand-card text-brand-ink'
            }`}
            onClick={() => setShiftPeriod(opt.id)}
          >
            <strong className="block text-sm">{opt.label}</strong>
            <span
              className={`mt-0.5 block text-[10px] ${
                shiftPeriod === opt.id ? 'text-brand-on-gold/70' : 'text-brand-subtle'
              }`}
            >
              {opt.hint}
            </span>
          </button>
        ))}
      </div>

      {needsFreshCount && (
        <>
          {carried != null && (
            <div className="mt-3 rounded-md border border-brand-warn-line bg-brand-warn-surface px-3 py-2.5">
              <strong className="block text-[11px] text-brand-warn">Handover</strong>
              <p className="m-0 mt-1 text-[11px] leading-snug text-brand-warn">
                {handoff?.staffName ? `${handoff.staffName} ` : 'The previous shift '}
                cashed out with <strong>{money(carried)}</strong> in this drawer. Count it yourself,
                from here it is your figure.
              </p>
            </div>
          )}
          <Field
            className="mt-3"
            label="Change fund (starting cash)"
            value={amount}
            onChange={(e) => {
              setAmount(decimalOnly(e.target.value))
              setError('')
            }}
            onBlur={(e) => setAmount(formatMoneyOnBlur(e.target.value))}
            inputMode="decimal"
            required
            placeholder="0.00"
          />
          {carried != null && !differsFromCarried && (
            <label className="mt-2 flex items-start gap-2 text-[11px] leading-snug text-brand-muted">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={confirmedCount}
                onChange={(e) => setConfirmedCount(e.target.checked)}
              />
              <span>
                I counted the drawer and it holds {money(carried)}.
              </span>
            </label>
          )}
          {differsFromCarried && (
            <p className="mt-2 text-[11px] text-brand-warn">
              This is {money(Math.abs(amountNumber - Number(carried)))}{' '}
              {amountNumber > Number(carried) ? 'more' : 'less'} than the previous shift left. Your
              count is what counts. Tell a supervisor about the difference.
            </p>
          )}
        </>
      )}

      {error && <p className="mt-2 text-xs text-brand-danger">{error}</p>}
      <ModalActions>
        <SecondaryButton compact type="button" disabled={busy} onClick={onSignOut}>
          Sign out
        </SecondaryButton>
        <PrimaryButton compact type="button" disabled={busy || !canStart} onClick={() => void onStartClick()}>
          {busy ? 'Starting…' : `Start shift · ${shiftPeriod.toUpperCase()}`}
        </PrimaryButton>
      </ModalActions>
    </Modal>
    {confirmNoFund && (
      <Modal onClose={() => !busy && setConfirmNoFund(false)}>
        <Eyebrow>CONFIRM</Eyebrow>
        <h2 className="m-0 text-lg">No change fund?</h2>
        <p className="m-0 mt-2 text-xs text-brand-muted">
          You entered <strong className="text-brand-ink">{money(0)}</strong> as the starting cash in{' '}
          {drawerLabel || 'the drawer'}. Are you sure there is no change fund?
        </p>
        {error && <p className="mt-2 text-xs text-brand-danger">{error}</p>}
        <ModalActions>
          <SecondaryButton compact type="button" disabled={busy} onClick={() => setConfirmNoFund(false)}>
            Go back
          </SecondaryButton>
          <PrimaryButton compact type="button" disabled={busy} onClick={() => void doStart()}>
            {busy ? 'Starting…' : 'Yes, start with no change fund'}
          </PrimaryButton>
        </ModalActions>
      </Modal>
    )}
    </>
  )
}

export default ShiftGate
