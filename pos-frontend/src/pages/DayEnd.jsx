import { useEffect, useMemo, useState } from 'react'
import { DayEndReportPanels } from '../components/dayend/DayEndReportPanels'
import PettyCashPanel from '../components/dayend/PettyCashPanel'
import ShiftCashOut from '../components/shared/ShiftCashOut'
import {
  Eyebrow,
  Field,
  Modal,
  ModalActions,
  PageHeader,
  PageSkeleton,
  PrimaryButton,
  SecondaryButton,
  StatusBadge,
  TableCard,
  moneyClass,
  tableRowClass,
  varianceToneClass,
} from '../components/ui'
import { addPettyCash, fetchPettyCash, fetchStaffShifts, hasSupabase } from '../lib/api'
import { useAuthStore, useInventoryStore, useProductStore } from '../stores/posStore'
import { useShiftStore } from '../stores/shiftStore'
import { buildDayEndReport } from '../utils/dayEndReport'
import { formatSupportError } from '../utils/errors'
import { businessDate, dayEndForBusinessDate, formatOpenHourLabel, money } from '../utils/format'
import { isSupervisorOrAbove } from '../utils/roles'
import { decimalOnly } from '../utils/validate'

const rowKind = (row) =>
  row.kind ||
  (String(row.reason || '').startsWith('[CHANGE FUND]')
    ? 'change_fund'
    : String(row.reason || '').startsWith('[PICKUP]')
      ? 'pickup'
      : 'paid_out')

const rowStatus = (row) => row.status || (rowKind(row) === 'paid_out' ? 'fulfilled' : 'recorded')

const FUND_GRID =
  'grid-cols-[minmax(0,1.3fr)_minmax(0,0.9fr)_minmax(0,0.8fr)_minmax(0,0.75fr)_minmax(0,0.75fr)_minmax(0,0.75fr)]'
const FUND_GRID_NARROW = 'max-[700px]:grid-cols-[minmax(0,1.3fr)_minmax(0,0.8fr)_minmax(0,0.8fr)]'

/**
 * Shift state as a badge, separate from the drawer name.
 *
 * "main · open now" forced a supervisor to read a drawer id and a lifecycle state out of
 * one string. A shift that ended without a count is NOT a normal close and must not
 * render the same as one — that is the row someone has to chase.
 */
function shiftStatusBadge(row) {
  if (row.open) return { label: 'Open', tone: 'success', hint: 'Cashier is on this drawer now' }
  if (row.holdsDrawer !== false && row.endingCash == null) {
    return { label: 'Pending handoff', tone: 'warn', hint: 'Shift ended without a drawer count' }
  }
  return { label: 'Closed', tone: 'neutral', hint: 'Counted and cashed out' }
}

/**
 * Day end / End shift.
 *
 * One route, two screens, because these are two different jobs done by two different
 * people. A cashier closing their own till has no business seeing another cashier's
 * drawer figures — the old shared screen listed every shift's change fund to everyone
 * standing at the counter, which is both a privacy leak and a way to learn what a
 * supervisor's float looks like. Supervisor+ keeps the branch-wide view.
 */
function DayEnd() {
  const user = useAuthStore((state) => state.user)
  return isSupervisorOrAbove(user?.role) ? <SupervisorDayEnd /> : <CashierEndShift />
}

/* ────────────────────────────────────────────────────────────────────────────
   Shared data hook — both views read the same two sources.
   ──────────────────────────────────────────────────────────────────────────── */
function useDayEndData(user, date) {
  const [petty, setPetty] = useState([])
  const [shifts, setShifts] = useState([])
  const [loading, setLoading] = useState(Boolean(hasSupabase && user?.branchId))

  const reload = async () => {
    if (!hasSupabase || !user?.branchId) {
      setPetty([])
      setShifts([])
      return
    }
    const [pettyRows, shiftRows] = await Promise.all([
      fetchPettyCash(user.branchId, date).catch(() => []),
      fetchStaffShifts({ branchId: user.branchId, start: date, end: date }).catch(() => []),
    ])
    setPetty(pettyRows || [])
    setShifts(shiftRows || [])
  }

  useEffect(() => {
    let active = true
    if (!hasSupabase || !user?.branchId) {
      setPetty([])
      setShifts([])
      setLoading(false)
      return undefined
    }
    setLoading(true)
    reload()
      .catch(() => {})
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.branchId, date])

  return { petty, shifts, loading, reload }
}

