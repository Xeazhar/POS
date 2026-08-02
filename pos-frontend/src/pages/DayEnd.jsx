import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
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
import { useAuthStore, useInventoryStore } from '../stores/posStore'
import { businessDate, dayEndForBusinessDate, formatOpenHourLabel, money } from '../utils/format'
import { decimalOnly } from '../utils/validate'

function DayEnd() {
  const user = useAuthStore((state) => state.user)
  const transactions = useInventoryStore((state) => state.transactions)
  const dayEnds = useInventoryStore((state) => state.dayEnds)
  const dayOpenHour = useInventoryStore((state) => state.dayOpenHour)
  const closeDay = useInventoryStore((state) => state.closeDay)
  const lockAfterDayEnd = useAuthStore((state) => state.lockAfterDayEnd)
  const navigate = useNavigate()
  const date = businessDate(new Date(), dayOpenHour)
  const recorded = transactions
    .filter((item) => item.status === 'Paid' && item.date === date)
    .reduce((sum, item) => sum + item.total, 0)
  const existing = dayEndForBusinessDate(dayEnds, date)
  const isClosed = existing?.status === 'closed'
  const [cashOnHand, setCashOnHand] = useState(existing ? String(existing.cashOnHand) : '')
  const [note, setNote] = useState(existing?.note || '')
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState('')
  const variance = Number(cashOnHand || 0) - recorded

  const submit = async () => {
    setError('')
    try {
      await closeDay({
        id: existing?.id,
        date,
        recordedCash: recorded,
        cashOnHand: Number(cashOnHand || 0),
        variance,
        note,
        cashier: user?.name || 'Staff',
        closedAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      })
      setConfirming(false)
      // Security: day close ends the shift — next open requires password login
      await lockAfterDayEnd()
      navigate('/login', { replace: true })
    } catch (err) {
      setError(err.message || 'Could not close day')
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
      <TableCard className="mb-3.5 grid max-h-none gap-4 p-5">
        <div className="grid grid-cols-3 gap-3.5 max-[900px]:grid-cols-1">
          <div>
            <span className="block text-[11px] text-brand-subtle">Recorded cash (POS)</span>
            <strong className="my-2 block text-[22px] text-brand-gold">{money(recorded)}</strong>
            <small className="block text-[11px] text-brand-subtle">Paid sales for this business day</small>
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
            <span className="block text-[11px] text-brand-subtle">Variance</span>
            <strong
              className={`my-2 block text-[22px] ${
                variance === 0 ? 'text-brand-gold' : variance < 0 ? 'text-brand-danger' : 'text-brand-success'
              }`}
            >
              {money(variance)}
            </strong>
            <small className="block text-[11px] text-brand-subtle">
              {variance === 0 ? 'Balanced' : variance < 0 ? 'Short' : 'Over'}
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
          <span className="max-[700px]:hidden">Note</span>
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
              </small>
            </div>
            <span className="max-[700px]:hidden">{money(item.recordedCash)}</span>
            <span>{money(item.cashOnHand)}</span>
            <strong className={`text-right ${item.variance < 0 ? 'text-brand-danger' : 'text-brand-ink'}`}>
              {money(item.variance)}
            </strong>
            <span className="capitalize max-[700px]:hidden">{item.status || 'closed'}</span>
            <span className="max-[700px]:hidden">{item.cashier || '—'}</span>
            <span className="truncate max-[700px]:hidden" title={item.note || ''}>
              {item.note || '—'}
            </span>
          </div>
        ))}
      </TableCard>
      {confirming && (
        <Modal wide onClose={() => setConfirming(false)}>
          <Eyebrow>CONFIRM DAY END</Eyebrow>
          <h2 className="mb-3 text-[22px]">Close {date}?</h2>
          <p className="mb-2 text-xs text-brand-muted">
            This locks POS sales and signs you out. The next open requires a fresh password login.
          </p>
          <div className="my-3 grid grid-cols-[1fr_auto] gap-x-[18px] gap-y-2.5 border-y border-[#e1e3dd] py-3.5 text-[13px]">
            <span>Recorded</span>
            <strong className="text-right">{money(recorded)}</strong>
            <span>Cash on hand</span>
            <strong className="text-right">{money(Number(cashOnHand || 0))}</strong>
            <span>Variance</span>
            <strong className={`text-right ${variance < 0 ? 'text-brand-danger' : 'text-brand-success'}`}>
              {money(variance)}
            </strong>
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
