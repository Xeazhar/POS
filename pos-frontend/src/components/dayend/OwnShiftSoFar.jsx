import { useEffect, useMemo, useState } from 'react'
import DrawerActivity from './DrawerActivity'
import ShiftCashOut from '../shared/ShiftCashOut'
import { PrimaryButton, TableCard, moneyClass } from '../ui'
import { useInventoryStore } from '../../stores/posStore'
import { cashPositionNotice, useShiftStore } from '../../stores/shiftStore'
import { money } from '../../utils/format'

/**
 * Formats a shift timestamp as a localized abbreviated date and time.
 * @param {string|number|Date} iso - The timestamp to format.
 * @return {string} The localized date and time, or `—` for a missing or invalid timestamp.
 */
function formatShiftWhen(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

/**
 * Formats the elapsed time between shift start and end times.
 * @param {string|Date|number} clockIn - The shift start timestamp.
 * @param {string|Date|number|null} [clockOut=null] - The shift end timestamp, or the current time when omitted.
 * @param {number} [nowMs=Date.now()] - The timestamp used as the current time when the shift is active.
 * @return {string} The elapsed duration in minutes or hours and minutes, or `—` for missing, invalid, or reversed timestamps.
 */
function formatShiftDuration(clockIn, clockOut = null, nowMs = Date.now()) {
  if (!clockIn) return '—'
  const start = new Date(clockIn).getTime()
  const end = clockOut ? new Date(clockOut).getTime() : nowMs
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return '—'
  const mins = Math.round((end - start) / 60000)
  const h = Math.floor(mins / 60)
  return h <= 0 ? `${mins}m` : `${h}h ${String(mins % 60).padStart(2, '0')}m`
}

/**
 * Display the current user's shift timing, cash position, drawer activity, and shift-ending controls.
 * @param {Object} user - The current user.
 * @param {Array} movements - Drawer movements to filter to the active shift or current user.
 * @param {Function} onReload - Callback invoked after drawer activity is reviewed.
 * @param {Function} onShiftEnded - Callback invoked after the shift ends.
 * @param {boolean} showDrawerActivity - Whether to display drawer activity.
 * @param {string} drawerTitle - Title shown above drawer activity.
 * @param {string} drawerSubtitle - Subtitle shown above drawer activity.
 */
export default function OwnShiftSoFar({
  user,
  movements = [],
  onReload,
  onShiftEnded,
  showDrawerActivity = true,
  drawerTitle = 'Drawer Activity',
  drawerSubtitle = "Today's petty cash and pickups from POS → Open Drawer (your shift only).",
}) {
  const shift = useShiftStore((state) => state.shift)
  const syncShiftServerId = useShiftStore((state) => state.syncShiftServerId)
  const cashPosition = useShiftStore((state) => state.cashPosition)
  const transactions = useInventoryStore((state) => state.transactions)

  const [position, setPosition] = useState(null)
  const [cashOutOpen, setCashOutOpen] = useState(false)
  const [nowMs, setNowMs] = useState(() => Date.now())

  useEffect(() => {
    void syncShiftServerId?.().catch(() => {})
  }, [syncShiftServerId, shift?.clientId])

  useEffect(() => {
    if (!shift) return undefined
    const t = window.setInterval(() => setNowMs(Date.now()), 30000)
    return () => window.clearInterval(t)
  }, [shift])

  useEffect(() => {
    let active = true
    if (!shift) {
      setPosition(null)
      return undefined
    }
    cashPosition()
      .then((result) => {
        if (active) setPosition(result)
      })
      .catch(() => {
        if (active) setPosition(null)
      })
    return () => {
      active = false
    }
  }, [shift, cashPosition, movements, transactions])

  const myMovements = useMemo(() => {
    const sid = shift?.serverId || shift?.id || null
    return movements.filter((m) => {
      if (!m) return false
      if (sid && m.shiftId === sid) return true
      if (user?.id && m.requestedBy === user.id) return true
      return false
    })
  }, [movements, shift, user?.id])

  const cashDiscounts = useMemo(() => {
    if (!shift) return 0
    return transactions
      .filter(
        (row) =>
          (row.shiftClientId && row.shiftClientId === shift.clientId) ||
          (shift.serverId && row.shiftId === shift.serverId),
      )
      .filter((row) => row.status === 'Paid' && (row.paymentMethod || 'cash') === 'cash')
      .reduce((sum, row) => sum + Number(row.discountAmount || 0), 0)
  }, [transactions, shift])

  const expected = position ? Number(position.expectedCash || 0) : null
  const cashSalesGross = position
    ? Number((Number(position.cashSales || 0) + cashDiscounts).toFixed(2))
    : null
  const shiftNotice = cashPositionNotice(position)
  const holdsDrawer = shift?.holdsDrawer !== false

  return (
    <>
      <TableCard className="mb-3.5 max-h-none p-5">
        <h2 className="m-0 mb-1 text-base">Your shift so far</h2>
        <p className="m-0 mb-3 text-xs text-brand-muted">
          These figures cover YOUR shift only — the drawer itself is counted once for the
          whole business day, at Day End, not per shift. If another shift used this drawer
          today too, Day End&apos;s &quot;Expected in drawer&quot; covers the whole day and will not match
          this total; that is expected, not an error.
        </p>
        {!shift ? (
          <p className="m-0 text-xs text-brand-subtle">No open shift on this terminal.</p>
        ) : (
          <>
            <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
              <div className="rounded-md bg-brand-n100 px-3 py-2.5">
                <span className="block text-[10px] text-brand-subtle">Started</span>
                <strong className="text-sm text-brand-ink">{formatShiftWhen(shift.clockIn)}</strong>
              </div>
              <div className="rounded-md bg-brand-n100 px-3 py-2.5">
                <span className="block text-[10px] text-brand-subtle">On shift</span>
                <strong className="text-sm text-brand-ink">
                  {formatShiftDuration(shift.clockIn, null, nowMs)}
                </strong>
              </div>
              <div className="rounded-md bg-brand-n100 px-3 py-2.5">
                <span className="block text-[10px] text-brand-subtle">Drawer</span>
                <strong className="truncate text-sm text-brand-ink">
                  {holdsDrawer ? shift.drawerLabel || shift.drawerId || '—' : 'Floor (no till)'}
                </strong>
              </div>
              <div className="rounded-md bg-brand-n100 px-3 py-2.5">
                <span className="block text-[10px] text-brand-subtle">Period</span>
                <strong className="text-sm text-brand-ink uppercase">
                  {shift.shiftPeriod || '—'}
                </strong>
              </div>
            </div>
            {holdsDrawer ? (
              <div className="grid grid-cols-[1fr_auto] gap-x-[18px] gap-y-1.5 rounded-md border border-brand-softline px-3.5 py-3 text-[13px]">
                <span className="text-brand-subtle">Change fund in</span>
                <strong className={`text-right ${moneyClass}`}>
                  {money(position?.startingCash ?? shift.startingCash)}
                </strong>
                <span className="text-brand-subtle">+ Cash sales</span>
                <strong className={`text-right ${moneyClass}`}>{money(position?.cashSales)}</strong>
                {cashDiscounts > 0 && (
                  <span className="col-span-2 -mt-1 text-[11px] text-brand-subtle">
                    ({money(cashSalesGross)} before discounts − {money(cashDiscounts)} in
                    discounts — already reflected in Cash sales above, not deducted again)
                  </span>
                )}
                {Number(position?.cashRefunds || 0) > 0 && (
                  <>
                    <span className="text-brand-subtle">− Refunds / voids</span>
                    <strong className={`text-right ${moneyClass}`}>
                      −{money(position?.cashRefunds)}
                    </strong>
                  </>
                )}
                <span className="text-brand-subtle">− Petty cash (handed over)</span>
                <strong className={`text-right ${moneyClass}`}>
                  −{money(position?.cashPaidOut)}
                </strong>
                <span className="text-brand-subtle">− Pickups to safe</span>
                <strong className={`text-right ${moneyClass}`}>
                  −{money(position?.cashPickups)}
                </strong>
                <span className="border-t border-brand-softline pt-1.5 font-bold">
                  = Drawer should hold
                </span>
                <strong
                  className={`border-t border-brand-softline pt-1.5 text-right font-bold ${moneyClass}`}
                >
                  {expected == null ? '—' : money(expected)}
                </strong>
              </div>
            ) : (
              <div className="rounded-md border border-brand-softline px-3.5 py-3 text-[13px]">
                <span className="text-brand-subtle">Cash sales on your shift</span>
                <strong className={`mt-1 block text-right text-base ${moneyClass}`}>
                  {money(position?.cashSales)}
                </strong>
                {cashDiscounts > 0 && (
                  <p className="m-0 mt-2 text-[11px] text-brand-subtle">
                    ({money(cashSalesGross)} before discounts — net figure above)
                  </p>
                )}
              </div>
            )}
            {shiftNotice && (
              <p
                className={`mt-3 rounded-md px-2.5 py-2 text-[11px] ${
                  shiftNotice.tone === 'warn'
                    ? 'bg-brand-warn-bg text-brand-warn'
                    : 'bg-brand-n50 text-brand-muted'
                }`}
              >
                {shiftNotice.text}
              </p>
            )}
            <PrimaryButton compact type="button" className="mt-3" onClick={() => setCashOutOpen(true)}>
              End shift
            </PrimaryButton>
          </>
        )}
      </TableCard>

      {showDrawerActivity && (
        <DrawerActivity
          rows={myMovements}
          expectedCash={holdsDrawer ? expected : null}
          canReview={false}
          currentUserId={user?.id}
          onReviewed={onReload}
          title={drawerTitle}
          subtitle={drawerSubtitle}
        />
      )}

      {cashOutOpen && shift && (
        <ShiftCashOut
          user={user}
          shift={shift}
          onCancel={() => setCashOutOpen(false)}
          onDone={() => {
            setCashOutOpen(false)
            onShiftEnded?.()
          }}
        />
      )}
    </>
  )
}
