import { useMemo, useState } from 'react'
import { Eyebrow, Field, Modal, ModalActions, PrimaryButton, SecondaryButton } from '../ui'
import SupervisorApprove from './SupervisorApprove'
import { logApprovalEvent } from '../../lib/api'
import { useShiftStore } from '../../stores/shiftStore'
import { formatSupportError } from '../../utils/errors'
import { money } from '../../utils/format'
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
 * Blocks everything until this terminal has a shift to sell under.
 *
 * It is shown for exactly one reason at a time, and each reason has a different remedy:
 *   start — count the change fund into the drawer (the only routine case)
 *   moved — this cashier is open on another till, so their cash is somewhere else
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
  const gate = useShiftStore((state) => state.gate)
  const blocker = useShiftStore((state) => state.blocker)
  const handoff = useShiftStore((state) => state.handoff)
  const drawerLabel = useShiftStore((state) => state.drawerLabel)
  const startShift = useShiftStore((state) => state.startShift)
  const resolve = useShiftStore((state) => state.resolve)

  const carried = handoff?.endingCash

  const [shiftPeriod, setShiftPeriod] = useState(defaultShiftPeriod)
  const [amount, setAmount] = useState('')
  const [confirmedCount, setConfirmedCount] = useState(false)
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
    } catch (err) {
      setError(formatSupportError(err, 'SHIFT01'))
    } finally {
      setBusy(false)
    }
  }

  // Just cashed out on this session. No "Check again" or override here on purpose —
  // the only way off this screen is to sign out, so the next person to touch the till
  // has to authenticate as themselves before counting cash into it.
  if (gate === 'ended') {
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
          Sign out before handing the terminal to the next cashier.
        </p>
        {error && <p className="mt-2 text-xs text-brand-danger">{error}</p>}
        <ModalActions>
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
        <PrimaryButton compact type="button" disabled={busy || !canStart} onClick={() => void doStart()}>
          {busy ? 'Starting…' : `Start shift · ${shiftPeriod.toUpperCase()}`}
        </PrimaryButton>
      </ModalActions>
    </Modal>
  )
}

export default ShiftGate
