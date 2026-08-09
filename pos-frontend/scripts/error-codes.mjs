/**
 * Keeps the error catalog, the code, and the support guide in agreement.
 *
 *   node scripts/error-codes.mjs check   — fail if any code used in src/ has no catalog entry
 *   node scripts/error-codes.mjs docs    — regenerate docs/ERROR_CODES.md from the catalog
 *
 * Both matter for the same reason. Staff read a code off the screen and quote it down the
 * phone; if that code has no entry, the number is worse than useless — it looks like
 * precise information and carries none. Before this existed, CAT01–CAT06 and DEV05 were
 * being printed to staff with no catalog entry behind any of them.
 *
 * The doc is generated rather than written so it cannot drift from what the app actually
 * does. Edit src/utils/errors.js; run this; commit both.
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const SRC = join(root, 'src')
const DOC = join(root, 'docs', 'ERROR_CODES.md')

const { ERROR_CATALOG, SALE_IMPACT_GUIDANCE } = await import(
  new URL('../src/utils/errors.js', import.meta.url).href
)

/**
 * Deliberately generic: ANY uppercase-prefix + two-digit token counts as a support code.
 *
 * This used to be an allowlist of known prefixes, which defeated the entire purpose — the
 * check reported "all clear" while IMP01, IMP02, PETTY01, PETTY02, PRICE01 and SHIFT01
 * were being shown to staff with no catalog entry behind any of them. A checker that only
 * looks for codes it already knows about cannot find the ones somebody forgot to add.
 *
 * The cost of being generic is occasional false positives from code-shaped identifiers,
 * which IGNORE below handles by name.
 */
const CODE_PATTERN = /\b[A-Z]{2,6}\d{2}\b/g

/** Code-shaped tokens that are not support codes. Keep this list short and justified. */
const IGNORE = new Set([
  'XX99', // placeholder in a doc comment describing the code format itself
])

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.jsx?$/.test(full)) out.push(full)
  }
  return out
}

function findUsedCodes() {
  const used = new Map()
  for (const file of walk(SRC)) {
    if (file.endsWith(join('utils', 'errors.js'))) continue
    const text = readFileSync(file, 'utf-8')
    text.split('\n').forEach((line, i) => {
      for (const match of line.matchAll(CODE_PATTERN)) {
        const code = match[0]
        if (IGNORE.has(code)) continue
        if (!used.has(code)) used.set(code, [])
        used.get(code).push(`${relative(root, file).replace(/\\/g, '/')}:${i + 1}`)
      }
    })
  }
  return used
}

function check() {
  const used = findUsedCodes()
  const orphans = [...used.entries()].filter(([code]) => !ERROR_CATALOG[code])
  if (orphans.length) {
    console.error('\nError codes used in src/ with no entry in ERROR_CATALOG:\n')
    for (const [code, sites] of orphans) {
      console.error(`  ${code}`)
      sites.forEach((site) => console.error(`      ${site}`))
    }
    console.error('\nAdd them to src/utils/errors.js, or use an existing code.\n')
    process.exit(1)
  }
  const unused = Object.keys(ERROR_CATALOG).filter((code) => !used.has(code))
  console.log(`${Object.keys(ERROR_CATALOG).length} codes defined, ${used.size} referenced in src/.`)
  if (unused.length) console.log(`Defined but not yet used (fine): ${unused.join(', ')}`)
}

const SEVERITY_COPY = {
  blocking: 'Blocking — the task cannot continue',
  degraded: 'Degraded — carried on in a reduced mode, nothing lost',
  config: 'Configuration — retrying will never help, an admin must fix it',
  warning: 'Warning — informational, the user can proceed',
}

function docs() {
  const used = findUsedCodes()
  const groups = {}
  for (const [code, info] of Object.entries(ERROR_CATALOG)) {
    const area = code.replace(/\d+$/, '')
    ;(groups[area] ||= []).push([code, info])
  }

  const lines = []
  lines.push('# CalePOS error codes')
  lines.push('')
  lines.push(
    '**Generated file — do not edit.** Source of truth is `src/utils/errors.js`; regenerate with `npm run docs:errors`.',
  )
  lines.push('')
  lines.push('## How to use this')
  lines.push('')
  lines.push('Staff read a code off the screen (`… · Code SALE01`) and quote it. Look it up here.')
  lines.push('')
  lines.push('Read the columns in this order:')
  lines.push('')
  lines.push('1. **Sale impact** — settle the money question first. Everything else can wait.')
  lines.push('2. **Severity** — decides whether this is a retry, a wait, or an admin job.')
  lines.push('3. **Likely cause / First action** — the actual fix.')
  lines.push('')
  lines.push('### Sale impact values')
  lines.push('')
  lines.push('| Value | What it means at the till |')
  lines.push('| --- | --- |')
  for (const [key, copy] of Object.entries(SALE_IMPACT_GUIDANCE)) {
    if (!copy) continue
    lines.push(`| \`${key}\` | ${copy} |`)
  }
  lines.push('')
  lines.push('### Severity values')
  lines.push('')
  lines.push('| Value | Meaning |')
  lines.push('| --- | --- |')
  for (const [key, copy] of Object.entries(SEVERITY_COPY)) {
    lines.push(`| \`${key}\` | ${copy} |`)
  }
  lines.push('')
  lines.push('### Prefixes')
  lines.push('')
  lines.push(
    '`AUTH` sign-in · `TILL` drawer open/close · `SALE` taking money · `INV` products & stock · ' +
      '`CAT` network catalog · `DEV` printers & devices · `SYNC` offline queue · `DATA` import/export/reports · ' +
      '`PRINT` printing · `SEC` authorisation refusals · `GEN` unclassified',
  )
  lines.push('')
  lines.push('---')
  lines.push('')

  for (const area of Object.keys(groups).sort()) {
    lines.push(`## ${area}`)
    lines.push('')
    for (const [code, info] of groups[area]) {
      lines.push(`### ${code} — ${info.message}`)
      lines.push('')
      lines.push(`- **Severity:** \`${info.severity}\` — ${SEVERITY_COPY[info.severity]}`)
      lines.push(
        `- **Sale impact:** \`${info.saleImpact}\`${
          SALE_IMPACT_GUIDANCE[info.saleImpact] ? ` — ${SALE_IMPACT_GUIDANCE[info.saleImpact]}` : ''
        }`,
      )
      lines.push(`- **Safe to retry:** ${info.retry ? 'yes' : 'no'}`)
      lines.push(`- **Likely cause:** ${info.cause}`)
      lines.push(`- **First action:** ${info.fix}`)
      const sites = used.get(code)
      lines.push(
        `- **Raised from:** ${sites ? sites.slice(0, 4).map((s) => `\`${s}\``).join(', ') : '_not yet used in code_'}`,
      )
      lines.push('')
    }
  }

  writeFileSync(DOC, lines.join('\n'), 'utf-8')
  console.log(`Wrote ${relative(root, DOC).replace(/\\/g, '/')} (${Object.keys(ERROR_CATALOG).length} codes).`)
}

const mode = process.argv[2]
if (mode === 'check') check()
else if (mode === 'docs') docs()
else {
  console.error('Usage: node scripts/error-codes.mjs <check|docs>')
  process.exit(1)
}