/* ────────────────────────────────────────────────────────────────────────────
   CASHIER — "End shift"
   Own drawer only. No aggregate sales, no other cashiers, no restock list, and
   no Submit for closing — that action belongs to a supervisor.
   ──────────────────────────────────────────────────────────────────────────── */
function CashierEndShift() {
  const user = useAuthStore((state) => state.user)
  const dayOpenHour = useInventoryStore((state) => state.dayOpenHour)
  const date = businessDate(new Date(), dayOpenHour)
  const shift = useShiftStore((state) => state.shift)
  const cashPosition = useShiftStore((state) => state.cashPosition)
  const resolve = useShiftStore((state) => state.resolve)

  const { petty, loading, reload } = useDayEndData(user, date)
  const [position, setPosition] = useState(null)
  const [cashOutOpen, setCashOutOpen] = useState(false)

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
  }, [shift, cashPosition, petty])

  // Only this cashier's own requests. Scoped in the UI as well as by intent: the branch
  // read returns every row, and a cashier must not see what other staff asked for.
  const myPetty = useMemo(
    () =>
      petty.filter(
        (row) =>
          rowKind(row) === 'paid_out' &&
          (row.requestedBy === user?.id || row.staffId === user?.id),
      ),
    [petty, user?.id],
  )

  if (loading) return <PageSkeleton variant="dashboard" />

  const expected = position ? Number(position.expectedCash || 0) : null

  return (
    <div>
      <PageHeader eyebrow="MY DRAWER" title="End shift">
        <span className="text-xs text-brand-n600">
          Business day {date} · opens {formatOpenHourLabel(dayOpenHour)}
        </span>
      </PageHeader>

      <TableCard className="mb-3.5 max-h-none p-5">
        <h2 className="m-0 mb-1 text-base">Your change fund</h2>
        <p className="m-0 mb-3 text-xs text-brand-muted">
          These are your own drawer&apos;s figures. Other cashiers&apos; drawers are counted
          separately and are not shown here.
        </p>
        {!shift ? (
          <p className="m-0 text-xs text-brand-subtle">
            No open shift on this drawer. Start a shift to count a change fund.
          </p>
        ) : (
          <>
            <div className="grid grid-cols-[1fr_auto] gap-x-[18px] gap-y-2 border-y border-brand-n300 py-3 text-[13px]">
              <span>Change fund in</span>
              <strong className={`text-right ${moneyClass}`}>
                {money(position?.startingCash ?? shift.startingCash)}
              </strong>
              <span>Cash sales</span>
              <strong className={`text-right ${moneyClass}`}>{money(position?.cashSales)}</strong>
              {Number(position?.cashRefunds || 0) > 0 && (
                <>
                  <span>Refunds / voids</span>
                  <strong className={`text-right ${moneyClass}`}>
                    −{money(position?.cashRefunds)}
                  </strong>
                </>
              )}
              {Number(position?.cashPaidOut || 0) > 0 && (
                <>
                  <span>Paid out (handed over)</span>
                  <strong className={`text-right ${moneyClass}`}>
                    −{money(position?.cashPaidOut)}
                  </strong>
                </>
              )}
              {Number(position?.cashPickups || 0) > 0 && (
                <>
                  <span>Pickups to safe</span>
                  <strong className={`text-right ${moneyClass}`}>
                    −{money(position?.cashPickups)}
                  </strong>
                </>
              )}
              <span className="font-bold">Drawer should hold</span>
              <strong className={`text-right font-bold ${moneyClass}`}>
                {expected == null ? '—' : money(expected)}
              </strong>
            </div>
            <p className="mt-3 mb-3 text-xs text-brand-muted">
              Counting the drawer ends your shift. Your final count and variance are recorded
              against you, and only a supervisor can correct them afterwards — as a logged
              adjustment, never a silent edit.
            </p>
            <PrimaryButton compact type="button" onClick={() => setCashOutOpen(true)}>
              Count drawer &amp; end shift
            </PrimaryButton>
          </>
        )}
      </TableCard>

      <PettyCashPanel
        rows={myPetty}
        user={user}
        branchId={user?.branchId}
        businessDate={date}
        shiftId={shift?.serverId || null}
        canApprove={false}
        canRequest
        scope="mine"
        onChanged={reload}
      />

      {cashOutOpen && shift && (
        <ShiftCashOut
          user={user}
          shift={shift}
          onCancel={() => setCashOutOpen(false)}
          onDone={async () => {
            setCashOutOpen(false)
            await resolve(user)
          }}
        />
      )}
    </div>
  )
}

