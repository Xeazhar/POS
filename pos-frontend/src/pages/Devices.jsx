import { useEffect, useState } from 'react'
import { FiBluetooth, FiHardDrive, FiPrinter } from 'react-icons/fi'
import { Eyebrow, PageHeader, TableCard } from '../components/ui'
import { getAllDeviceStatuses, isDeviceEnabled, normalizeDeviceSettings } from '../devices'
import { hasSupabase, reportBranchDevices } from '../lib/api'
import { useAuthStore } from '../stores/posStore'

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
      <TableCard className="max-h-none">
        <div className="border-b border-brand-softline px-5 py-4">
          <Eyebrow>PERIPHERALS</Eyebrow>
          <p className="m-0 mt-1 text-xs text-brand-muted">
            Connection status for this till. If a device is Off, ask a manager to enable it when hardware is ready.
          </p>
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
                      {!enabled ? 'Disabled by manager' : device.detail || device.state}
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
