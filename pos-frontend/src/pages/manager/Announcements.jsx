import { useEffect, useState } from 'react'
import { createAnnouncement, fetchAnnouncements, fetchBranches, hasSupabase, updateAnnouncement } from '../../lib/api'
import { useAuthStore } from '../../stores/posStore'
import { ANNOUNCEMENT_EMOJI, ANNOUNCEMENT_KINDS } from '../../utils/announcements'
import {
  Field,
  PageHeader,
  PageSkeleton,
  PrimaryButton,
  SelectField,
  StatusBadge,
  TableCard,
  ToggleSwitch,
} from '../../components/ui'

const EMPTY_FORM = { branchId: '', kind: 'general', title: '', body: '', expiresAt: '' }

function formatWhen(iso) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

/**
 * Manager-authored announcements — posted here, read by staff on CashierDashboard.jsx.
 * A branch is picked per post ("All branches" = network-wide); managers aren't branch-
 * siloed anywhere else in the app (see is_manager() usage) so the branch list is unfiltered.
 */
function ManagerAnnouncements() {
  const user = useAuthStore((state) => state.user)
  const [branches, setBranches] = useState([])
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(hasSupabase)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [form, setForm] = useState(EMPTY_FORM)

  const reload = () =>
    fetchAnnouncements({ limit: 50 })
      .then(setRows)
      .catch((err) => setError(err.message || 'Could not load announcements'))

  useEffect(() => {
    if (!hasSupabase) return
    fetchBranches().then(setBranches).catch(() => {})
    reload().finally(() => setLoading(false))
  }, [])

  const submit = async (e) => {
    e.preventDefault()
    if (!form.title.trim() || !form.body.trim()) return
    setSaving(true)
    setError('')
    try {
      await createAnnouncement({
        branchId: form.branchId || null,
        authorId: user.id,
        kind: form.kind,
        title: form.title,
        body: form.body,
        expiresAt: form.expiresAt ? new Date(`${form.expiresAt}T23:59:59`).toISOString() : null,
      })
      setForm(EMPTY_FORM)
      await reload()
    } catch (err) {
      setError(err.message || 'Could not post announcement')
    } finally {
      setSaving(false)
    }
  }

  const toggleActive = async (row) => {
    const next = !row.isActive
    setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, isActive: next } : r)))
    try {
      await updateAnnouncement(row.id, { isActive: next })
    } catch (err) {
      setError(err.message || 'Could not update announcement')
      await reload()
    }
  }

  if (loading) return <PageSkeleton variant="dashboard" />

  return (
    <div className="overflow-auto pt-2.5 pb-[18px]">
      <PageHeader eyebrow="STAFF COMMUNICATION" title="Announcements" />

      {error && (
        <div className="mb-3.5 rounded-[10px] border border-brand-danger bg-brand-danger-bg px-4 py-3 text-xs text-brand-danger">
          {error}
        </div>
      )}

      <TableCard className="mb-3.5 max-h-none overflow-visible p-5">
        <h2 className="m-0 mb-3 text-base text-brand-ink">New announcement</h2>
        <form onSubmit={submit} className="grid grid-cols-2 gap-3.5 max-[700px]:grid-cols-1">
          <SelectField
            label="Category"
            value={form.kind}
            onChange={(e) => setForm((f) => ({ ...f, kind: e.target.value }))}
          >
            {ANNOUNCEMENT_KINDS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.emoji} {k.label}
              </option>
            ))}
          </SelectField>
          <SelectField
            label="Branch"
            value={form.branchId}
            onChange={(e) => setForm((f) => ({ ...f, branchId: e.target.value }))}
          >
            <option value="">All branches (network-wide)</option>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </SelectField>
          <Field
            label="Title"
            className="col-span-2"
            value={form.title}
            onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
            maxLength={120}
            required
          />
          <label className="col-span-2 block text-[11px] font-medium text-brand-n700">
            Message
            <textarea
              className="mt-[7px] block w-full resize-y rounded-[5px] border border-brand-input bg-brand-card p-2.5 text-[13px] font-normal outline-none"
              rows={3}
              maxLength={500}
              value={form.body}
              onChange={(e) => setForm((f) => ({ ...f, body: e.target.value }))}
              required
            />
          </label>
          <Field
            label="Expires (optional)"
            type="date"
            value={form.expiresAt}
            onChange={(e) => setForm((f) => ({ ...f, expiresAt: e.target.value }))}
          />
          <div className="flex items-end">
            <PrimaryButton type="submit" compact disabled={saving}>
              {saving ? 'Posting…' : 'Post announcement'}
            </PrimaryButton>
          </div>
        </form>
      </TableCard>

      <TableCard className="max-h-none overflow-hidden p-0">
        <div className="border-b border-brand-line bg-brand-card px-4 py-3.5">
          <h2 className="m-0 text-lg font-semibold tracking-[-0.02em] text-brand-ink">Posted</h2>
        </div>
        {rows.length === 0 ? (
          <p className="m-0 px-4 py-4 text-center text-xs text-brand-muted">No announcements yet.</p>
        ) : (
          rows.map((row) => (
            <div
              key={row.id}
              className="flex items-center justify-between gap-3 border-t border-brand-softline px-4 py-3 text-xs"
            >
              <div className="min-w-0">
                <strong className="block text-brand-ink">
                  {ANNOUNCEMENT_EMOJI[row.kind] || '📌'} {row.title}
                </strong>
                <span className="mt-0.5 block text-[11px] text-brand-muted">{row.body}</span>
                <span className="mt-1 block text-[10px] text-brand-subtle">
                  {row.branchName || 'All branches'} · {row.authorName || 'Manager'} · {formatWhen(row.createdAt)}
                  {row.expiresAt ? ` · Expires ${new Date(row.expiresAt).toLocaleDateString()}` : ''}
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <StatusBadge compact tone={row.isActive ? 'success' : 'neutral'}>
                  {row.isActive ? 'Active' : 'Inactive'}
                </StatusBadge>
                <ToggleSwitch
                  checked={row.isActive}
                  onChange={() => toggleActive(row)}
                  label={row.isActive ? 'Deactivate' : 'Activate'}
                />
              </div>
            </div>
          ))
        )}
      </TableCard>
    </div>
  )
}

export default ManagerAnnouncements
