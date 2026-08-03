import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { DayEndReportPanels } from '../components/dayend/DayEndReportPanels'
import {
  Eyebrow,
  Field,
  Modal,
  ModalActions,
  PageHeader,
  PrimaryButton,
  SecondaryButton,
  TableCard,
} from '../components/ui'
import { addPettyCash, fetchPettyCash, hasSupabase } from '../lib/api'
import { useAuthStore, useInventoryStore, useProductStore } from '../stores/posStore'
import { buildDayEndReport } from '../utils/dayEndReport'
import { formatSupportError } from '../utils/errors'
import { businessDate, dayEndForBusinessDate, formatOpenHourLabel, money } from '../utils/format'
import { decimalOnly } from '../utils/validate'

function DayEnd() {
  const user = useAuthStore((state) => state.user)
  const isRestaurant = user?.branchType === 'restaurant'
  const products = useProductStore((state) => state.products)
  const transactions = useInventoryStore((state) => state.transactions)
  const movements = useInventoryStore((state) => state.movements)
  const dayEnds = useInventoryStore((state) => state.dayEnds)
  const dayOpenHour = useInventoryStore((state) => state.dayOpenHour)
  const closeDay = useInventoryStore((state) => state.closeDay)
  const lockAfterDayEnd = useAuthStore((state) => state.lockAfterDayEnd)
  const navigate = useNavigate()
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
  const isClosed = existing?.status === 'closed'
  const [cashOnHand, setCashOnHand] = useState(existing ? String(existing.cashOnHand) : '')
  const [note, setNote] = useState(existing?.note || '')
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState('')
  const [petty, setPetty] = useState([])
  const [pettyAmount, setPettyAmount] = useState('')
  const [pettyReason, setPettyReason] = useState('')
  const [pickupAmount, setPickupAmount] = useState('')
  const [pickupNote, setPickupNote] = useState('')
  const [changeFundAmount, setChangeFundAmount] = useState('')
  const [changeFundNote, setChangeFundNote] = useState('')

  const entryKind = (reason = '') => {
    const r = String(reason || '')
    if (r.startsWith('[CHANGE FUND]')) return 'change_fund'
    if (r.startsWith('[PICKUP]')) return 'pickup'
    return 'paid_out'
  }

  const changeFundTotal = petty
    .filter((row) => entryKind(row.reason) === 'change_fund')
    .reduce((sum, row) => sum + Number(row.amount || 0), 0)
  const pickupTotal = petty
    .filter((row) => entryKind(row.reason) === 'pickup')
    .reduce((sum, row) => sum + Number(row.amount || 0), 0)
  const paidOutTotal = petty
    .filter((row) => entryKind(row.reason) === 'paid_out')
    .reduce((sum, row) => sum + Number(row.amount || 0), 0)
  const pettyTotal = paidOutTotal
  const expectedCash = Number(
    (changeFundTotal + cashSales - paidOutTotal - pickupTotal).toFixed(2),
  )
  const variance = Number(cashOnHand || 0) - expectedCash

  useEffect(() => {
    let active = true
    if (!hasSupabase || !user?.branchId) {
      setPetty([])
      return undefined
    }
    fetchPettyCash(user.branchId, date)
      .then((rows) => {
        if (active) setPetty(rows || [])
      })
      .catch(() => {
        if (active) setPetty([])
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
  const report = isClosed && existing?.dayReport ? existing.dayReport : liveReport

  const submit = async () => {
    setError('')
    try {
      const dayReport = buildDayEndReport({
        date,
        transactions,
        movements,
        products,
        isRestaurant,
      })
      await closeDay({
        id: existing?.id,
        date,
        recordedCash: recorded,
        cashOnHand: Number(cashOnHand || 0),
        variance,
        note: [note, pettyTotal ? `Petty cash ${pettyTotal}` : ''].filter(Boolean).join(' · '),
        cashier: user?.name || 'Staff',
        closedAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        dayReport: { ...dayReport, pettyCashTotal: pettyTotal, expectedCash },
      })
      setConfirming(false)
      await lockAfterDayEnd()
      navigate('/login', { replace: true })
    } catch (err) {
      setError(formatSupportError(err, 'TILL02'))
      setConfirming(false)
    }
  }

  return (
    <div>
      <PageHeader eyebrow="CASH CONTROL" title="Day end">
        <span className="text-xs text-[#797e7b]">
          Business day {date} · opens {formatOpenHourLabel(dayOpenHour)}
        </span>
      </PageHeader>

      <DayEndReportPanels
        report={report}
        title={isClosed ? 'Closed day report' : 'Today\'s sales report'}
        showRestock={!isRestaurant}
      />

      <TableCard className="mb-3.5 grid max-h-none gap-4 p-5">
        <div className="grid grid-cols-3 gap-3.5 max-[900px]:grid-cols-1">
          <div>
            <span className="block text-[11px] text-brand-subtle">All sales (POS)</span>
            <strong className="my-2 block text-[22px] text-brand-gold">{money(recorded)}</strong>
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
            disabled={isClosed}
          />
          <div>
            <span className="block text-[11px] text-brand-subtle">Variance vs expected</span>
            <strong
              className={`my-2 block text-[22px] ${
                variance === 0 ? 'text-brand-gold' : variance < 0 ? 'text-brand-danger' : 'text-brand-success'
              }`}
            >
              {money(variance)}
            </strong>
            <small className="block text-[11px] text-brand-subtle">
              {variance === 0 ? 'Balanced' : variance < 0 ? 'Short' : 'Over'} (after petty cash)
            </small>
          </div>
        </div>
        <Field
          label="Notes"
          value={note}
          onChange={(event) => setNote(event.target.value.replace(/[<>]/g, ''))}
          placeholder="Optional note"
          disabled={isClosed}
        />
        {error && <p className="text-xs text-brand-danger">{error}</p>}
        {isClosed ? (
          <p className="text-[13px] text-brand-muted">
            Day closed at {existing.closedAt} by {existing.cashier || 'staff'}. POS sales are locked until a
            manager reopens, or until {formatOpenHourLabel(dayOpenHour)} starts the next business day.
            {!isRestaurant && report?.restock?.length
              ? ` Restock list (${report.restock.length}) will show on the next open.`
              : ''}
          </p>
        ) : (
          <div>
            {existing?.status === 'reopened' && (
              <p className="mb-3 text-xs text-brand-warn">
                Till was reopened by a manager{existing.reopenedAt ? ` at ${existing.reopenedAt}` : ''}. You can
                close the day again when ready.
              </p>
            )}
            <PrimaryButton compact disabled={cashOnHand === ''} onClick={() => setConfirming(true)}>
              Close day
            </PrimaryButton>
          </div>
        )}
      </TableCard>

      <TableCard className="mb-3.5 max-h-none p-5">
        <h2 className="m-0 mb-1 text-base">Accountability</h2>
        <p className="m-0 mb-3 text-xs text-brand-muted">
          Change fund (opening float), cash pickups, and paid-outs for this business day.
        </p>
        {!isClosed && (
          <div className="mb-4 grid gap-3 max-[900px]:grid-cols-1 md:grid-cols-2">
            <div className="rounded-md border border-brand-softline p-3">
              <strong className="block text-xs text-brand-ink">Change fund</strong>
              <p className="m-0 mb-2 text-[11px] text-brand-subtle">Starting cash float in the drawer</p>
              <div className="grid grid-cols-[1fr_1fr_auto] gap-2 max-[700px]:grid-cols-1">
                <Field
                  label="Amount"
                  value={changeFundAmount}
                  onChange={(e) => setChangeFundAmount(decimalOnly(e.target.value))}
                  inputMode="decimal"
                />
                <Field
                  label="Note"
                  value={changeFundNote}
                  onChange={(e) => setChangeFundNote(e.target.value.replace(/[<>]/g, ''))}
                />
                <div className="flex items-end">
                  <PrimaryButton
                    compact
                    type="button"
                    disabled={!changeFundAmount || Number(changeFundAmount) <= 0}
                    onClick={async () => {
                      const reason = `[CHANGE FUND] ${changeFundNote || 'Opening float'}`.trim()
                      try {
                        if (hasSupabase && user?.branchId) {
                          const row = await addPettyCash({
                            branchId: user.branchId,
                            staffId: user.id,
                            amount: Number(changeFundAmount),
                            reason,
                            businessDate: date,
                          })
                          setPetty((prev) => [row, ...prev])
                        } else {
                          setPetty((prev) => [
                            { id: `local-${Date.now()}`, amount: Number(changeFundAmount), reason },
                            ...prev,
                          ])
                        }
                        setChangeFundAmount('')
                        setChangeFundNote('')
                      } catch (err) {
                        setError(formatSupportError(err, 'PETTY01'))
                      }
                    }}
                  >
                    Record
                  </PrimaryButton>
                </div>
              </div>
            </div>
            <div className="rounded-md border border-brand-softline p-3">
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
                          const row = await addPettyCash({
                            branchId: user.branchId,
                            staffId: user.id,
                            amount: Number(pickupAmount),
                            reason,
                            businessDate: date,
                          })
                          setPetty((prev) => [row, ...prev])
                        } else {
                          setPetty((prev) => [
                            { id: `local-${Date.now()}`, amount: Number(pickupAmount), reason },
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
            </div>
          </div>
        )}
        <p className="mb-3 text-xs text-brand-muted">
          Float {money(changeFundTotal)} · Pickups {money(pickupTotal)} · Paid-out {money(paidOutTotal)}
        </p>
      </TableCard>

      <TableCard className="mb-3.5 max-h-none p-5">
        <h2 className="m-0 mb-3 text-base">Paid-out (petty cash)</h2>
        {!isClosed && (
          <div className="mb-3 grid grid-cols-[1fr_1.4fr_auto] gap-2 max-[700px]:grid-cols-1">
            <Field
              label="Amount"
              value={pettyAmount}
              onChange={(e) => setPettyAmount(decimalOnly(e.target.value))}
              inputMode="decimal"
            />
            <Field
              label="Reason"
              value={pettyReason}
              onChange={(e) => setPettyReason(e.target.value.replace(/[<>]/g, ''))}
            />
            <div className="flex items-end">
              <PrimaryButton
                compact
                type="button"
                disabled={!pettyAmount || Number(pettyAmount) <= 0}
                onClick={async () => {
                  try {
                    if (hasSupabase && user?.branchId) {
                      const row = await addPettyCash({
                        branchId: user.branchId,
                        staffId: user.id,
                        amount: Number(pettyAmount),
                        reason: pettyReason,
                        businessDate: date,
                      })
                      setPetty((prev) => [row, ...prev])
                    } else {
                      setPetty((prev) => [
                        {
                          id: `local-${Date.now()}`,
                          amount: Number(pettyAmount),
                          reason: pettyReason,
                        },
                        ...prev,
                      ])
                    }
                    setPettyAmount('')
                    setPettyReason('')
                  } catch (err) {
                    setError(formatSupportError(err, 'PETTY01'))
                  }
                }}
              >
                Add
              </PrimaryButton>
            </div>
          </div>
        )}
        <p className="mb-2 text-xs text-brand-muted">Today&apos;s paid-out total: {money(pettyTotal)}</p>
        {petty.filter((row) => entryKind(row.reason) === 'paid_out').length === 0 ? (
          <p className="text-xs text-brand-subtle">No paid-out entries yet.</p>
        ) : (
          petty
            .filter((row) => entryKind(row.reason) === 'paid_out')
            .map((row) => (
            <div
              key={row.id}
              className="flex justify-between border-t border-brand-softline py-2 text-xs first:border-t-0"
            >
              <span>{row.reason || '—'}</span>
              <strong>{money(row.amount)}</strong>
            </div>
          ))
        )}
      </TableCard>

      <TableCard>
        <div className="flex items-center justify-between px-5 pt-4 pb-3">
          <h2 className="m-0 text-lg capitalize">Previous day ends</h2>
        </div>
        <div className="grid grid-cols-[1fr_0.9fr_0.9fr_0.9fr_0.8fr_1fr_1.2fr] gap-3 bg-[#f7f7f4] px-5 py-[17px] text-[9px] font-bold tracking-[1px] text-[#989e99] uppercase max-[700px]:grid-cols-[minmax(0,1.2fr)_0.9fr_0.9fr] max-[700px]:px-3">
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
            className="grid grid-cols-[1fr_0.9fr_0.9fr_0.9fr_0.8fr_1fr_1.2fr] items-center gap-3 border-t border-brand-softline px-5 py-[17px] text-xs text-brand-slate max-[700px]:grid-cols-[minmax(0,1.2fr)_0.9fr_0.9fr] max-[700px]:px-3"
          >
            <div className="min-w-0">
              <strong className="block text-brand-ink">{item.date}</strong>
              <small className="mt-0.5 hidden text-[10px] text-brand-subtle max-[700px]:block">
                Rec {money(item.recordedCash)} · {item.status || 'closed'}
                {item.dayReport?.restock?.length ? ` · restock ${item.dayReport.restock.length}` : ''}
              </small>
            </div>
            <span className="max-[700px]:hidden">{money(item.recordedCash)}</span>
            <span>{money(item.cashOnHand)}</span>
            <strong className={`text-right ${item.variance < 0 ? 'text-brand-danger' : 'text-brand-ink'}`}>
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
      {confirming && (
        <Modal wide onClose={() => setConfirming(false)}>
          <Eyebrow>CONFIRM DAY END</Eyebrow>
          <h2 className="mb-3 text-[22px] max-[700px]:text-lg">Close {date}?</h2>
          <p className="mb-2 text-xs text-brand-muted">
            This locks POS sales and signs you out. The sales report
            {!isRestaurant ? ' and restock list' : ''} will be saved for the next open.
          </p>
          <div className="my-3 grid grid-cols-[1fr_auto] gap-x-[18px] gap-y-2.5 border-y border-[#e1e3dd] py-3.5 text-[13px]">
            <span>Recorded</span>
            <strong className="text-right">{money(recorded)}</strong>
            <span>Petty cash</span>
            <strong className="text-right">{money(pettyTotal)}</strong>
            <span>Expected drawer</span>
            <strong className="text-right">{money(expectedCash)}</strong>
            <span>Cash on hand</span>
            <strong className="text-right">{money(Number(cashOnHand || 0))}</strong>
            <span>Variance</span>
            <strong className={`text-right ${variance < 0 ? 'text-brand-danger' : 'text-brand-success'}`}>
              {money(variance)}
            </strong>
            <span>Sold lines</span>
            <strong className="text-right">{liveReport.sold.length}</strong>
            {!isRestaurant && (
              <>
                <span>Restock flags</span>
                <strong className="text-right text-brand-danger">{liveReport.restock.length}</strong>
              </>
            )}
          </div>
          <ModalActions>
            <SecondaryButton compact type="button" onClick={() => setConfirming(false)}>
              Cancel
            </SecondaryButton>
            <PrimaryButton compact type="button" onClick={submit}>
              Close day
            </PrimaryButton>
          </ModalActions>
        </Modal>
      )}
    </div>
  )
}

export default DayEnd
