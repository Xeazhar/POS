import { useState } from 'react'
import { Eyebrow, Field, Modal, ModalActions, PrimaryButton, SecondaryButton, ErrorBanner } from '../ui'
import { verifySupervisorPin, hasSupabase } from '../../lib/api'
import { useAuthStore } from '../../stores/posStore'
import { formatSupportError } from '../../utils/errors'
import { sanitizePinInput } from '../../utils/pin'
import { isManagerRole } from '../../utils/roles'

/**
 * Modal for sensitive actions.
 * - Supervisors: staff code + PIN (branch-scoped).
 * - Managers/admin/master already signed in: can approve in place (supervisor unavailable).
 * - Managers with a PIN can also approve via code+PIN for any branch (RPC).
 */
function SupervisorApprove({
  branchId,
  title = 'Approval required',
  detail = 'Enter a supervisor PIN, or approve as manager if the supervisor is unavailable.',
  onCancel,
  onApproved,
}) {
  const user = useAuthStore((s) => s.user)
  const managerCanApprove = isManagerRole(user?.role)
  const [loginCode, setLoginCode] = useState('')
  const [pin, setPin] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const approveAsManager = async () => {
    setError('')
    setBusy(true)
    try {
      if (!user?.id) throw new Error('Not signed in')
      onApproved({
        staffId: user.id,
        name: user.name || 'Manager',
        role: user.role || 'manager',
        via: 'manager_session',
      })
    } catch (err) {
      setError(formatSupportError(err, 'AUTH06'))
      setBusy(false)
    }
  }

  return (
    <Modal onClose={onCancel}>
      <Eyebrow>APPROVAL REQUIRED</Eyebrow>
      <h2 className="mb-2 text-[20px]">{title}</h2>
      <p className="mb-4 text-[13px] text-brand-muted">{detail}</p>

      {managerCanApprove && (
        <div className="mb-4 rounded-md border border-brand-line bg-brand-n100 px-3 py-3">
          <p className="m-0 text-[12px] text-brand-muted">
            You’re signed in as <strong className="text-brand-ink">{user?.name || 'manager'}</strong>. You can approve
            for this branch if no supervisor is available.
          </p>
          <PrimaryButton
            compact
            type="button"
            className="mt-3"
            disabled={busy}
            onClick={() => void approveAsManager()}
          >
            {busy ? 'Approving…' : 'Approve as manager'}
          </PrimaryButton>
        </div>
      )}

      <form
        onSubmit={async (event) => {
          event.preventDefault()
          setError('')
          setBusy(true)
          try {
            if (!hasSupabase) {
              onApproved({ staffId: 'demo-supervisor', name: 'Demo Supervisor' })
              return
            }
            const result = await verifySupervisorPin(branchId, loginCode, pin)
            const row = Array.isArray(result) ? result[0] : result
            const staffId = typeof row === 'string' ? row : row?.staff_id || row?.id
            if (!staffId) {
              throw new Error('Invalid supervisor code or PIN')
            }
            onApproved({
              staffId,
              name: (typeof row === 'object' && (row?.full_name || row?.name)) || 'Supervisor',
              // The verify RPC does not always return the role; when it doesn't, the
              // approver's role is resolved from `staff` on the next read of the record.
              role: (typeof row === 'object' && row?.role) || null,
              via: 'pin',
            })
          } catch (err) {
            setError(formatSupportError(err, 'AUTH06'))
          } finally {
            setBusy(false)
          }
        }}
      >
        {managerCanApprove && (
          <p className="mb-2 text-[11px] font-bold tracking-wide text-brand-subtle uppercase">
            Or use supervisor / manager PIN
          </p>
        )}
        <Field
          label="Staff code"
          value={loginCode}
          onChange={(e) => setLoginCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
          inputMode="numeric"
          autoFocus={!managerCanApprove}
          required
        />
        <Field
          label="PIN"
          className="mt-3"
          value={pin}
          onChange={(e) => setPin(sanitizePinInput(e.target.value))}
          type="password"
          autoComplete="current-password"
          required
        />
        {error && <ErrorBanner className="mt-3 mb-0" error={error} />}
        <ModalActions>
          <SecondaryButton compact type="button" onClick={onCancel} disabled={busy}>
            Cancel
          </SecondaryButton>
          <PrimaryButton compact type="submit" disabled={busy}>
            {busy ? 'Checking…' : 'Approve with PIN'}
          </PrimaryButton>
        </ModalActions>
      </form>
    </Modal>
  )
}

export default SupervisorApprove
