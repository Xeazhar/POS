import { useEffect, useState } from 'react'
import { ErrorBanner, Field, PrimaryButton, TableCard } from '../../components/ui'
import { fetchCompanyProfile, hasSupabase, logAuditEvent, saveCompanyProfile } from '../../lib/api'
import { useAuthStore } from '../../stores/posStore'
import { formatSupportError } from '../../utils/errors'
import { VAT_RATE_DEFAULT } from '../../utils/vat'

export function BusinessInformationPanel() {
  const user = useAuthStore((s) => s.user)
  const [form, setForm] = useState({ businessName: '', tin: '', address: '' })
  const [loading, setLoading] = useState(() => hasSupabase)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    if (!hasSupabase) return undefined
    let active = true
    fetchCompanyProfile({ force: true })
      .then((row) => {
        if (!active) return
        setForm({
          businessName: row?.business_name || '',
          tin: row?.tin || '',
          address: row?.address || '',
        })
      })
      .catch((err) => {
        if (active) setError(formatSupportError(err))
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [])

  const onSave = async (event) => {
    event.preventDefault()
    setError('')
    setSaved(false)
    setSaving(true)
    try {
      await saveCompanyProfile({
        businessName: form.businessName.trim() || null,
        tin: form.tin.trim() || null,
        address: form.address.trim() || null,
      })
      await logAuditEvent({
        branchId: user?.branchId || null,
        staffId: user?.id || null,
        eventType: 'company_profile_updated',
        detail: 'Updated company profile (business name / TIN / address)',
      })
      setSaved(true)
    } catch (err) {
      setError(formatSupportError(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <TableCard className="max-h-none p-5">
      <h2 className="m-0 mb-1 text-base font-bold">Business Information</h2>
      <p className="m-0 mb-4 text-xs text-brand-muted">
        Company-wide identity for receipts and invoices. Branch names, BIR branch codes, and
        invoice prefixes stay on each branch dashboard.
      </p>
      {error && <ErrorBanner error={error} className="mb-3" />}
      {saved && <p className="mb-3 text-xs text-brand-success">Saved. New receipts will use this identity.</p>}
      {loading ? (
        <p className="m-0 text-xs text-brand-muted">Loading…</p>
      ) : (
        <form className="grid max-w-xl gap-3" onSubmit={onSave}>
          <Field
            label="Business name"
            required
            value={form.businessName}
            onChange={(e) => setForm({ ...form, businessName: e.target.value })}
          />
          <Field
            label="Registered address"
            value={form.address}
            onChange={(e) => setForm({ ...form, address: e.target.value })}
          />
          <Field
            label="Company TIN"
            value={form.tin}
            onChange={(e) => setForm({ ...form, tin: e.target.value })}
            placeholder="000-000-000"
          />
          <p className="-mt-1 text-[11px] text-brand-muted">
            One TIN for the business. Each branch appends its BIR branch code on the invoice
            (Settings does not edit those codes).
          </p>
          <p className="m-0 text-[11px] text-brand-subtle">
            Contact on receipts uses this registered address. A separate phone/email field and
            a business logo are not in the company profile today.
          </p>
          <div>
            <PrimaryButton compact type="submit" disabled={saving || !hasSupabase}>
              {saving ? 'Saving…' : 'Save'}
            </PrimaryButton>
          </div>
        </form>
      )}
    </TableCard>
  )
}

export function TaxVatPanel() {
  const pct = Math.round(VAT_RATE_DEFAULT * 100)
  return (
    <TableCard className="max-h-none p-5">
      <h2 className="m-0 mb-1 text-base font-bold">Tax &amp; VAT</h2>
      <p className="m-0 mb-4 text-xs text-brand-muted">
        BIR VAT as implemented in CalePOS. This page does not change how tax is computed.
      </p>
      <dl className="grid max-w-xl gap-3 text-sm">
        <div className="rounded-md border border-brand-softline bg-brand-n50 px-3 py-2.5">
          <dt className="text-[10px] font-bold tracking-wide text-brand-label uppercase">VAT rate</dt>
          <dd className="m-0 mt-0.5 font-semibold text-brand-ink">{pct}% VAT-inclusive shelf prices</dd>
        </div>
        <div className="rounded-md border border-brand-softline bg-brand-n50 px-3 py-2.5">
          <dt className="text-[10px] font-bold tracking-wide text-brand-label uppercase">How it is applied</dt>
          <dd className="m-0 mt-0.5 text-xs leading-relaxed text-brand-muted">
            Prices on the till already include VAT. Output VAT is backed out of VATable lines.
            There is no per-branch rate — every branch uses this {pct}% configuration.
          </dd>
        </div>
        <div className="rounded-md border border-brand-softline bg-brand-n50 px-3 py-2.5">
          <dt className="text-[10px] font-bold tracking-wide text-brand-label uppercase">SC / PWD</dt>
          <dd className="m-0 mt-0.5 text-xs leading-relaxed text-brand-muted">
            On eligible lines, VAT is stripped first, then 20% is taken of the VAT-exclusive
            amount. The line is VAT-exempt. Promo price is the base; discounts are not stacked.
          </dd>
        </div>
        <div className="rounded-md border border-brand-softline bg-brand-n50 px-3 py-2.5">
          <dt className="text-[10px] font-bold tracking-wide text-brand-label uppercase">Company TIN</dt>
          <dd className="m-0 mt-0.5 text-xs leading-relaxed text-brand-muted">
            Edited under Business Information. Branch TIN codes stay on each branch dashboard.
          </dd>
        </div>
      </dl>
    </TableCard>
  )
}

export function ReceiptsInvoicesPanel() {
  return (
    <TableCard className="max-h-none p-5">
      <h2 className="m-0 mb-1 text-base font-bold">Receipts &amp; Invoices</h2>
      <p className="m-0 mb-4 text-xs text-brand-muted">
        What prints on the sales invoice. Header identity comes from the company profile.
        Branch-specific BIR fields and invoice numbering stay on the branch — this page does not
        change invoice sequences.
      </p>
      <dl className="grid max-w-xl gap-3 text-sm">
        <div className="rounded-md border border-brand-softline bg-brand-n50 px-3 py-2.5">
          <dt className="text-[10px] font-bold tracking-wide text-brand-label uppercase">Document</dt>
          <dd className="m-0 mt-0.5 font-semibold text-brand-ink">SALES INVOICE</dd>
          <dd className="m-0 mt-1 text-[11px] text-brand-muted">
            EOPT / RR 7-2024: the primary sales document is an invoice, not an Official Receipt.
          </dd>
        </div>
        <div className="rounded-md border border-brand-softline bg-brand-n50 px-3 py-2.5">
          <dt className="text-[10px] font-bold tracking-wide text-brand-label uppercase">Header</dt>
          <dd className="m-0 mt-0.5 text-xs leading-relaxed text-brand-muted">
            Business name, registered address, and composed TIN (company TIN + branch code).
            Edit the company fields under Business Information.
          </dd>
        </div>
        <div className="rounded-md border border-brand-softline bg-brand-n50 px-3 py-2.5">
          <dt className="text-[10px] font-bold tracking-wide text-brand-label uppercase">Per branch (not here)</dt>
          <dd className="m-0 mt-0.5 text-xs leading-relaxed text-brand-muted">
            BIR permit, machine ID, serial number, invoice prefix, and the offline invoice
            counter live on Branches → that branch. Tills assign invoice numbers locally; sync
            reserves the same number on the server.
          </dd>
        </div>
        <div className="rounded-md border border-brand-softline bg-brand-n50 px-3 py-2.5">
          <dt className="text-[10px] font-bold tracking-wide text-brand-label uppercase">Footer</dt>
          <dd className="m-0 mt-0.5 text-xs leading-relaxed text-brand-muted">
            “Thank you for your purchase.” and a system-generated note naming CalePOS. Custom
            footer lines are not stored on the company profile.
          </dd>
        </div>
      </dl>
    </TableCard>
  )
}
