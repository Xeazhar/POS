import { useEffect, useState } from 'react'
import { FiBluetooth, FiHardDrive, FiPrinter } from 'react-icons/fi'
import { Eyebrow, PageHeader, PrimaryButton, TableCard } from '../components/ui'
import { cashDrawer, getAllDeviceStatuses, isDeviceEnabled, normalizeDeviceSettings } from '../devices'
import { hasSupabase, reportBranchDevices } from '../lib/api'
import { useAuthStore } from '../stores/posStore'
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

  useEffect(() => {
    let active = true
    getAllDeviceStatuses(settings)
      .then(async (rows) => {
        if (!active) return
        setDevices(rows)
        if (hasSupabase && user?.branchId) {
          await reportBranchDevices(user.branchId, rows)
        }
      })
      .catch((err) => {
        if (active) setError(err.message)
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
          {devices.map((device) => {
            const Icon = ICONS[device.id] || FiHardDrive
            const enabled = device.enabled === true && isDeviceEnabled(settings, device.id)
            const connected = enabled && device.state === 'connected'
            return (
              <div
                key={device.id}
                className="flex items-center justify-between gap-4 border-t border-brand-softline px-5 py-4 first:border-t-0"
              >
                <div className="flex items-center gap-3">
                  <span
                    className={`grid h-10 w-10 place-items-center rounded-lg text-brand-ink ${
                      enabled ? 'bg-[#f3f4f1]' : 'bg-[#eceee9] opacity-70'
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
                <span
                  className={`rounded-md px-2.5 py-1 text-[11px] font-bold ${
                    !enabled
                      ? 'bg-[#eceee9] text-brand-muted'
                      : connected
                        ? 'bg-[#e7f3ea] text-[#2f6b3c]'
                        : 'bg-[#eceee9] text-brand-muted'
                  }`}
                >
                  {!enabled ? 'Off' : connected ? 'Connected' : 'Not Connected'}
                </span>
              </div>
            )
          })}
        </div>
      </TableCard>
    </div>
  )
}

export default Devices
