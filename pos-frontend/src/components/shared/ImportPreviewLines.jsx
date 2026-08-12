import { money, qty } from '../../utils/format'

function formatChangeValue(change, which) {
  const raw = which === 'from' ? change.from : change.to
  if (change.format === 'money') return money(raw ?? 0)
  if (change.format === 'qty') return qty(raw ?? 0)
  if (change.format === 'bool') return raw ? 'yes' : 'no'
  return raw === '' || raw == null ? '—' : String(raw)
}

function ImportChangeList({ changes = [] }) {
  if (!changes.length) {
    return <p className="m-0 mt-0.5 text-[11px] text-brand-subtle">No field changes detected.</p>
  }
  return (
    <ul className="m-0 mt-1 list-none space-y-0.5 pl-0 text-[11px] text-brand-muted">
      {changes.map((change) => (
        <li key={change.field} className="leading-snug">
          <span className="text-brand-subtle">{change.label}: </span>
          <span className="text-brand-danger line-through">{formatChangeValue(change, 'from')}</span>
          <span className="text-brand-subtle"> → </span>
          <span className="font-semibold text-brand-ink">{formatChangeValue(change, 'to')}</span>
          {change.note ? <span className="text-brand-subtle"> ({change.note})</span> : null}
        </li>
      ))}
    </ul>
  )
}

/**
 * Bulk-import preview rows — creates vs updates with field-level diffs before commit.
 */
export function ImportPreviewLines({ lines = [], creates = [], updates = [], maxRows = 50 }) {
  const createLines = creates.length ? creates : (lines || []).filter((l) => l.action === 'create')
  const updateLines = updates.length
    ? updates
    : (lines || []).filter((l) => l.action === 'update' || l.action === 'restock')

  return (
    <div className="space-y-4">
      {updateLines.length > 0 && (
        <div>
          <p className="m-0 mb-1 text-[11px] font-bold text-brand-warn">
            Will update ({updateLines.length}) — review changes
          </p>
          <div className="max-h-56 overflow-auto rounded-md border border-brand-warn-line/60 bg-brand-warn-surface/40 px-2.5 py-1">
            {updateLines.slice(0, maxRows).map((line, i) => (
              <div
                key={`upd-${line.index ?? i}`}
                className="border-t border-brand-softline py-2 first:border-t-0"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5">
                  <strong className="text-brand-ink">{line.values?.name || '—'}</strong>
                  <span className="shrink-0 text-[10px] font-bold uppercase tracking-wide text-brand-warn">
                    {line.action === 'restock' ? 'restock' : 'update'}
                  </span>
                </div>
                <span className="text-[11px] text-brand-subtle">{line.values?.sku || '—'}</span>
                <ImportChangeList changes={line.changes} />
              </div>
            ))}
            {updateLines.length > maxRows && (
              <p className="m-0 py-1 text-[11px] text-brand-subtle">
                + {updateLines.length - maxRows} more updates not shown
              </p>
            )}
          </div>
        </div>
      )}

      {createLines.length > 0 && (
        <div>
          <p className="m-0 mb-1 text-[11px] font-bold text-brand-success-text">
            Will create ({createLines.length})
          </p>
          <div className="max-h-40 overflow-auto text-xs">
            {createLines.slice(0, maxRows).map((line, i) => (
              <div
                key={`new-${line.index ?? i}`}
                className="flex justify-between gap-2 border-t border-brand-softline py-1.5 first:border-t-0"
              >
                <span className="truncate">
                  {line.values?.name || '—'}{' '}
                  <span className="text-brand-subtle">({line.values?.sku})</span>
                </span>
                <span className="shrink-0 tabular-nums text-brand-success-text">
                  {line.values?.stock != null && Number(line.values.stock) > 0
                    ? qty(line.values.stock)
                    : money(line.values?.price)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

export default ImportPreviewLines
