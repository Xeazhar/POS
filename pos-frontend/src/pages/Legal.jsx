import { Link, Navigate, useLocation } from 'react-router-dom'
import { TERMS_DOCUMENT } from '../legal/terms'
import { PRIVACY_DOCUMENT } from '../legal/privacy'
import { LEGAL_DOCS, LEGAL_PRODUCT_NAME } from '../legal/meta'
import { useAuthStore } from '../stores/posStore'

function Paragraphs({ items }) {
  if (!items?.length) return null
  return items.map((paragraph, index) => (
    <p key={index} className="m-0 mb-3 text-[13.5px] leading-relaxed text-brand-n700">
      {paragraph}
    </p>
  ))
}

function Bullets({ items }) {
  if (!items?.length) return null
  return (
    <ul className="mb-3 mt-0 list-disc space-y-1.5 pl-5 text-[13.5px] leading-relaxed text-brand-n700">
      {items.map((item, index) => (
        <li key={index}>{item}</li>
      ))}
    </ul>
  )
}

function SectionBlock({ section }) {
  return (
    <section className="mb-8">
      <h2 className="m-0 mb-3 text-[17px] font-bold tracking-[-0.02em] text-brand-ink">{section.title}</h2>
      <Paragraphs items={section.body} />
      <Bullets items={section.list} />
      <Paragraphs items={section.bodyAfter} />
      <Bullets items={section.listAfter} />
    </section>
  )
}

const DOCS = {
  '/legal/terms': TERMS_DOCUMENT,
  '/legal/privacy': PRIVACY_DOCUMENT,
}

function Legal() {
  const { pathname } = useLocation()
  const user = useAuthStore((s) => s.user)
  const doc = DOCS[pathname]

  if (pathname === '/legal' || pathname === '/legal/') {
    return <Navigate to={LEGAL_DOCS.terms.path} replace />
  }
  if (!doc) {
    return <Navigate to={LEGAL_DOCS.terms.path} replace />
  }

  const backTo = user ? '/settings/about' : '/'
  const backLabel = user ? 'Back to Settings' : 'Back to sign-in'
  const year = new Date().getFullYear()

  return (
    <div className="min-h-screen bg-brand-canvas">
      <header className="border-b border-brand-line bg-brand-dark text-white">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-3 px-5 py-4">
          <div className="flex min-w-0 items-center gap-3">
            <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-brand-gold text-[18px] font-bold text-brand-dark">
              C
            </div>
            <div className="min-w-0">
              <p className="m-0 text-[10px] font-bold tracking-[0.16em] text-brand-gold uppercase">
                {LEGAL_PRODUCT_NAME}
              </p>
              <p className="m-0 truncate text-sm font-semibold">{doc.title}</p>
            </div>
          </div>
          <Link
            to={backTo}
            className="shrink-0 text-[11px] text-white/70 no-underline hover:text-white hover:underline"
          >
            {backLabel}
          </Link>
        </div>
      </header>

      <nav
        aria-label="Legal documents"
        className="border-b border-brand-line bg-white"
      >
        <div className="mx-auto flex max-w-3xl gap-1 px-5">
          {Object.values(LEGAL_DOCS).map((item) => {
            const active = pathname === item.path
            return (
              <Link
                key={item.path}
                to={item.path}
                className={`-mb-px inline-flex border-b-2 px-3 py-3 text-[12px] font-bold no-underline ${
                  active
                    ? 'border-brand-gold text-brand-ink'
                    : 'border-transparent text-brand-muted hover:text-brand-ink'
                }`}
              >
                {item.label}
              </Link>
            )
          })}
        </div>
      </nav>

      <main className="mx-auto max-w-3xl px-5 py-8">
        <article className="rounded-[10px] border border-brand-line bg-white px-6 py-8 max-[700px]:px-4">
          <p className="m-0 mb-2 text-[10px] font-semibold tracking-[1.4px] text-brand-eyebrow uppercase">
            {doc.eyebrow}
          </p>
          <h1 className="m-0 text-[28px] font-bold tracking-[-1px] text-brand-ink max-[700px]:text-[22px]">
            {doc.title}
          </h1>
          <p className="m-0 mt-2 text-[12px] text-brand-muted">Effective {doc.effectiveDate}</p>
          <p className="m-0 mt-4 mb-8 text-[13.5px] leading-relaxed text-brand-n700">{doc.summary}</p>
          {doc.sections.map((section) => (
            <SectionBlock key={section.title} section={section} />
          ))}
        </article>
        <p className="m-0 mt-6 pb-10 text-center text-[11px] text-brand-subtle">
          © {year} {LEGAL_PRODUCT_NAME}. All rights reserved.
        </p>
      </main>
    </div>
  )
}

export default Legal
