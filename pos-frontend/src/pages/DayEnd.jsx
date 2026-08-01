import { useState } from 'react'
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
import { money, today } from '../utils/format'
import { decimalOnly } from '../utils/validate'

function DayEnd() {
  const user = useAuthStore((state) => state.user)
  const transactions = useInventoryStore((state) => state.transactions)
  const dayEnds = useInventoryStore((state) => state.dayEnds)
  const closeDay = useInventoryStore((state) => state.closeDay)
  const date = today()
  const recorded = transactions
    .filter((item) => item.status === 'Paid' && item.date === date)
    .reduce((sum, item) => sum + item.total, 0)
  const existing = dayEnds.find((item) => item.date === date)
  const [cashOnHand, setCashOnHand] = useState(existing ? String(existing.cashOnHand) : '')
  const [note, setNote] = useState(existing?.note || '')
  const [confirming, setConfirming] = useState(false)
  const variance = Number(cashOnHand || 0) - recorded

  const submit = () => {
    closeDay({
      date,
      recordedCash: recorded,
      cashOnHand: Number(cashOnHand || 0),
      variance,
      note,
      cashier: user?.name || 'Staff',
      closedAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    })
    setConfirming(false)
  }

  return (
    <div>
      <PageHeader eyebrow="CASH CONTROL" title="Day end">
        <span className="text-xs text-[#797e7b]">{date}</span>
      </PageHeader>
      <TableCard className="mb-3.5 grid max-h-none gap-4 p-5">
        <div className="grid grid-cols-3 gap-3.5 max-[900px]:grid-cols-1">
          <div>
            <span className="block text-[11px] text-brand-subtle">Recorded cash (POS)</span>
            <strong className="my-2 block text-[22px] text-brand-gold">{money(recorded)}</strong>
            <small className="block text-[11px] text-brand-subtle">Paid sales for today</small>
          </div>
          <Field
            label="Cash on hand"
            inputMode="decimal"
            value={cashOnHand}
            onChange={(event) => setCashOnHand(decimalOnly(event.target.value))}
            placeholder="0.00"
            disabled={Boolean(existing)}
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
          disabled={Boolean(existing)}
        />
        {existing ? (
          <p className="text-[13px] text-brand-muted">
            Day already closed at {existing.closedAt} by {existing.cashier}.
          </p>
        ) : (
          <div>
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
        <div className="grid grid-cols-[1fr_0.9fr_0.9fr_0.9fr_1fr_1.3fr] gap-3 bg-[#f7f7f4] px-5 py-[17px] text-[9px] font-bold tracking-[1px] text-[#989e99] uppercase max-[900px]:grid-cols-[1fr_0.9fr_0.9fr]">
          <span>Date</span>
          <span>Recorded</span>
          <span>On hand</span>
          <span>Variance</span>
          <span className="max-[900px]:hidden">Cashier</span>
          <span className="max-[900px]:hidden">Note</span>
        </div>
        {dayEnds.map((item) => (
          <div
            key={item.id}
            className="grid grid-cols-[1fr_0.9fr_0.9fr_0.9fr_1fr_1.3fr] items-center gap-3 border-t border-brand-softline px-5 py-[17px] text-xs text-brand-slate max-[900px]:grid-cols-[1fr_0.9fr_0.9fr]"
          >
            <strong className="text-brand-ink">{item.date}</strong>
            <span>{money(item.recordedCash)}</span>
            <span>{money(item.cashOnHand)}</span>
            <strong className={item.variance < 0 ? 'text-brand-danger' : 'text-brand-ink'}>
              {money(item.variance)}
            </strong>
            <span className="max-[900px]:hidden">{item.cashier || '—'}</span>
            <span className="truncate max-[900px]:hidden" title={item.note || ''}>
              {item.note || '—'}
            </span>
          </div>
        ))}
      </TableCard>
      {confirming && (
        <Modal wide onClose={() => setConfirming(false)}>
          <Eyebrow>CONFIRM DAY END</Eyebrow>
          <h2 className="mb-3 text-[22px]">Close {date}?</h2>
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
              Confirm close
            </PrimaryButton>
          </ModalActions>
        </Modal>
      )}
    </div>
  )
}

export default DayEnd
