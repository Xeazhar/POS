import { useState } from 'react'
import { Eyebrow, Field, Modal, ModalActions, PrimaryButton, SecondaryButton, ErrorBanner } from '../ui'
import { verifySupervisorPin, hasSupabase } from '../../lib/api'
import { formatSupportError } from '../../utils/errors'
import { sanitizePinInput } from '../../utils/pin'

/**
 * Modal asking for supervisor/manager staff code + PIN before a sensitive action.
 * On success calls onApproved({ staffId, name }) and closes.
 */
function SupervisorApprove({
  branchId,
  title = 'Supervisor approval',
  detail = 'Enter a supervisor or manager PIN to continue.',
  onCancel,
  onApproved,
}) {
  const [loginCode, setLoginCode] = useState('')
  const [pin, setPin] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  return (
    <Modal onClose={onCancel}>
      <Eyebrow>APPROVAL REQUIRED</Eyebrow>
      <h2 className="mb-2 text-[20px]">{title}</h2>
      <p className="mb-4 text-[13px] text-brand-muted">{detail}</p>
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
            const staffId = typeof result === 'string' ? result : result?.staff_id || result?.id
            if (!staffId) {
              throw new Error('Invalid supervisor code or PIN')
            }
            onApproved({
              staffId,
              name: result?.full_name || result?.name || 'Supervisor',
            })
          } catch (err) {
            setError(formatSupportError(err, 'AUTH06'))
          } finally {
            setBusy(false)
          }
        }}
      >
        <Field
          label="Supervisor code"
          value={loginCode}
          onChange={(e) => setLoginCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
          inputMode="numeric"
          autoFocus
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
            {busy ? 'Checking…' : 'Approve'}
          </PrimaryButton>
        </ModalActions>
      </form>
    </Modal>
  )
}

export default SupervisorApprove
