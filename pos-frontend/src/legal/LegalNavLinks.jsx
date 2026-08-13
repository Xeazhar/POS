import { Link } from 'react-router-dom'
import { LEGAL_DOCS } from './meta'

export function LegalNavLinks({ className = '', linkClassName = '' }) {
  return (
    <nav aria-label="Legal" className={className}>
      <Link className={linkClassName} to={LEGAL_DOCS.terms.path}>
        {LEGAL_DOCS.terms.label}
      </Link>
      <span aria-hidden="true"> · </span>
      <Link className={linkClassName} to={LEGAL_DOCS.privacy.path}>
        {LEGAL_DOCS.privacy.label}
      </Link>
    </nav>
  )
}
