import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { FiBluetooth, FiHardDrive, FiPrinter } from 'react-icons/fi'
import {
  Eyebrow,
  Field,
  PageHeader,
  PrimaryButton,
  SkeletonRows,
  StatusBadge,
  TableCard,
  tableHeadClass,
  tableRowClass,
} from '../components/ui'
import {
  BRANCH_DEVICES,
  cashDrawer,
  getAllDeviceStatuses,
  isDeviceEnabled,
  isTelemetryFresh,
  normalizeDeviceSettings,
} from '../devices'
import { fetchBranches, fetchBranchTelemetry, hasSupabase, reportBranchDevices } from '../lib/api'
import { useAuthStore } from '../stores/posStore'
import { getDrawerId, getDrawerLabel, setDrawerId, setDrawerLabel } from '../utils/drawer'
import { formatSupportError } from '../utils/errors'
import { isManagerRole } from '../utils/roles'

const ICONS = {
  'barcode-scanner': FiHardDrive,
  'receipt-printer': FiPrinter,
  'cash-drawer': FiBluetooth,
}

const DEVICE_POLL_MS = 30_000

function formatSeen(iso) {
  if (!iso) return 'Never'
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return 'Never'
  const ms = Date.now() - t
  if (ms < 60_000) return 'Just now'
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`
  return new Date(iso).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}

function tillOnline(presence) {
  if (!presence) return false
  if (presence.is_online === false) return false
  return isTelemetryFresh(presence.last_seen_at || presence.updated_at)
}

function deviceNetworkStatus({ enabled, tillUp, telemetry }) {
  if (!enabled) return { label: 'Off', tone: 'neutral' }
  if (!tillUp) return { label: 'Till offline', tone: 'neutral' }
  const fresh = isTelemetryFresh(telemetry?.updatedAt)
  if (fresh && telemetry?.state === 'connected') return { label: 'Connected', tone: 'success' }
  return { label: 'Not connected', tone: 'warn' }
}

function Devices() {
  const user = useAuthStore((state) => state.user)
  if (isManagerRole(user?.role)) return <NetworkDevicesOverview />
  return <TillDevices />
}

function NetworkDevicesOverview() {
  const [branches, setBranches] = useState([])
  const [presence, setPresence] = useState({})
  const [devicesByBranch, setDevicesByBranch] = useState({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true

    const load = async ({ silent = false } = {}) => {
      if (!hasSupabase) {
        if (active) {
          setLoading(false)
          setError('Connect to the cloud to see branch device status.')
        }
        return
      }
      try {
        if (!silent && active) setError('')
        const rows = await fetchBranches({ includeCompany: false })
        const ids = (rows || []).map((row) => row.id)
        const tel = ids.length ? await fetchBranchTelemetry(ids) : { presence: {}, devices: {} }
        if (!active) return
        setBranches(rows || [])
        setPresence(tel.presence || {})
        setDevicesByBranch(tel.devices || {})
        setLoading(false)
      } catch (err) {
        if (active) {
          setError(formatSupportError(err))
          setLoading(false)
        }
      }
    }

    load()
    const poll = window.setInterval(() => load({ silent: true }), DEVICE_POLL_MS)
    return () => {
      active = false
      window.clearInterval(poll)
    }
  }, [])

  const ordered = [...branches].sort((a, b) => {
    const aOff = a.is_active === false ? 1 : 0
    const bOff = b.is_active === false ? 1 : 0
    if (aOff !== bOff) return aOff - bOff
    return String(a.name || '').localeCompare(String(b.name || ''))
  })

  return (
    <div>
      <PageHeader eyebrow="NETWORK" title="Devices">
        <span className="text-xs text-brand-subtle">
          Till presence and hardware status per branch. Enable or disable a device on that
          branch dashboard.
        </span>
      </PageHeader>
      {error && <p className="mb-3 text-xs text-brand-danger">{error}</p>}
      <TableCard className="max-h-none">
        <div className="border-b border-brand-softline px-5 py-4">
          <Eyebrow>BRANCH STATUS</Eyebrow>
          <p className="m-0 mt-1 text-xs text-brand-muted">
            A till is online while a cashier app is open and heartbeating. Device rows come
            from that till. Stale reports older than a few minutes count as not connected.
          </p>
        </div>
        {loading ? (
          <div className="px-5 py-4">
            <SkeletonRows rows={4} cols={5} />
          </div>
        ) : !ordered.length ? (
          <p className="px-5 py-4 text-xs text-brand-muted">No branches yet.</p>
        ) : (
          <table className="w-full text-left text-xs">
            <thead>
              <tr>
                <th className={`${tableHeadClass} px-5 py-2`}>Branch</th>
                <th className={`${tableHeadClass} px-3 py-2`}>Till</th>
                {BRANCH_DEVICES.map((device) => (
                  <th key={device.key} className={`${tableHeadClass} px-3 py-2`}>
                    {device.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {ordered.map((branch) => {
                const settings = normalizeDeviceSettings(branch.device_settings)
                const rowPresence = presence[branch.id]
                const online = tillOnline(rowPresence)
                const lastSeen = rowPresence?.last_seen_at || rowPresence?.updated_at
                const list = devicesByBranch[branch.id] || []
                const byKey = Object.fromEntries(list.map((row) => [row.key, row]))
                return (
                  <tr key={branch.id} className={tableRowClass}>
                    <td className="px-5 py-2.5">
                      <Link
                        to={`/manager/branches/${branch.id}`}
                        className="font-semibold text-brand-ink no-underline hover:underline"
                      >
                        {branch.name}
                      </Link>
                      {branch.is_active === false && (
                        <span className="ml-2 text-[10px] font-bold tracking-wide text-brand-muted uppercase">
                          Inactive
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2.5">
                      <StatusBadge compact tone={online ? 'success' : 'neutral'}>
                        {online ? 'Online' : 'Offline'}
                      </StatusBadge>
                      <span className="mt-1 block text-[10px] text-brand-subtle">
                        {online ? 'Heartbeating' : `Last seen ${formatSeen(lastSeen)}`}
                      </span>
                    </td>
                    {BRANCH_DEVICES.map((device) => {
                      const status = deviceNetworkStatus({
                        enabled: settings[device.key] === true,
                        tillUp: online,
                        telemetry: byKey[device.key],
                      })
                      return (
                        <td key={device.key} className="px-3 py-2.5">
                          <StatusBadge compact tone={status.tone}>
                            {status.label}
                          </StatusBadge>
                        </td>
                      )
                    })}
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </TableCard>
    </div>
  )
}

function TillDevices() {
  const user = useAuthStore((state) => state.user)
  const settings = normalizeDeviceSettings(user?.deviceSettings)
  const [devices, setDevices] = useState([])
  const [error, setError] = useState('')
  const [drawerMsg, setDrawerMsg] = useState('')
  const [drawerBusy, setDrawerBusy] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true
    setLoading(true)
    getAllDeviceStatuses(settings)
      .then(async (rows) => {
        if (!active) return
        setDevices(rows)
        setLoading(false)
        if (hasSupabase && user?.branchId) {
          await reportBranchDevices(user.branchId, rows)
        }
      })
      .catch((err) => {
        if (active) {
          setError(err.message)
          setLoading(false)
        }
      })
    return () => {
      active = false
    }
  }, [user?.branchId, settings.barcode_scanner, settings.receipt_printer, settings.cash_drawer])

  return (
    <div>
      <PageHeader eyebrow="TILL" title="Devices">
        <span className="text-xs text-brand-subtle">
          This till — managers enable/disable devices under Branches
        </span>
      </PageHeader>
      {error && <p className="mb-3 text-xs text-brand-danger">{error}</p>}
      {drawerMsg && <p className="mb-3 text-xs text-brand-muted">{drawerMsg}</p>}
      <TableCard className="max-h-none">
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-brand-softline px-5 py-4">
          <div>
            <Eyebrow>PERIPHERALS</Eyebrow>
            <p className="m-0 mt-1 text-xs text-brand-muted">
              Connection status for this till. If a device is Off, ask a manager to enable it when hardware is ready.
            </p>
          </div>
          <PrimaryButton
            compact
            type="button"
            disabled={drawerBusy || !isDeviceEnabled(settings, 'cash_drawer')}
            onClick={async () => {
              setDrawerBusy(true)
              setDrawerMsg('')
              try {
                await cashDrawer.openDrawer()
                setDrawerMsg('Drawer open signal sent.')
              } catch (err) {
                setDrawerMsg(
                  formatSupportError(
                    {
                      message:
                        err.message ||
                        'Cash drawer kick not wired yet — open the drawer manually for now.',
                      code: 'DEV05',
                    },
                    'DEV05',
                  ),
                )
              } finally {
                setDrawerBusy(false)
              }
            }}
          >
            {drawerBusy ? 'Opening…' : 'Open drawer'}
          </PrimaryButton>
        </div>
        <div className="grid gap-0">
          {loading ? (
            <SkeletonRows rows={3} cols={3} />
          ) : (
          devices.map((device) => {
            const Icon = ICONS[device.id] || FiHardDrive
            const enabled = device.enabled === true && isDeviceEnabled(settings, device.id)
            const connected = enabled && device.state === 'connected'
            return (
              <div
                key={device.id}
                className={`flex items-center justify-between gap-4 px-5 py-4 first:border-t-0 ${tableRowClass}`}
              >
                <div className="flex items-center gap-3">
                  <span
                    className={`grid h-10 w-10 place-items-center rounded-lg text-brand-ink ${
                      enabled ? 'bg-brand-n100' : 'bg-brand-n200 opacity-70'
                    }`}
                  >
                    <Icon className="text-lg" />
                  </span>
                  <div>
                    <strong className="block text-sm text-brand-ink">{device.label}</strong>
                    <small className="text-[11px] text-brand-subtle">
                      {!enabled
                        ? 'Disabled by manager'
                        : connected
                          ? 'Enabled by manager · Connected'
                          : 'Enabled by manager · Not connected'}
                    </small>
                  </div>
                </div>
                <StatusBadge
                  tone={!enabled ? 'neutral' : connected ? 'success' : 'neutral'}
                  className="min-w-0 rounded-md px-2.5 py-1 text-[11px]"
                >
                  {!enabled ? 'Off' : connected ? 'Connected' : 'Not Connected'}
                </StatusBadge>
              </div>
            )
          })
          )}
        </div>
      </TableCard>

      <DrawerIdentityCard />
    </div>
  )
}

/**
 * Which physical drawer this terminal belongs to.
 *
 * Only matters for a branch running more than one till at once. Every device defaults to
 * the same drawer `main`, which is correct when several devices share one cash box — it
 * is what stops two cashiers counting into the same drawer without either being told.
 * Give a second till its own id only when it has its own separate cash box, otherwise the
 * accountability this exists for quietly stops applying.
 */
function DrawerIdentityCard() {
  const [label, setLabel] = useState(() => getDrawerLabel())
  const [id, setId] = useState(() => getDrawerId())
  const [saved, setSaved] = useState('')

  return (
    <TableCard className="mt-3.5 max-h-none p-5">
      <Eyebrow>CASH DRAWER</Eyebrow>
      <h2 className="m-0 mb-1 text-base">This terminal&apos;s drawer</h2>
      <p className="m-0 mb-3 text-xs text-brand-muted">
        Shifts are counted per drawer. Leave this alone if the branch has one cash box — even
        with several devices, they all belong to the same drawer. Change it only for a till
        with its own separate cash box.
      </p>
      <div className="grid grid-cols-[1fr_1fr_auto] items-end gap-2 max-[700px]:grid-cols-1">
        <Field label="Drawer name" value={label} onChange={(e) => setLabel(e.target.value)} />
        <Field
          label="Drawer id (letters, numbers, - and _)"
          value={id}
          onChange={(e) => setId(e.target.value)}
        />
        <PrimaryButton
          compact
          type="button"
          onClick={() => {
            setLabel(setDrawerLabel(label))
            setId(setDrawerId(id))
            setSaved('Saved on this device. It takes effect on the next shift start.')
          }}
        >
          Save
        </PrimaryButton>
      </div>
      {saved && <p className="m-0 mt-2 text-[11px] text-brand-muted">{saved}</p>}
    </TableCard>
  )
}

export default Devices
