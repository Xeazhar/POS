import { useEffect, useMemo, useState } from 'react'
import { DayEndReportPanels } from '../components/dayend/DayEndReportPanels'
import {
  Eyebrow,
  Field,
  Modal,
  ModalActions,
  PageHeader,
  PageSkeleton,
  PrimaryButton,
  SecondaryButton,
  TableCard,
  moneyClass,
  tableRowClass,
  varianceToneClass,
} from '../components/ui'
import { addPettyCash, approvePettyCash, fetchPettyCash, hasSupabase, rejectPettyCash, requestPettyCash } from '../lib/api'
import { useAuthStore, useInventoryStore, useProductStore } from '../stores/posStore'
import { buildDayEndReport } from '../utils/dayEndReport'
import { formatSupportError } from '../utils/errors'
import { businessDate, dayEndForBusinessDate, formatOpenHourLabel, money } from '../utils/format'
import { isSupervisorOrAbove } from '../utils/roles'
import { decimalOnly } from '../utils/validate'

function DayEnd() {
  const user = useAuthStore((state) => state.user)
  const isRestaurant = user?.branchType === 'restaurant'
  const products = useProductStore((state) => state.products)
  const transactions = useInventoryStore((state) => state.transactions)
  const movements = useInventoryStore((state) => state.movements)
  const dayEnds = useInventoryStore((state) => state.dayEnds)
  const dayOpenHour = useInventoryStore((state) => state.dayOpenHour)
  const submitDay = useInventoryStore((state) => state.submitDay)
  const approveDay = useInventoryStore((state) => state.approveDay)
  const date = businessDate(new Date(), dayOpenHour)
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
  const canApprove = isSupervisorOrAbove(user?.role) && isSubmitted
  const [cashOnHand, setCashOnHand] = useState(existing ? String(existing.cashOnHand) : '')
  const [note, setNote] = useState(existing?.note || '')
  const [confirmSubmit, setConfirmSubmit] = useState(false)
  const [confirmApprove, setConfirmApprove] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [petty, setPetty] = useState([])
  const [pettyAmount, setPettyAmount] = useState('')
  const [pettyReason, setPettyReason] = useState('')
  const [pettyReceipt, setPettyReceipt] = useState('')
  const [pickupAmount, setPickupAmount] = useState('')
  const [pickupNote, setPickupNote] = useState('')
  const [pageLoading, setPageLoading] = useState(Boolean(hasSupabase && user?.branchId))
  const productsLoading = useProductStore((state) => state.loading)

  const rowKind = (row) => row.kind || (
    String(row.reason || '').startsWith('[CHANGE FUND]')
      ? 'change_fund'
      : String(row.reason || '').startsWith('[PICKUP]')
        ? 'pickup'
        : 'paid_out'
  )
  const rowStatus = (row) => row.status || (rowKind(row) === 'paid_out' ? 'approved' : 'recorded')

  const changeFundRows = petty.filter((row) => rowKind(row) === 'change_fund')
  const pickupRows = petty.filter((row) => rowKind(row) === 'pickup')
  const paidOutRows = petty.filter((row) => rowKind(row) === 'paid_out')
  const pendingPetty = paidOutRows.filter((row) => rowStatus(row) === 'pending')
  const approvedPetty = paidOutRows.filter((row) => rowStatus(row) === 'approved')

  const changeFundTotal = changeFundRows.reduce((sum, row) => sum + Number(row.amount || 0), 0)
  const pickupTotal = pickupRows.reduce((sum, row) => sum + Number(row.amount || 0), 0)
  const paidOutTotal = approvedPetty.reduce((sum, row) => sum + Number(row.amount || 0), 0)
  const pettyTotal = paidOutTotal
  const expectedCash = Number(
    (changeFundTotal + cashSales - paidOutTotal - pickupTotal).toFixed(2),
  )
  const variance = Number(cashOnHand || 0) - expectedCash
  const noteRequired = variance !== 0
  const canApprovePetty = isSupervisorOrAbove(user?.role)

  const reloadPetty = async () => {
    if (!hasSupabase || !user?.branchId) {
      setPetty([])
      return
    }
    const rows = await fetchPettyCash(user.branchId, date)
    setPetty(rows || [])
  }

  useEffect(() => {
    let active = true
    if (!hasSupabase || !user?.branchId) {
      setPetty([])
      setPageLoading(false)
      return undefined
    }
    setPageLoading(true)
    fetchPettyCash(user.branchId, date)
      .then((rows) => {
        if (active) setPetty(rows || [])
      })
      .catch(() => {
        if (active) setPetty([])
      })
      .finally(() => {
        if (active) setPageLoading(false)
      })
    return () => {
      active = false
    }
  }, [user?.branchId, date])

  const liveReport = useMemo(
    () =>
      buildDayEndReport({
        date,
        transactions,
        movements,
        products,
        isRestaurant,
      }),
    [date, transactions, movements, products, isRestaurant],
  )
  const report = isLocked && existing?.dayReport ? existing.dayReport : liveReport

  const buildEntry = () => {
    const dayReport = buildDayEndReport({
      date,
      transactions,
      movements,
      products,
      isRestaurant,
    })
    return {
      id: existing?.id,
      date,
      recordedCash: recorded,
      cashOnHand: Number(cashOnHand || 0),
      variance,
      expectedCash,
      note: [note, pettyTotal ? `Petty cash ${pettyTotal}` : ''].filter(Boolean).join(' · '),
      cashier: user?.name || 'Staff',
      dayReport: { ...dayReport, pettyCashTotal: pettyTotal, expectedCash },
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

  if (pageLoading || (productsLoading && !products.length)) {
    return <PageSkeleton variant="dashboard" />
  }

  return (
    <div>
      <PageHeader eyebrow="CASH CONTROL" title="Day end">
        <span className="text-xs text-brand-n600">
          Business day {date} · opens {formatOpenHourLabel(dayOpenHour)}
        </span>
      </PageHeader>

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
          Change fund is set by the cashier at clock-in. Record cash pickups here during the day.
        </p>

        <div className="mb-4 rounded-md border border-brand-softline p-3">
          <strong className="block text-xs text-brand-ink">Change fund (opening float)</strong>
          <p className="m-0 mb-2 text-[11px] text-brand-subtle">
            Entered at shift start · total today {money(changeFundTotal)}
          </p>
          {changeFundRows.length === 0 ? (
            <p className="m-0 text-xs text-brand-subtle">
              No change fund yet for this business day. Cashier must clock in and enter the drawer float.
            </p>
          ) : (
            changeFundRows.map((row) => (
              <div
                key={row.id}
                className="flex justify-between border-t border-brand-softline py-2 text-xs first:border-t-0"
              >
                <span>
                  Opening float
                  {row.confirmedBy ? ' · confirmed' : ''}
                </span>
                <strong className={moneyClass}>{money(row.amount)}</strong>
              </div>
            ))
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
                        })
                        await reloadPetty()
                      } else {
                        setPetty((prev) => [
                          {
                            id: `local-${Date.now()}`,
                            amount: Number(pickupAmount),
                            reason,
                            kind: 'pickup',
                            status: 'recorded',
                          },
                          ...prev,
                        ])
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
          Float {money(changeFundTotal)} · Pickups {money(pickupTotal)} · Approved paid-out{' '}
          {money(paidOutTotal)}
        </p>
      </TableCard>

      <TableCard className="mb-3.5 max-h-none p-5">
        <h2 className="m-0 mb-1 text-base">Petty cash (paid-out)</h2>
        <p className="m-0 mb-3 text-xs text-brand-muted">
          Request cash for shop expenses. A supervisor or manager must approve before it counts in
          day-end.
        </p>
        {!isLocked && (
          <div className="mb-3 grid grid-cols-[1fr_1.2fr_1fr_auto] gap-2 max-[900px]:grid-cols-1">
            <Field
              label="Amount"
              value={pettyAmount}
              onChange={(e) => setPettyAmount(decimalOnly(e.target.value))}
              inputMode="decimal"
              required
            />
            <Field
              label="Reason"
              value={pettyReason}
              onChange={(e) => setPettyReason(e.target.value.replace(/[<>]/g, ''))}
              required
              placeholder="e.g. Cleaning supplies"
            />
            <Field
              label="Receipt / ref"
              value={pettyReceipt}
              onChange={(e) => setPettyReceipt(e.target.value.replace(/[<>]/g, ''))}
              placeholder="Optional receipt #"
            />
            <div className="flex items-end">
              <PrimaryButton
                compact
                type="button"
                disabled={!pettyAmount || Number(pettyAmount) <= 0 || !pettyReason.trim()}
                onClick={async () => {
                  try {
                    if (hasSupabase && user?.branchId) {
                      await requestPettyCash({
                        branchId: user.branchId,
                        staffId: user.id,
                        amount: Number(pettyAmount),
                        reason: pettyReason.trim(),
                        receiptRef: pettyReceipt.trim(),
                        businessDate: date,
                      })
                      await reloadPetty()
                    } else {
                      setPetty((prev) => [
                        {
                          id: `local-${Date.now()}`,
                          amount: Number(pettyAmount),
                          reason: pettyReason.trim(),
                          receiptRef: pettyReceipt.trim(),
                          kind: 'paid_out',
                          status: 'pending',
                        },
                        ...prev,
                      ])
                    }
                    setPettyAmount('')
                    setPettyReason('')
                    setPettyReceipt('')
                  } catch (err) {
                    setError(formatSupportError(err, 'PETTY01'))
                  }
                }}
              >
                Request
              </PrimaryButton>
            </div>
          </div>
        )}

        {pendingPetty.length > 0 && (
          <div className="mb-3">
            <p className="m-0 mb-1 text-[11px] font-bold text-brand-warn">
              Awaiting approval ({pendingPetty.length})
            </p>
            {pendingPetty.map((row) => (
              <div
                key={row.id}
                className="flex flex-wrap items-center justify-between gap-2 border-t border-brand-softline py-2 text-xs"
              >
                <div className="min-w-0">
                  <strong className={`block text-brand-ink ${moneyClass}`}>{money(row.amount)}</strong>
                  <span className="text-brand-muted">{row.reason || '—'}</span>
                  {row.receiptRef ? (
                    <span className="mt-0.5 block text-[10px] text-brand-subtle">
                      Ref: {row.receiptRef}
                    </span>
                  ) : null}
                </div>
                {canApprovePetty && !isLocked && (
                  <div className="flex gap-2">
                    <SecondaryButton
                      compact
                      type="button"
                      onClick={async () => {
                        try {
                          await rejectPettyCash({ id: row.id, approvedBy: user.id })
                          await reloadPetty()
                        } catch (err) {
                          setError(formatSupportError(err, 'PETTY02'))
                        }
                      }}
                    >
                      Reject
                    </SecondaryButton>
                    <PrimaryButton
                      compact
                      type="button"
                      onClick={async () => {
                        try {
                          await approvePettyCash({ id: row.id, approvedBy: user.id })
                          await reloadPetty()
                        } catch (err) {
                          setError(formatSupportError(err, 'PETTY02'))
                        }
                      }}
                    >
                      Approve
                    </PrimaryButton>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        <p className="mb-2 text-xs text-brand-muted">
          Approved paid-out total: {money(pettyTotal)}
        </p>
        {approvedPetty.length === 0 ? (
          <p className="text-xs text-brand-subtle">No approved paid-out entries yet.</p>
        ) : (
          approvedPetty.map((row) => (
            <div
              key={row.id}
              className="flex justify-between border-t border-brand-softline py-2 text-xs first:border-t-0"
            >
              <span>
                {row.reason || '—'}
                {row.receiptRef ? ` · ${row.receiptRef}` : ''}
              </span>
              <strong className={moneyClass}>{money(row.amount)}</strong>
            </div>
          ))
        )}
      </TableCard>

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
            <span>Petty cash</span>
            <strong className={`text-right ${moneyClass}`}>{money(pettyTotal)}</strong>
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
