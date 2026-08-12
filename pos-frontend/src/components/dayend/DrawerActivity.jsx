import { useEffect, useMemo, useState } from 'react'
import {
  Eyebrow,
  Field,
  Modal,
  ModalActions,
  PrimaryButton,
  SecondaryButton,
  StatusBadge,
  moneyClass,
} from '../ui'
import { reviewCashMovement } from '../../lib/api'
import { formatSupportError } from '../../utils/errors'
import { money } from '../../utils/format'

function statusTone(status) {
  if (status === 'approved' || status === 'remote_approved' || status === 'confirmed') return 'success'
  if (status === 'self_recorded' || status === 'pending_remote') return 'warn'
  if (status === 'flagged_for_investigation' || status === 'denied' || status === 'voided') {
    return 'danger'
  }
  return 'neutral'
}

function statusLabel(status) {
  const map = {
    pending_remote: 'Waiting manager',
    approved: 'Approved',
    remote_approved: 'Approved',
    denied: 'Denied',
    self_recorded: 'Unauthorized',
    confirmed: 'Resolved',
    flagged_for_investigation: 'Flagged',
    voided: 'Cancelled',
  }
  return map[status] || status
}

function formatWhen(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function typeLabel(type) {
  if (type === 'pickup') return 'Pickup'
  if (type === 'cash_in') return 'Cash in'
  if (type === 'opening_float') return 'Opening float'
  return 'Petty cash'
}

function sortMovements(rows) {
  const rank = (s) => {
    if (s === 'self_recorded') return 0
    if (s === 'pending_remote') return 1
    if (s === 'flagged_for_investigation') return 2
    return 3
  }
  return [...rows].sort((a, b) => {
    const d = rank(a.status) - rank(b.status)
    if (d !== 0) return d
    return String(b.requestedAt || '').localeCompare(String(a.requestedAt || ''))
  })
}

/**
 * Day End / End shift Drawer Activity — full ledger of Open Drawer movements.
 * Unauthorized (`self_recorded`) rows must be Confirm/Flag reviewed by a different
 * supervisor/manager before Close day.
 */
export default function DrawerActivity({
  rows = [],
  expectedCash = null,
  canReview = false,
  currentUserId = null,
  onReviewed,
  /** Increment to open the first reviewable unauthorized row (page banner). */
  openReviewNonce = 0,
  /** When false, parent renders the page-top banner instead. */
  showInlineBanner = true,
}) {
  const [reviewing, setReviewing] = useState(null)
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const visible = useMemo(
    () => sortMovements((rows || []).filter((r) => r && r.status !== 'voided')),
    [rows],
  )
  const unreviewed = useMemo(
    () => visible.filter((r) => r.status === 'self_recorded'),
    [visible],
  )
  const reviewableUnreviewed = useMemo(
    () =>
      unreviewed.filter(
        (r) => canReview && r.requestedBy && r.requestedBy !== currentUserId,
      ),
    [unreviewed, canReview, currentUserId],
  )

  const openReview = (row) => {
    if (!row) return
    setError('')
    setNotes('')
    setReviewing(row)
  }

  useEffect(() => {
    if (!openReviewNonce) return
    const next = reviewableUnreviewed[0] || unreviewed[0] || null
    if (next) openReview(next)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openReviewNonce])

  const act = async (action) => {
    if (!reviewing || !currentUserId) return
    if (reviewing.requestedBy === currentUserId) {
      setError('You cannot review your own unauthorized movement — another supervisor or manager must.')
      return
    }
    if (!canReview) {
      setError('Only a supervisor or manager can confirm or flag.')
      return
    }
    setBusy(true)
    setError('')
    try {
      await reviewCashMovement({
        id: reviewing.id,
        reviewedBy: currentUserId,
        action,
        notes,
      })
      setReviewing(null)
      setNotes('')
      onReviewed?.()
    } catch (err) {
      setError(formatSupportError(err, 'MOVE19'))
    } finally {
      setBusy(false)
    }
  }

  const bannerText =
    unreviewed.length === 1
      ? '1 unapproved cash movement requires manager review before this session can close.'
      : `${unreviewed.length} unapproved cash movements require manager review before this session can close.`

  return (
    <div className="mb-3.5 overflow-hidden rounded-md border border-brand-softline">
      <div className="border-b border-brand-softline px-3 py-2.5">
        <strong className="block text-xs text-brand-ink">Drawer Activity</strong>
        <p className="m-0 text-[11px] text-brand-subtle">
          Every petty cash and pickup from POS → Open Drawer (amount, reason, who requested,
          who approved). Unauthorized rows must be Confirmed or Flagged before Close day.
        </p>
      </div>

      {showInlineBanner && unreviewed.length > 0 && (
        <button
          type="button"
          className={`block w-full border-0 border-b border-brand-warn px-3 py-2.5 text-left text-xs font-bold text-brand-warn ${
            canReview && reviewableUnreviewed.length
              ? 'cursor-pointer bg-brand-warn-bg hover:brightness-95'
              : 'cursor-default bg-brand-warn-bg'
          }`}
          onClick={() => {
            if (!canReview || !reviewableUnreviewed.length) return
            openReview(reviewableUnreviewed[0])
          }}
        >
          {bannerText}
          {canReview && reviewableUnreviewed.length ? (
            <span className="mt-0.5 block text-[10px] font-normal">Tap to review</span>
          ) : canReview && unreviewed.length && !reviewableUnreviewed.length ? (
            <span className="mt-0.5 block text-[10px] font-normal">
              Another supervisor/manager must review — you requested one of these.
            </span>
          ) : (
            <span className="mt-0.5 block text-[10px] font-normal">
              Supervisor or manager will Confirm or Flag at day end.
            </span>
          )}
        </button>
      )}

      {visible.length === 0 ? (
        <p className="m-0 px-3 py-4 text-xs text-brand-subtle">No drawer movements this session yet.</p>
      ) : (
        <ul className="m-0 list-none p-0">
          {visible.map((row) => {
            const reviewable =
              canReview &&
              row.status === 'self_recorded' &&
              row.requestedBy &&
              row.requestedBy !== currentUserId
            const ownUnauthorized =
              row.status === 'self_recorded' && row.requestedBy === currentUserId
            const approver =
              row.reviewedByName || row.approvedByName || row.deniedByName || null
            const RowTag = reviewable ? 'button' : 'div'
            return (
              <RowTag
                key={row.id}
                type={reviewable ? 'button' : undefined}
                className={`block w-full border-t border-brand-softline px-3 py-3 text-left ${
                  reviewable
                    ? 'cursor-pointer bg-brand-warn-bg/50 hover:bg-brand-warn-bg'
                    : row.status === 'self_recorded'
                      ? 'bg-brand-warn-bg/30'
                      : 'bg-transparent'
                }`}
                onClick={reviewable ? () => openReview(row) : undefined}
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                      <span className="text-[11px] text-brand-muted">{formatWhen(row.requestedAt)}</span>
                      <strong className="text-sm text-brand-ink">{typeLabel(row.type)}</strong>
                      <strong className={`text-sm ${moneyClass}`}>{money(row.amount)}</strong>
                    </div>
                    <p className="m-0 mt-1 text-xs text-brand-ink break-words">
                      <span className="font-bold text-brand-subtle">Reason: </span>
                      {row.reason?.trim() ? row.reason : '—'}
                    </p>
                    <p className="m-0 mt-1 text-[11px] text-brand-muted">
                      Requested by {row.requestedByName || '—'}
                      {row.drawerLabel || row.drawerId
                        ? ` · ${row.drawerLabel || row.drawerId}`
                        : ''}
                    </p>
                    {approver && (
                      <p className="m-0 mt-0.5 text-[11px] text-brand-muted">
                        {row.status === 'denied'
                          ? 'Denied by'
                          : row.reviewedByName
                            ? 'Reviewed by'
                            : 'Approved by'}{' '}
                        {approver}
                        {row.reviewedAt || row.approvedAt || row.deniedAt
                          ? ` · ${formatWhen(row.reviewedAt || row.approvedAt || row.deniedAt)}`
                          : ''}
                      </p>
                    )}
                    {ownUnauthorized && (
                      <p className="m-0 mt-1 text-[10px] font-bold text-brand-warn">
                        Waiting for another supervisor/manager to Confirm or Flag
                      </p>
                    )}
                  </div>
                  <StatusBadge compact tone={statusTone(row.status)}>
                    {statusLabel(row.status)}
                  </StatusBadge>
                </div>
                {reviewable && (
                  <span className="mt-1.5 block text-[10px] font-bold text-brand-warn">
                    Tap to Mark Resolved or Flag for investigation
                  </span>
                )}
              </RowTag>
            )
          })}
        </ul>
      )}

      {expectedCash != null && (
        <div className="flex items-center justify-between border-t border-brand-softline bg-brand-n50 px-3 py-2.5 text-xs">
          <span className="text-brand-subtle">Expected in drawer (sales ± movements)</span>
          <strong className={moneyClass}>{money(expectedCash)}</strong>
        </div>
      )}

      {reviewing && (
        <Modal onClose={() => !busy && setReviewing(null)}>
          <Eyebrow>UNAUTHORIZED MOVEMENT</Eyebrow>
          <h2 className="m-0 mb-3 text-lg">Review unauthorized movement</h2>

          <div className="mb-3 rounded-lg border border-brand-softline bg-brand-n50 px-3.5 py-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <strong className="block text-sm text-brand-ink">{typeLabel(reviewing.type)}</strong>
                <span className="mt-0.5 block text-[11px] text-brand-muted">
                  {formatWhen(reviewing.requestedAt)}
                  {' · '}
                  {reviewing.requestedByName || 'Cashier'}
                </span>
              </div>
              <strong className={`shrink-0 text-base text-brand-ink ${moneyClass}`}>
                {money(reviewing.amount)}
              </strong>
            </div>
            <div className="mt-2.5 border-t border-brand-softline pt-2.5">
              <span className="block text-[10px] font-bold tracking-wide text-brand-subtle uppercase">
                Reason
              </span>
              <p className="m-0 mt-0.5 text-sm text-brand-ink">{reviewing.reason || '—'}</p>
            </div>
          </div>

          {reviewing.requestedBy === currentUserId && (
            <p className="mb-3 text-xs text-brand-danger">
              You cannot review your own request. Ask another supervisor or manager.
            </p>
          )}
          <Field
            label="Review notes (optional)"
            value={notes}
            onChange={(e) => setNotes(e.target.value.replace(/[<>]/g, '').slice(0, 300))}
          />
          {error && <p className="mt-2 text-xs text-brand-danger">{error}</p>}
          <ModalActions className="!flex-col !items-stretch !justify-stretch gap-2.5">
            <PrimaryButton
              type="button"
              className="w-full"
              disabled={
                busy ||
                reviewing.requestedBy === currentUserId ||
                !canReview
              }
              onClick={() => void act('confirmed')}
            >
              {busy ? 'Saving…' : 'Mark Resolved'}
            </PrimaryButton>
            <div className="grid grid-cols-2 gap-2">
              <SecondaryButton
                compact
                type="button"
                className="w-full"
                disabled={busy}
                onClick={() => setReviewing(null)}
              >
                Cancel
              </SecondaryButton>
              <SecondaryButton
                compact
                type="button"
                className="w-full !border-brand-danger !text-brand-danger"
                disabled={
                  busy ||
                  reviewing.requestedBy === currentUserId ||
                  !canReview
                }
                onClick={() => void act('flagged_for_investigation')}
              >
                Flag
              </SecondaryButton>
            </div>
          </ModalActions>
        </Modal>
      )}
    </div>
  )
}

export function unapprovedMovementBannerText(count) {
  if (count <= 0) return ''
  if (count === 1) {
    return '1 unapproved cash movement requires manager review before this session can close.'
  }
  return `${count} unapproved cash movements require manager review before this session can close.`
}
