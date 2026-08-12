import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Eyebrow, Field, Modal, ModalActions, PrimaryButton, SecondaryButton } from '../ui'
import SupervisorApprove from './SupervisorApprove'
import { logApprovalEvent } from '../../lib/api'
import { useInventoryStore } from '../../stores/posStore'
import { useShiftStore } from '../../stores/shiftStore'
import { formatSupportError } from '../../utils/errors'
import { businessDate, dayEndForBusinessDate, isDayFullyClosed, money } from '../../utils/format'
import { decimalOnly } from '../../utils/validate'

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
 *   start        — count the change fund into the drawer (the routine case) — UNLESS
 *                  today's business day is already closed (see `dayClosed` below).
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
function ShiftGate({ user, holdsDrawer = true, onSignOut }) {
  const navigate = useNavigate()
  const gate = useShiftStore((state) => state.gate)
  const blocker = useShiftStore((state) => state.blocker)
  const handoff = useShiftStore((state) => state.handoff)
  const drawerLabel = useShiftStore((state) => state.drawerLabel)
  const startShift = useShiftStore((state) => state.startShift)
  const resolve = useShiftStore((state) => state.resolve)
  const dayEnds = useInventoryStore((state) => state.dayEnds)
  const dayOpenHour = useInventoryStore((state) => state.dayOpenHour)
  const requestDayReopen = useInventoryStore((state) => state.requestDayReopen)
  // A closed business day has already been counted and filed — a NEW change fund entering
  // the drawer after that is cash a supervisor's Z-reading never saw, an instant
  // discrepancy nobody can explain later. Only gates the cashier's own change-fund count;
  // a supervisor floor shift (holdsDrawer false) never touches cash, so it is unaffected.
  const todayEntry = dayEndForBusinessDate(dayEnds, businessDate(new Date(), dayOpenHour))
  const dayClosed = holdsDrawer && isDayFullyClosed(dayEnds, dayOpenHour)
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
    if (!holdsDrawer) return true
    if (!amountValid) return false
    // Adjusting the figure is itself a statement that they counted, so the tick is only
    // demanded when they are accepting the previous shift's number unchanged.
    if (carried != null && !differsFromCarried) return confirmedCount
    return true
  }, [holdsDrawer, amountValid, carried, differsFromCarried, confirmedCount])

  const doStart = async (opts = {}) => {
    setBusy(true)
    setError('')
    try {
      await startShift(user, {
        startingCash: holdsDrawer ? amountNumber : 0,
        shiftPeriod,
        carriedFrom: differsFromCarried ? null : handoff,
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

  const onStartClick = () => {
    if (holdsDrawer && amountNumber === 0) {
      setConfirmNoFund(true)
      return
    }
    void doStart()
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
    if (!holdsDrawer) {
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
            Reopen requested — waiting on a manager.
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
            holds cash you are answerable for, so this terminal cannot simply take over — go back
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
              // Falls through to the normal start screen, which still demands a count for
              // this drawer — the override permits a second shift, it does not skip cash.
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
        {holdsDrawer ? 'Count your change fund' : 'Start your shift'}
      </h2>
      <p className="m-0 text-xs text-brand-muted">
        {holdsDrawer
          ? `Count the cash in ${drawerLabel || 'the drawer'} and enter it. This is asked once per shift — signing out and back in will not ask again.`
          : 'Choose your shift window. You are not holding a drawer, so there is no change fund to count.'}
      </p>

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
                ? 'border-brand-dark bg-brand-dark text-white'
                : 'border-brand-border bg-white text-brand-ink'
            }`}
            onClick={() => setShiftPeriod(opt.id)}
          >
            <strong className="block text-sm">{opt.label}</strong>
            <span
              className={`mt-0.5 block text-[10px] ${
                shiftPeriod === opt.id ? 'text-white/70' : 'text-brand-subtle'
              }`}
            >
              {opt.hint}
            </span>
          </button>
        ))}
      </div>

      {holdsDrawer && (
        <>
          {carried != null && (
            <div className="mt-3 rounded-md border border-brand-warn-line bg-brand-warn-surface px-3 py-2.5">
              <strong className="block text-[11px] text-brand-warn">Handover</strong>
              <p className="m-0 mt-1 text-[11px] leading-snug text-brand-warn">
                {handoff?.staffName ? `${handoff.staffName} ` : 'The previous shift '}
                cashed out with <strong>{money(carried)}</strong> in this drawer. Count it yourself —
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
              count is what counts — tell a supervisor about the difference.
            </p>
          )}
        </>
      )}

      {error && <p className="mt-2 text-xs text-brand-danger">{error}</p>}
      <ModalActions>
        <SecondaryButton compact type="button" disabled={busy} onClick={onSignOut}>
          Sign out
        </SecondaryButton>
        <PrimaryButton compact type="button" disabled={busy || !canStart} onClick={onStartClick}>
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
