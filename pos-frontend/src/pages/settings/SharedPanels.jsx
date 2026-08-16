import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ErrorBanner, PrimaryButton, SecondaryButton, StatusBadge, TableCard, ToggleSwitch } from '../../components/ui'
import { LEGAL_DOCS } from '../../legal/meta'
import { useAuthStore, useInventoryStore, useProductStore } from '../../stores/posStore'
import { useSyncStore } from '../../stores/syncStore'
import { useThemeStore } from '../../stores/themeStore'
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
  if (!online) return 'Offline: working locally'
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
  const [resyncBusy, setResyncBusy] = useState(false)
  const [resyncMessage, setResyncMessage] = useState(null) // { tone: 'ok' | 'danger', text }

  useEffect(() => {
    void refresh(user?.branchId || null)
  }, [refresh, user?.branchId])

  const lastSuccess = lastPushAt || lastPullAt
  const canSyncNow = Boolean(user?.branchId) && online && backendReachable && !busy
  // Same as canSyncNow, plus the outbox must be fully drained — hardResync() enforces this
  // itself, but disabling the button here means a queued/blocked till never even sees an
  // error message inviting it to try something unsafe.
  const canHardResync =
    Boolean(user?.branchId) && online && backendReachable && pending === 0 && blocked === 0 && !resyncBusy

  const onSyncNow = async () => {
    if (!canSyncNow) return
    setError('')
    setBusy(true)
    try {
      const { syncBranch } = await import('../../offline')
      const result = await syncBranch(user.branchId)
      // syncBranch() only pulls fresh transactions/movements/day-ends when the outbox is
      // already drained (see hardResync()'s doc comment in syncEngine.js) — when it does,
      // this is what actually shows up on Transactions/DayEnd; without it, "Sync now" only
      // moved the status indicators below, not anything a cashier or manager would look at.
      if (result) useInventoryStore.getState().hydrate(result)
      await refresh(user.branchId)
    } catch (err) {
      setError(formatSupportError(err, 'SYNC01'))
    } finally {
      setBusy(false)
    }
  }

  const onHardResync = async () => {
    if (!canHardResync) return
    setResyncMessage(null)
    setResyncBusy(true)
    try {
      const { hardResync } = await import('../../offline')
      const result = await hardResync(user.branchId)
      useInventoryStore.getState().hydrate(result)
      useProductStore.getState().setProducts(result.products || [])
      await refresh(user.branchId)
      setResyncMessage({
        tone: 'ok',
        text: `Resynced: ${result.transactions.length} transaction${result.transactions.length === 1 ? '' : 's'}, ${result.dayEnds.length} day-end${result.dayEnds.length === 1 ? '' : 's'} on this device now match the server.`,
      })
    } catch (err) {
      setResyncMessage({ tone: 'danger', text: formatSupportError(err, 'SYNC10') })
    } finally {
      setResyncBusy(false)
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
      <div className="mt-4 border-t border-brand-softline pt-4">
        <p className="m-0 mb-2 text-[10px] font-bold tracking-wide text-brand-label uppercase">
          Hard resync
        </p>
        <p className="m-0 mb-2.5 max-w-xl text-[11px] text-brand-muted">
          Replaces this device&apos;s local sales, shifts and day-ends with a fresh copy from the
          server. Only for when this till&apos;s lists look stale after the server changed some
          other way (e.g. a data reset) — normal sync already keeps this device current on its
          own. Only enabled when nothing is queued.
        </p>
        {resyncMessage && (
          <p
            className={`m-0 mb-2.5 text-[11px] ${
              resyncMessage.tone === 'danger' ? 'text-brand-danger' : 'text-brand-success-text'
            }`}
          >
            {resyncMessage.text}
          </p>
        )}
        <SecondaryButton compact type="button" disabled={!canHardResync} onClick={() => void onHardResync()}>
          {resyncBusy ? 'Resyncing…' : 'Hard resync'}
        </SecondaryButton>
        {(pending > 0 || blocked > 0) && (
          <p className="mt-2 text-[11px] text-brand-subtle">
            {pending + blocked} item{pending + blocked === 1 ? '' : 's'} still queued, let them
            sync first.
          </p>
        )}
      </div>
    </TableCard>
  )
}

export function AppearancePanel() {
  const theme = useThemeStore((s) => s.theme)
  const setDark = useThemeStore((s) => s.setDark)
  return (
    <TableCard className="max-h-none p-5">
      <h2 className="m-0 mb-1 text-base font-bold">Appearance</h2>
      <p className="m-0 mb-4 text-xs text-brand-muted">
        Light or dark surfaces on this till only. Not synced to your account or other devices.
      </p>
      <div className="flex max-w-xl items-center justify-between gap-3 rounded-md border border-brand-softline bg-brand-n50 px-3 py-2.5">
        <div className="min-w-0">
          <p className="m-0 text-[10px] font-bold tracking-wide text-brand-label uppercase">Dark mode</p>
          <p className="m-0 mt-0.5 text-xs text-brand-muted">Switch this device to a dark theme.</p>
        </div>
        <ToggleSwitch checked={theme === 'dark'} onChange={setDark} label="Dark mode" />
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
            <dd className="m-0 mt-0.5 font-semibold text-brand-warn">In development / not for live sales</dd>
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
        Your account on this till. Ask a manager to change your name, role, or PIN. Staff
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
