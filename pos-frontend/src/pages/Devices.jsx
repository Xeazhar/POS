import { useEffect, useState } from 'react'
import { FiBluetooth, FiHardDrive, FiPrinter } from 'react-icons/fi'
import { Eyebrow, Field, PageHeader, PrimaryButton, SkeletonRows, StatusBadge, TableCard, tableRowClass } from '../components/ui'
import { cashDrawer, getAllDeviceStatuses, isDeviceEnabled, normalizeDeviceSettings } from '../devices'
import { hasSupabase, reportBranchDevices } from '../lib/api'
import { useAuthStore } from '../stores/posStore'
import { getDrawerId, getDrawerLabel, setDrawerId, setDrawerLabel } from '../utils/drawer'
import { formatSupportError } from '../utils/errors'

const ICONS = {
  'barcode-scanner': FiHardDrive,
  'receipt-printer': FiPrinter,
  'cash-drawer': FiBluetooth,
}

function Devices() {
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
      <PageHeader eyebrow="SETTINGS" title="Devices">
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
