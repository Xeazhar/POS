import { useState } from 'react'
import {
  Field,
  PrimaryButton,
  SecondaryButton,
  StatusBadge,
  TableCard,
  moneyClass,
} from '../ui'
import {
  approvePettyCash,
  approverLabel,
  fulfillPettyCash,
  hasSupabase,
  rejectPettyCash,
  requestPettyCash,
} from '../../lib/api'
import { formatSupportError } from '../../utils/errors'
import { money } from '../../utils/format'
import { decimalOnly } from '../../utils/validate'

/**
 * Petty cash, in three states rather than two.
 *
 *   Request    a cashier asks. Nothing has moved; low risk, so anyone can do it.
 *   Approve    supervisor-or-above authorises. Still nothing has moved.
 *   Fulfil     the cash is physically handed over. THIS is the disbursement.
 *
 * The approve step is gated by ROLE, not by a named person — a manager on their own device
 * already satisfies "supervisor or above", which is why there is no escalation branch here
 * for "the supervisor is out". Fulfilment deliberately is not gated: whoever is on site
 * hands the money over, including the cashier who asked, because the authorisation has
 * already happened. `fulfillPettyCash` will only move a row that is already `approved`,
 * and a DB check constraint enforces the same thing.
 */
function PettyCashPanel({
  rows = [],
  user,
  businessDate,
  shiftId = null,
  branchId,
  canApprove = false,
  canRequest = true,
  locked = false,
  scope = 'branch', // 'mine' = this cashier's own requests only
  onChanged,
}) {
  const [amount, setAmount] = useState('')
  const [reason, setReason] = useState('')
  const [receipt, setReceipt] = useState('')
  const [error, setError] = useState('')
  const [busyId, setBusyId] = useState(null)
  const [submitting, setSubmitting] = useState(false)

  const pending = rows.filter((row) => row.status === 'pending')
  const approved = rows.filter((row) => row.status === 'approved')
  const fulfilled = rows.filter((row) => row.status === 'fulfilled')
  const rejected = rows.filter((row) => row.status === 'rejected')

  // Only fulfilled money has actually left the drawer. Approved-but-unfulfilled is a
  // commitment, not a disbursement, and must not be deducted from the expected cash.
  const fulfilledTotal = fulfilled.reduce((sum, row) => sum + Number(row.amount || 0), 0)
  const approvedTotal = approved.reduce((sum, row) => sum + Number(row.amount || 0), 0)

  const run = async (id, fn, code) => {
    setBusyId(id)
    setError('')
    try {
      await fn()
      await onChanged?.()
    } catch (err) {
      setError(formatSupportError(err, code))
    } finally {
      setBusyId(null)
    }
  }

  const submitRequest = async () => {
    setSubmitting(true)
    setError('')
    try {
      if (hasSupabase && branchId) {
        await requestPettyCash({
          branchId,
          staffId: user?.id,
          amount: Number(amount),
          reason: reason.trim(),
          receiptRef: receipt.trim(),
          businessDate,
          shiftId,
        })
        await onChanged?.()
      }
      setAmount('')
      setReason('')
      setReceipt('')
    } catch (err) {
      setError(formatSupportError(err, 'PETTY01'))
    } finally {
      setSubmitting(false)
    }
  }

  const who = (row) => {
    const bits = []
    if (row.requestedByName || row.staffName) bits.push(`Asked by ${row.requestedByName || row.staffName}`)
    const appr = approverLabel(row.approvedByName, row.approvedByRole)
    if (appr) bits.push(`Approved by ${appr}`)
    if (row.confirmedByName) bits.push(`Handed over by ${row.confirmedByName}`)
    return bits.join(' · ')
  }

  const Row = ({ row, children }) => (
    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-brand-softline py-2 text-xs first:border-t-0">
      <div className="min-w-0">
        <strong className={`block text-brand-ink ${moneyClass}`}>{money(row.amount)}</strong>
        <span className="text-brand-muted">{row.reason || '—'}</span>
        {row.receiptRef ? (
          <span className="mt-0.5 block text-[10px] text-brand-subtle">Ref: {row.receiptRef}</span>
        ) : null}
        {who(row) ? (
          <span className="mt-0.5 block text-[10px] text-brand-subtle">{who(row)}</span>
        ) : null}
        {row.rejectReason ? (
          <span className="mt-0.5 block text-[10px] text-brand-danger">
            Rejected: {row.rejectReason}
          </span>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  )

  return (
    <TableCard className="mb-3.5 max-h-none p-5">
      <h2 className="m-0 mb-1 text-base">Petty cash (paid-out)</h2>
      <p className="m-0 mb-3 text-xs text-brand-muted">
        {scope === 'mine'
          ? 'Your own requests. A supervisor or manager approves, then whoever is on the floor marks the cash as handed over.'
          : 'Request → approve (supervisor or above) → hand over. Only cash actually handed over is deducted from the expected drawer.'}
      </p>

      {canRequest && !locked && (
        <div className="mb-3 grid grid-cols-[1fr_1.2fr_1fr_auto] gap-2 max-[900px]:grid-cols-1">
          <Field
            label="Amount"
            value={amount}
            onChange={(e) => setAmount(decimalOnly(e.target.value))}
            inputMode="decimal"
            required
          />
          <Field
            label="Reason"
            value={reason}
            onChange={(e) => setReason(e.target.value.replace(/[<>]/g, ''))}
            required
            placeholder="e.g. Cleaning supplies"
          />
          <Field
            label="Receipt / ref"
            value={receipt}
            onChange={(e) => setReceipt(e.target.value.replace(/[<>]/g, ''))}
            placeholder="Optional receipt #"
          />
          <div className="flex items-end">
            <PrimaryButton
              compact
              type="button"
              disabled={submitting || !amount || Number(amount) <= 0 || !reason.trim()}
              onClick={() => void submitRequest()}
            >
              {submitting ? 'Sending…' : 'Request'}
            </PrimaryButton>
          </div>
        </div>
      )}

      {error && <p className="mb-2 text-xs text-brand-danger">{error}</p>}

      {pending.length > 0 && (
        <div className="mb-3">
          <p className="m-0 mb-1 text-[11px] font-bold text-brand-warn">
            {canApprove ? `Awaiting your approval (${pending.length})` : `Awaiting approval (${pending.length})`}
          </p>
          {pending.map((row) => (
            <Row key={row.id} row={row}>
              {canApprove && !locked ? (
                <>
                  <SecondaryButton
                    compact
                    type="button"
                    disabled={busyId === row.id}
                    onClick={() =>
                      run(row.id, () => rejectPettyCash({ id: row.id, approvedBy: user.id }), 'PETTY02')
                    }
                  >
                    Reject
                  </SecondaryButton>
                  <PrimaryButton
                    compact
                    type="button"
                    disabled={busyId === row.id}
                    onClick={() =>
                      run(row.id, () => approvePettyCash({ id: row.id, approvedBy: user.id }), 'PETTY02')
                    }
                  >
                    Approve
                  </PrimaryButton>
                </>
              ) : (
                <StatusBadge compact tone="warn">
                  Pending
                </StatusBadge>
              )}
            </Row>
          ))}
        </div>
      )}

      {approved.length > 0 && (
        <div className="mb-3">
          <p className="m-0 mb-1 text-[11px] font-bold text-brand-ink">
            Approved — cash not handed over yet ({approved.length} · {money(approvedTotal)})
          </p>
          {approved.map((row) => (
            <Row key={row.id} row={row}>
              {!locked ? (
                <PrimaryButton
                  compact
                  type="button"
                  disabled={busyId === row.id}
                  title="Confirm the cash has physically left the drawer"
                  onClick={() =>
                    run(row.id, () => fulfillPettyCash({ id: row.id, confirmedBy: user.id }), 'PETTY03')
                  }
                >
                  Mark handed over
                </PrimaryButton>
              ) : (
                <StatusBadge compact tone="neutral">
                  Approved
                </StatusBadge>
              )}
            </Row>
          ))}
        </div>
      )}

      <p className="mb-2 text-xs text-brand-muted">
        Handed over today: <strong>{money(fulfilledTotal)}</strong>
        {approvedTotal > 0 ? ` · approved but still in the drawer ${money(approvedTotal)}` : ''}
      </p>
      {fulfilled.length === 0 ? (
        <p className="text-xs text-brand-subtle">No cash handed over yet.</p>
      ) : (
        fulfilled.map((row) => (
          <Row key={row.id} row={row}>
            <StatusBadge compact tone="success">
              Handed over
            </StatusBadge>
          </Row>
        ))
      )}

      {rejected.length > 0 && (
        <div className="mt-3">
          <p className="m-0 mb-1 text-[11px] font-bold text-brand-subtle">
            Rejected ({rejected.length})
          </p>
          {rejected.map((row) => (
            <Row key={row.id} row={row}>
              <StatusBadge compact tone="danger">
                Rejected
              </StatusBadge>
            </Row>
          ))}
        </div>
      )}
    </TableCard>
  )
}

export default PettyCashPanel
