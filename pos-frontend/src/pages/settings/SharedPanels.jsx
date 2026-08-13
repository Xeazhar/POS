import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ErrorBanner, PrimaryButton, StatusBadge, TableCard } from '../../components/ui'
import { LEGAL_DOCS } from '../../legal/meta'
import { useAuthStore } from '../../stores/posStore'
import { useSyncStore } from '../../stores/syncStore'
import { formatSupportError } from '../../utils/errors'
import { APP_ENV, SHOW_ENV_BADGE, environmentLabel } from '../../utils/environment'
import { APP_VERSION_LABEL, IS_PRERELEASE, buildStamp } from '../../utils/version'

function formatWhen(iso) {
  if (!iso) return 'Never'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return 'Never'
  return d.toLocaleString([], {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function syncStateLabel(status, online, reachable) {
  if (!online) return 'Offline — working locally'
  if (!reachable) return 'Device online, server not reachable'
  if (status === 'syncing') return 'Synchronizing…'
  if (status === 'error') return 'Last sync had an error'
  return 'Idle'
}

export function SyncStatusPanel() {
  const user = useAuthStore((s) => s.user)
  const online = useSyncStore((s) => s.online)
  const backendReachable = useSyncStore((s) => s.backendReachable)
  const status = useSyncStore((s) => s.status)
  const pending = useSyncStore((s) => s.pending)
  const blocked = useSyncStore((s) => s.blocked)
  const lastError = useSyncStore((s) => s.lastError)
  const lastPullAt = useSyncStore((s) => s.lastPullAt)
  const lastPushAt = useSyncStore((s) => s.lastPushAt)
  const refresh = useSyncStore((s) => s.refresh)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    void refresh(user?.branchId || null)
  }, [refresh, user?.branchId])

  const lastSuccess = lastPushAt || lastPullAt
  const canSyncNow = Boolean(user?.branchId) && online && backendReachable && !busy

  const onSyncNow = async () => {
    if (!canSyncNow) return
    setError('')
    setBusy(true)
    try {
      const { syncBranch } = await import('../../offline')
      await syncBranch(user.branchId)
      await refresh(user.branchId)
    } catch (err) {
      setError(formatSupportError(err, 'SYNC01'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <TableCard className="max-h-none p-5">
      <h2 className="m-0 mb-1 text-base font-bold">Sync Status</h2>
      <p className="m-0 mb-4 text-xs text-brand-muted">
        This till’s offline queue. Sales stay on the device until they reach the server.
        There is no “clear local data” action here.
      </p>
      {error && <ErrorBanner error={error} className="mb-3" />}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <StatusBadge tone={online && backendReachable ? 'success' : 'danger'}>
          {online && backendReachable ? 'Online' : online ? 'Offline (server unreachable)' : 'Offline'}
        </StatusBadge>
        <span className="text-xs text-brand-muted">{syncStateLabel(status, online, backendReachable)}</span>
      </div>
      {!online || !backendReachable ? (
        <p className="mb-4 rounded-md border border-brand-softline bg-brand-n50 px-3 py-2.5 text-xs leading-relaxed text-brand-muted">
          This POS is operating offline. Transactions and till actions are stored on this
          device and will upload when the connection returns.
        </p>
      ) : null}
      <dl className="grid max-w-xl gap-3 text-sm">
        <div className="rounded-md border border-brand-softline bg-brand-n50 px-3 py-2.5">
          <dt className="text-[10px] font-bold tracking-wide text-brand-label uppercase">Pending</dt>
          <dd className="m-0 mt-0.5 font-semibold tabular-nums text-brand-ink">{pending}</dd>
        </div>
        <div className="rounded-md border border-brand-softline bg-brand-n50 px-3 py-2.5">
          <dt className="text-[10px] font-bold tracking-wide text-brand-label uppercase">Failed / blocked</dt>
          <dd className="m-0 mt-0.5 font-semibold tabular-nums text-brand-ink">{blocked}</dd>
          {blocked > 0 && (
            <dd className="m-0 mt-1 text-[11px] text-brand-danger">
              Saved on this device only. Do not clear browser data. Use Retry on the banner, or
              contact support (SYNC09).
            </dd>
          )}
        </div>
        <div className="rounded-md border border-brand-softline bg-brand-n50 px-3 py-2.5">
          <dt className="text-[10px] font-bold tracking-wide text-brand-label uppercase">Last successful sync</dt>
          <dd className="m-0 mt-0.5 text-brand-ink">{formatWhen(lastSuccess)}</dd>
          <dd className="m-0 mt-1 text-[11px] text-brand-subtle">
            Push {formatWhen(lastPushAt)} · Pull {formatWhen(lastPullAt)}
          </dd>
        </div>
        {lastError ? (
          <div className="rounded-md border border-brand-softline bg-brand-n50 px-3 py-2.5">
            <dt className="text-[10px] font-bold tracking-wide text-brand-label uppercase">Last error</dt>
            <dd className="m-0 mt-0.5 text-xs text-brand-danger">{String(lastError)}</dd>
          </div>
        ) : null}
      </dl>
      <div className="mt-4">
        <PrimaryButton compact type="button" disabled={!canSyncNow} onClick={onSyncNow}>
          {busy ? 'Syncing…' : 'Sync now'}
        </PrimaryButton>
        {!user?.branchId && (
          <p className="mt-2 text-[11px] text-brand-subtle">
            Sync now is available on a till that belongs to a branch.
          </p>
        )}
      </div>
    </TableCard>
  )
}

export function AboutPanel() {
  const year = new Date().getFullYear()
  return (
    <TableCard className="max-h-none p-5">
      <h2 className="m-0 mb-1 text-base font-bold">CalePOS</h2>
      <p className="m-0 mb-4 text-xs text-brand-muted">Point of sale for retail and meat counters.</p>
      <dl className="grid max-w-xl gap-3 text-sm">
        <div className="rounded-md border border-brand-softline bg-brand-n50 px-3 py-2.5">
          <dt className="text-[10px] font-bold tracking-wide text-brand-label uppercase">Version</dt>
          <dd className="m-0 mt-0.5 font-semibold text-brand-ink">{APP_VERSION_LABEL}</dd>
          <dd className="m-0 mt-1 text-[11px] text-brand-subtle">{buildStamp()}</dd>
        </div>
        {IS_PRERELEASE && (
          <div className="rounded-md border border-brand-softline bg-brand-n50 px-3 py-2.5">
            <dt className="text-[10px] font-bold tracking-wide text-brand-label uppercase">Status</dt>
            <dd className="m-0 mt-0.5 font-semibold text-brand-warn">In development — not for live sales</dd>
          </div>
        )}
        {SHOW_ENV_BADGE && (
          <div className="rounded-md border border-brand-softline bg-brand-n50 px-3 py-2.5">
            <dt className="text-[10px] font-bold tracking-wide text-brand-label uppercase">Environment</dt>
            <dd className="m-0 mt-0.5 font-semibold uppercase text-brand-ink">{APP_ENV}</dd>
            <dd className="m-0 mt-1 text-[11px] text-brand-subtle">{environmentLabel()}</dd>
          </div>
        )}
        <div className="rounded-md border border-brand-softline bg-brand-n50 px-3 py-2.5">
          <dt className="text-[10px] font-bold tracking-wide text-brand-label uppercase">Developed by</dt>
          <dd className="m-0 mt-0.5 font-semibold text-brand-ink">Xeazhar</dd>
        </div>
        <div className="rounded-md border border-brand-softline bg-brand-n50 px-3 py-2.5">
          <dt className="text-[10px] font-bold tracking-wide text-brand-label uppercase">Copyright</dt>
          <dd className="m-0 mt-0.5 text-brand-ink">© {year} Xeazhar. All rights reserved.</dd>
        </div>
        <div className="rounded-md border border-brand-softline bg-brand-n50 px-3 py-2.5">
          <dt className="text-[10px] font-bold tracking-wide text-brand-label uppercase">Legal</dt>
          <dd className="m-0 mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[13px]">
            <Link
              to={LEGAL_DOCS.terms.path}
              className="font-medium text-brand-ink underline-offset-2 hover:underline"
            >
              {LEGAL_DOCS.terms.label}
            </Link>
            <Link
              to={LEGAL_DOCS.privacy.path}
              className="font-medium text-brand-ink underline-offset-2 hover:underline"
            >
              {LEGAL_DOCS.privacy.label}
            </Link>
          </dd>
        </div>
      </dl>
    </TableCard>
  )
}

export function MyAccountPanel() {
  const user = useAuthStore((s) => s.user)
  return (
    <TableCard className="max-h-none p-5">
      <h2 className="m-0 mb-1 text-base font-bold">Employee Information</h2>
      <p className="m-0 mb-4 text-xs text-brand-muted">
        Your account on this till. Ask a manager to change your name, role, or PIN — Staff
        is the only place PINs are reset, and you cannot change your own PIN here.
      </p>
      <dl className="grid max-w-xl gap-3 text-sm">
        <div className="rounded-md border border-brand-softline bg-brand-n50 px-3 py-2.5">
          <dt className="text-[10px] font-bold tracking-wide text-brand-label uppercase">Name</dt>
          <dd className="m-0 mt-0.5 font-semibold text-brand-ink">{user?.name || '—'}</dd>
        </div>
        <div className="rounded-md border border-brand-softline bg-brand-n50 px-3 py-2.5">
          <dt className="text-[10px] font-bold tracking-wide text-brand-label uppercase">Role</dt>
          <dd className="m-0 mt-0.5 font-semibold capitalize text-brand-ink">{user?.role || '—'}</dd>
        </div>
        <div className="rounded-md border border-brand-softline bg-brand-n50 px-3 py-2.5">
          <dt className="text-[10px] font-bold tracking-wide text-brand-label uppercase">Branch</dt>
          <dd className="m-0 mt-0.5 font-semibold text-brand-ink">{user?.branchName || '—'}</dd>
        </div>
        {user?.loginCode ? (
          <div className="rounded-md border border-brand-softline bg-brand-n50 px-3 py-2.5">
            <dt className="text-[10px] font-bold tracking-wide text-brand-label uppercase">Login code</dt>
            <dd className="m-0 mt-0.5 font-semibold tabular-nums text-brand-ink">{user.loginCode}</dd>
          </div>
        ) : null}
      </dl>
    </TableCard>
  )
}