/* ────────────────────────────────────────────────────────────────────────────
   SUPERVISOR+ — "Day end"
   Branch-wide: aggregate sales, every shift side by side, restock, the petty
   cash approval queue, and Submit for closing (the Z-reading gate).
   ──────────────────────────────────────────────────────────────────────────── */
function SupervisorDayEnd() {
  const user = useAuthStore((state) => state.user)
  const isRestaurant = user?.branchType === 'restaurant'
  const products = useProductStore((state) => state.products)
  const productsLoading = useProductStore((state) => state.loading)
  const transactions = useInventoryStore((state) => state.transactions)
  const movements = useInventoryStore((state) => state.movements)
  const dayEnds = useInventoryStore((state) => state.dayEnds)
  const dayOpenHour = useInventoryStore((state) => state.dayOpenHour)
  const submitDay = useInventoryStore((state) => state.submitDay)
  const approveDay = useInventoryStore((state) => state.approveDay)
  const activeShift = useShiftStore((state) => state.shift)

  const date = businessDate(new Date(), dayOpenHour)
  const { petty, shifts, loading, reload } = useDayEndData(user, date)

  const recorded = transactions
    .filter((item) => item.status === 'Paid' && item.date === date)
    .reduce((sum, item) => sum + Number(item.netTotal ?? item.total), 0)
  const cashSales = transactions
    .filter(
      (item) =>
        item.status === 'Paid' && item.date === date && (item.paymentMethod || 'cash') === 'cash',
    )
    .reduce((sum, item) => sum + Number(item.netTotal ?? item.total), 0)

  const existing = dayEndForBusinessDate(dayEnds, date)
  const isSubmitted = existing?.status === 'submitted'
  const isClosed = existing?.status === 'closed'
  const isLocked = isSubmitted || isClosed
  const canApprove = isSubmitted

  const [cashOnHand, setCashOnHand] = useState(existing ? String(existing.cashOnHand) : '')
  const [note, setNote] = useState(existing?.note || '')
  const [confirmSubmit, setConfirmSubmit] = useState(false)
  const [confirmApprove, setConfirmApprove] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [pickupAmount, setPickupAmount] = useState('')
  const [pickupNote, setPickupNote] = useState('')

  const changeFundRows = petty.filter((row) => rowKind(row) === 'change_fund')
  const pickupRows = petty.filter((row) => rowKind(row) === 'pickup')
  const paidOutRows = petty.filter((row) => rowKind(row) === 'paid_out')

  // The change fund now lives on the shift that counted it (starting_cash), one per
  // cashier per drawer. The legacy cash_drawer_entries rows are still added in for days
  // recorded before migrate_shift_cash_accountability.sql — the two never overlap, because
  // the new flow writes no change_fund entry at all.
  const drawerShifts = shifts.filter((row) => row.holdsDrawer !== false)
  const shiftFloatTotal = drawerShifts.reduce((sum, row) => sum + Number(row.startingCash || 0), 0)
  const legacyFloatTotal = changeFundRows.reduce((sum, row) => sum + Number(row.amount || 0), 0)
  const changeFundTotal = shiftFloatTotal + legacyFloatTotal
  const pickupTotal = pickupRows.reduce((sum, row) => sum + Number(row.amount || 0), 0)

  // Only cash that has actually been handed over leaves the drawer. An approved request
  // still sitting in the till is a commitment, not a disbursement — deducting it here made
  // the drawer read short for as long as it went unfulfilled.
  const paidOutTotal = paidOutRows
    .filter((row) => rowStatus(row) === 'fulfilled')
    .reduce((sum, row) => sum + Number(row.amount || 0), 0)
  const approvedUnfulfilled = paidOutRows
    .filter((row) => rowStatus(row) === 'approved')
    .reduce((sum, row) => sum + Number(row.amount || 0), 0)
  const pendingCount = paidOutRows.filter((row) => rowStatus(row) === 'pending').length

  const expectedCash = Number((changeFundTotal + cashSales - paidOutTotal - pickupTotal).toFixed(2))
  const variance = Number(cashOnHand || 0) - expectedCash
  const noteRequired = variance !== 0

  const liveReport = useMemo(
    () => buildDayEndReport({ date, transactions, movements, products, isRestaurant }),
    [date, transactions, movements, products, isRestaurant],
  )
  const report = isLocked && existing?.dayReport ? existing.dayReport : liveReport

  const buildEntry = () => {
    const dayReport = buildDayEndReport({ date, transactions, movements, products, isRestaurant })
    return {
      id: existing?.id,
      date,
      recordedCash: recorded,
      cashOnHand: Number(cashOnHand || 0),
      variance,
      expectedCash,
      note: [note, paidOutTotal ? `Petty cash ${paidOutTotal}` : ''].filter(Boolean).join(' · '),
      cashier: user?.name || 'Staff',
      dayReport: { ...dayReport, pettyCashTotal: paidOutTotal, expectedCash },
    }
  }

  const handleSubmit = async () => {
    setError('')
    if (noteRequired && !note.trim()) {
      setError('A note is required when variance is not zero.')
      setConfirmSubmit(false)
      return
    }
    setBusy(true)
    try {
      await submitDay(buildEntry())
      setConfirmSubmit(false)
    } catch (err) {
      setError(formatSupportError(err, 'TILL02'))
      setConfirmSubmit(false)
    } finally {
      setBusy(false)
    }
  }

  const handleApprove = async () => {
    setError('')
    setBusy(true)
    try {
      await approveDay(existing.id)
      setConfirmApprove(false)
    } catch (err) {
      setError(formatSupportError(err, 'TILL02'))
      setConfirmApprove(false)
    } finally {
      setBusy(false)
    }
  }

  if (loading || (productsLoading && !products.length)) {
    return <PageSkeleton variant="dashboard" />
  }

  return (
    <div>
      <PageHeader eyebrow="CASH CONTROL" title="Day end">
        <span className="text-xs text-brand-n600">
          Business day {date} · opens {formatOpenHourLabel(dayOpenHour)}
        </span>
      </PageHeader>

      {pendingCount > 0 && (
        <div className="mb-3.5 rounded-md bg-brand-warn-bg px-4 py-3 text-xs text-brand-warn">
          {pendingCount} petty cash request{pendingCount === 1 ? '' : 's'} waiting for your
          approval — see the panel below.
        </div>
      )}

      {isSubmitted && (
        <div className="mb-3.5 rounded-md bg-brand-warn-bg px-4 py-3 text-xs text-brand-warn">
          Awaiting supervisor or manager approval. POS sales are locked until the day is approved and
          closed.
          {existing.submittedAt ? ` Submitted at ${existing.submittedAt}.` : ''}
        </div>
      )}

      <DayEndReportPanels
        report={report}
        title={isClosed ? 'Closed day report' : isSubmitted ? 'Submitted day report' : "Today's sales report"}
        showRestock={!isRestaurant}
      />

      <TableCard className="mb-3.5 grid max-h-none gap-4 p-5">
        <div className="grid grid-cols-3 gap-3.5 max-[900px]:grid-cols-1">
          <div>
            <span className="block text-[11px] text-brand-subtle">All sales (POS)</span>
            <strong className={`my-2 block text-[22px] ${moneyClass} text-brand-gold`}>{money(recorded)}</strong>
            <small className="block text-[11px] text-brand-subtle">
              Cash sales {money(cashSales)} · Float {money(changeFundTotal)} · Pickups{' '}
              {money(pickupTotal)} · Paid-out {money(paidOutTotal)} · Expected {money(expectedCash)}
            </small>
          </div>
          <Field
            label="Cash on hand"
            inputMode="decimal"
            value={cashOnHand}
            onChange={(event) => setCashOnHand(decimalOnly(event.target.value))}
            placeholder="0.00"
            disabled={isLocked}
          />
          <div>
            <span className="block text-[11px] text-brand-subtle">Variance vs expected</span>
            <strong className={`my-2 block text-[22px] ${moneyClass} ${varianceToneClass(variance)}`}>
              {money(variance)}
            </strong>
            <small className="block text-[11px] text-brand-subtle">
              {variance === 0 ? 'Balanced' : variance < 0 ? 'Short' : 'Over'} (after petty cash)
            </small>
          </div>
        </div>
        {approvedUnfulfilled > 0 && (
          <p className="m-0 rounded-md bg-brand-n50 px-3 py-2 text-[11px] text-brand-muted">
            {money(approvedUnfulfilled)} of approved petty cash has not been handed over yet, so it
            is still counted as being in the drawer.
          </p>
        )}
        <Field
          label={noteRequired ? 'Notes (required — variance not zero)' : 'Notes'}
          value={note}
          onChange={(event) => setNote(event.target.value.replace(/[<>]/g, ''))}
          placeholder={noteRequired ? 'Explain the variance' : 'Optional note'}
          disabled={isLocked}
        />
        {error && <p className="text-xs text-brand-danger">{error}</p>}
        {isClosed ? (
          <p className="text-[13px] text-brand-muted">
            Day closed{existing.approvedAt ? ` at ${existing.approvedAt}` : existing.closedAt ? ` at ${existing.closedAt}` : ''}{' '}
            by {existing.cashier || 'staff'}. POS sales are locked until a manager reopens, or until{' '}
            {formatOpenHourLabel(dayOpenHour)} starts the next business day.
            {!isRestaurant && report?.restock?.length
              ? ` Restock list (${report.restock.length}) will show on the next open.`
              : ''}
          </p>
        ) : isSubmitted ? (
          <div>
            <p className="mb-3 text-[13px] text-brand-muted">
              Counts are locked while awaiting approval. A supervisor or manager must approve and close
              the day.
            </p>
            {canApprove && (
              <PrimaryButton compact disabled={busy} onClick={() => setConfirmApprove(true)}>
                Approve &amp; close day
              </PrimaryButton>
            )}
          </div>
        ) : (
          <div>
            {existing?.status === 'reopened' && (
              <p className="mb-3 text-xs text-brand-warn">
                Till was reopened by a manager
                {existing.reopenedAt ? ` at ${existing.reopenedAt}` : ''}
                {existing.reopenReason ? `: ${existing.reopenReason}` : ''}. Submit again when ready.
              </p>
            )}
            {/* Submit for closing is the Z-reading gate, so it is supervisor+ only —
                consistent with where Z-readings are generated elsewhere in the app. */}
            <PrimaryButton
              compact
              disabled={cashOnHand === '' || (noteRequired && !note.trim())}
              onClick={() => setConfirmSubmit(true)}
            >
              Submit for closing
            </PrimaryButton>
          </div>
        )}
      </TableCard>

      <TableCard className="mb-3.5 max-h-none p-5">
        <h2 className="m-0 mb-1 text-base">Accountability</h2>
        <p className="m-0 mb-3 text-xs text-brand-muted">
          Each cashier counts their own change fund when they start a shift. Record cash pickups
          here during the day — they are charged to whichever shift is open on the drawer.
        </p>

        {/* One line per shift, not one per day. A day total alone cannot answer "whose
            drawer was short", which is the only question this section gets asked.
            Every fact gets its own column: the old single line ("Sup — main · open now
            — ₱0.00 ₱0.00") made a supervisor decode a name, a drawer, a state and two
            unlabelled amounts out of one string. */}
        <div className="mb-4 overflow-hidden rounded-md border border-brand-softline">
          <div className="border-b border-brand-softline px-3 py-2.5">
            <strong className="block text-xs text-brand-ink">Change fund by shift</strong>
            <p className="m-0 text-[11px] text-brand-subtle">
              Counted by each cashier at the start of their shift · total today{' '}
              {money(changeFundTotal)}
            </p>
          </div>
          {drawerShifts.length === 0 && changeFundRows.length === 0 ? (
            <p className="m-0 px-3 py-4 text-xs text-brand-subtle">
              No shift has been opened on this business day yet.
            </p>
          ) : (
            <>
              <div className={`grid ${FUND_GRID} ${FUND_GRID_NARROW} items-center gap-2 bg-brand-dark px-3 py-2 text-[9px] font-bold tracking-[1px] text-brand-ondark uppercase`}>
                <span>Cashier</span>
                <span className="max-[700px]:hidden">Drawer / terminal</span>
                <span>Shift status</span>
                <span className="text-right max-[700px]:hidden">Opening float</span>
                <span className="text-right max-[700px]:hidden">Closing cash</span>
                <span className="text-right">Variance</span>
              </div>
              {drawerShifts.map((row) => {
                const status = shiftStatusBadge(row)
                return (
                  <div
                    key={row.id}
                    className={`grid ${FUND_GRID} ${FUND_GRID_NARROW} items-center gap-2 border-t border-brand-softline px-3 py-2.5 text-xs`}
                  >
                    <div className="min-w-0">
                      <strong className="block truncate text-brand-ink">{row.staffName}</strong>
                      <small className="block truncate text-[10px] text-brand-subtle capitalize">
                        {row.staffRole || 'staff'}
                        {row.shiftPeriod ? ` · ${row.shiftPeriod.toUpperCase()}` : ''}
                      </small>
                      <small className="mt-0.5 hidden text-[10px] text-brand-subtle max-[700px]:block">
                        {row.drawerLabel || row.drawerId} · float {money(row.startingCash)}
                      </small>
                    </div>
                    <span className="truncate text-brand-muted max-[700px]:hidden">
                      {row.drawerLabel || row.drawerId}
                    </span>
                    <span>
                      <StatusBadge compact tone={status.tone} title={status.hint}>
                        {status.label}
                      </StatusBadge>
                    </span>
                    <strong className={`text-right max-[700px]:hidden ${moneyClass}`}>
                      {money(row.startingCash)}
                    </strong>
                    <span className={`text-right max-[700px]:hidden ${moneyClass}`}>
                      {row.endingCash == null ? '—' : money(row.endingCash)}
                    </span>
                    <strong className={`text-right ${moneyClass} ${varianceToneClass(row.variance)}`}>
                      {/* An open shift has no variance yet — it is not zero, it is not
                          known. Printing ₱0.00 would read as "balanced". */}
                      {row.open || row.variance == null ? '—' : money(row.variance)}
                    </strong>
                  </div>
                )
              })}
              {changeFundRows.map((row) => (
                <div
                  key={row.id}
                  className="flex justify-between border-t border-brand-softline px-3 py-2.5 text-xs"
                >
                  <span className="text-brand-subtle">Opening float (recorded before shifts)</span>
                  <strong className={moneyClass}>{money(row.amount)}</strong>
                </div>
              ))}
            </>
          )}
        </div>

        {!isLocked && (
          <div className="mb-4 rounded-md border border-brand-softline p-3">
            <strong className="block text-xs text-brand-ink">Cash pickup</strong>
            <p className="m-0 mb-2 text-[11px] text-brand-subtle">Move cash out of drawer for safekeeping</p>
            <div className="grid grid-cols-[1fr_1fr_auto] gap-2 max-[700px]:grid-cols-1">
              <Field
                label="Amount"
                value={pickupAmount}
                onChange={(e) => setPickupAmount(decimalOnly(e.target.value))}
                inputMode="decimal"
              />
              <Field
                label="Note"
                value={pickupNote}
                onChange={(e) => setPickupNote(e.target.value.replace(/[<>]/g, ''))}
              />
              <div className="flex items-end">
                <PrimaryButton
                  compact
                  type="button"
                  disabled={!pickupAmount || Number(pickupAmount) <= 0}
                  onClick={async () => {
                    const reason = `[PICKUP] ${pickupNote || 'Safe drop'}`.trim()
                    try {
                      if (hasSupabase && user?.branchId) {
                        await addPettyCash({
                          branchId: user.branchId,
                          staffId: user.id,
                          amount: Number(pickupAmount),
                          reason,
                          businessDate: date,
                          kind: 'pickup',
                          status: 'recorded',
                          // Charged to the shift holding the drawer, so it lands in that
                          // cashier's expected cash rather than only the day's.
                          shiftId: activeShift?.serverId || null,
                        })
                        await reload()
                      }
                      setPickupAmount('')
                      setPickupNote('')
                    } catch (err) {
                      setError(formatSupportError(err, 'PETTY01'))
                    }
                  }}
                >
                  Record
                </PrimaryButton>
              </div>
            </div>
            {pickupRows.length > 0 && (
              <div className="mt-2">
                {pickupRows.map((row) => (
                  <div
                    key={row.id}
                    className="flex justify-between border-t border-brand-softline py-1.5 text-xs"
                  >
                    <span>{row.reason?.replace(/^\[PICKUP\]\s*/i, '') || 'Pickup'}</span>
                    <strong className={moneyClass}>{money(row.amount)}</strong>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        <p className="mb-0 text-xs text-brand-muted">
          Float {money(changeFundTotal)} · Pickups {money(pickupTotal)} · Handed-out{' '}
          {money(paidOutTotal)}
        </p>
      </TableCard>

      <PettyCashPanel
        rows={paidOutRows}
        user={user}
        branchId={user?.branchId}
        businessDate={date}
        shiftId={activeShift?.serverId || null}
        canApprove
        canRequest
        locked={isLocked}
        scope="branch"
        onChanged={reload}
      />

      <TableCard>
        <div className="flex items-center justify-between px-5 pt-4 pb-3">
          <h2 className="m-0 text-lg capitalize">Previous day-end closings</h2>
        </div>
        <div className="grid grid-cols-[1fr_0.9fr_0.9fr_0.9fr_0.8fr_1fr_1.2fr] gap-3 bg-brand-dark px-5 py-[17px] text-[9px] font-bold tracking-[1px] text-brand-ondark uppercase max-[700px]:grid-cols-[minmax(0,1.2fr)_0.9fr_0.9fr] max-[700px]:px-3">
          <span>Date</span>
          <span className="max-[700px]:hidden">Recorded</span>
          <span>On hand</span>
          <span className="text-right">Variance</span>
          <span className="max-[700px]:hidden">Status</span>
          <span className="max-[700px]:hidden">Cashier</span>
          <span className="max-[700px]:hidden">Restock</span>
        </div>
        {dayEnds.map((item) => (
          <div
            key={item.id}
            className={`grid grid-cols-[1fr_0.9fr_0.9fr_0.9fr_0.8fr_1fr_1.2fr] items-center gap-3 px-5 py-[17px] text-xs text-brand-slate max-[700px]:grid-cols-[minmax(0,1.2fr)_0.9fr_0.9fr] max-[700px]:px-3 ${tableRowClass}`}
          >
            <div className="min-w-0">
              <strong className="block text-brand-ink">{item.date}</strong>
              <small className="mt-0.5 hidden text-[10px] text-brand-subtle max-[700px]:block">
                Rec {money(item.recordedCash)} · {item.status || 'closed'}
                {item.dayReport?.restock?.length ? ` · restock ${item.dayReport.restock.length}` : ''}
              </small>
            </div>
            <span className={`max-[700px]:hidden ${moneyClass}`}>{money(item.recordedCash)}</span>
            <span className={moneyClass}>{money(item.cashOnHand)}</span>
            <strong className={`text-right ${moneyClass} ${varianceToneClass(item.variance)}`}>
              {money(item.variance)}
            </strong>
            <span className="capitalize max-[700px]:hidden">{item.status || 'closed'}</span>
            <span className="max-[700px]:hidden">{item.cashier || '—'}</span>
            <span className="max-[700px]:hidden">
              {item.dayReport?.restock?.length
                ? `${item.dayReport.restock.length} items`
                : item.dayReport?.sold?.length
                  ? 'OK'
                  : '—'}
            </span>
          </div>
        ))}
      </TableCard>

      {confirmSubmit && (
        <Modal wide onClose={() => setConfirmSubmit(false)}>
          <Eyebrow>SUBMIT FOR CLOSING</Eyebrow>
          <h2 className="mb-3 text-[22px] max-[700px]:text-lg">Submit {date}?</h2>
          <p className="mb-2 text-xs text-brand-muted">
            This locks POS sales until a supervisor or manager approves and closes the day. The sales
            report
            {!isRestaurant ? ' and restock list' : ''} will be saved with your counts.
          </p>
          <div className="my-3 grid grid-cols-[1fr_auto] gap-x-[18px] gap-y-2.5 border-y border-brand-n300 py-3.5 text-[13px]">
            <span>Recorded</span>
            <strong className={`text-right ${moneyClass}`}>{money(recorded)}</strong>
            <span>Petty cash handed over</span>
            <strong className={`text-right ${moneyClass}`}>{money(paidOutTotal)}</strong>
            <span>Expected drawer</span>
            <strong className={`text-right ${moneyClass}`}>{money(expectedCash)}</strong>
            <span>Cash on hand</span>
            <strong className={`text-right ${moneyClass}`}>{money(Number(cashOnHand || 0))}</strong>
            <span>Variance</span>
            <strong className={`text-right ${moneyClass} ${varianceToneClass(variance)}`}>
              {money(variance)}
            </strong>
            <span>Line items sold</span>
            <strong className="text-right">{liveReport.sold.length}</strong>
            {!isRestaurant && (
              <>
                <span>Restock flags</span>
                <strong className="text-right text-brand-danger">{liveReport.restock.length}</strong>
              </>
            )}
          </div>
          <ModalActions>
            <SecondaryButton compact type="button" onClick={() => setConfirmSubmit(false)}>
              Cancel
            </SecondaryButton>
            <PrimaryButton compact type="button" disabled={busy} onClick={handleSubmit}>
              Submit for closing
            </PrimaryButton>
          </ModalActions>
        </Modal>
      )}

      {confirmApprove && (
        <Modal wide onClose={() => setConfirmApprove(false)}>
          <Eyebrow>APPROVE DAY CLOSE</Eyebrow>
          <h2 className="mb-3 text-[22px] max-[700px]:text-lg">Approve &amp; close {date}?</h2>
          <p className="mb-2 text-xs text-brand-muted">
            This finalizes the day close. POS stays locked until a manager reopens or the next business
            day begins.
          </p>
          <div className="my-3 grid grid-cols-[1fr_auto] gap-x-[18px] gap-y-2.5 border-y border-brand-n300 py-3.5 text-[13px]">
            <span>Cash on hand</span>
            <strong className={`text-right ${moneyClass}`}>{money(existing?.cashOnHand ?? 0)}</strong>
            <span>Variance</span>
            <strong className={`text-right ${moneyClass} ${varianceToneClass(existing?.variance)}`}>
              {money(existing?.variance ?? 0)}
            </strong>
            {existing?.note && (
              <>
                <span>Note</span>
                <span className="text-right text-brand-muted">{existing.note}</span>
              </>
            )}
          </div>
          <ModalActions>
            <SecondaryButton compact type="button" onClick={() => setConfirmApprove(false)}>
              Cancel
            </SecondaryButton>
            <PrimaryButton compact type="button" disabled={busy} onClick={handleApprove}>
              Approve &amp; close day
            </PrimaryButton>
          </ModalActions>
        </Modal>
      )}
    </div>
  )
}

export default DayEnd
