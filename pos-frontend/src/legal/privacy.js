import {
  LEGAL_CONTACT_EMAIL,
  LEGAL_EFFECTIVE_DATE,
  LEGAL_JURISDICTION,
  LEGAL_PRODUCT_NAME,
  LEGAL_PROVIDER_NAME,
  LEGAL_TRADE_NAME,
} from './meta'

const P = LEGAL_PRODUCT_NAME

export const PRIVACY_DOCUMENT = {
  id: 'privacy',
  title: 'Privacy Policy',
  eyebrow: 'Legal',
  effectiveDate: LEGAL_EFFECTIVE_DATE,
  summary: `This Policy explains how ${P} processes personal data under the Data Privacy Act of 2012 (Republic Act No. 10173) and its implementing rules.`,
  sections: [
    {
      title: '1. Introduction',
      body: [
        `${P} is a staff-facing point of sale. It is not a public shopping website and does not create customer accounts. Personal data is processed so authorized stores can sell, discount, receipt, reconcile cash, and keep the records Philippine tax rules require.`,
        `This Policy applies to the hosted ${P} deployment operated by ${LEGAL_PROVIDER_NAME} (${LEGAL_TRADE_NAME}) (“we”, “us”). It covers staff users of the software and, where we process it on a Merchant’s behalf, data about shoppers collected at the till.`,
      ],
    },
    {
      title: '2. Who we are and how to contact us',
      body: [
        `Personal Information Controller for the ${P} software platform (staff accounts, access logs, and the hosting of the application): ${LEGAL_PROVIDER_NAME}, operating as ${LEGAL_TRADE_NAME}.`,
        `Email: ${LEGAL_CONTACT_EMAIL}. This address is also the point of contact for privacy requests until a separate Data Protection Officer address is published.`,
        'Personal Information Controller for store operations — including what is sold, cash in the drawer, and SC/PWD identifiers taken at the counter — is the Merchant whose business name and TIN appear on the official receipt. We act as a Personal Information Processor for that operational data, on the Merchant’s instructions, via the software.',
      ],
    },
    {
      title: '3. Whose data we process',
      list: [
        'Staff and managers: people given a CalePOS login (code/PIN or email/password).',
        'Customers of the Merchant: typically limited to what a sale requires (items, tender, and, when a statutory discount is claimed, an ID note). We do not run a customer loyalty CRM.',
        'Device/till context: which terminal is online, scanner/printer/drawer status, and local offline copies of branch data.',
      ],
    },
    {
      title: '4. Personal data we process',
      body: ['Staff and account data may include:'],
      list: [
        'Name, role, branch assignment, module permissions, staff login code.',
        'Email address and password (passwords are handled by the authentication provider; we do not store manager passwords in the POS database).',
        'Staff PIN, stored so an authorized manager can recover it for operations. Offline unlock uses a separate PBKDF2 verifier and does not keep the password in recoverable form on the till.',
        'Shift, cash-count, petty-cash, day-end, and approval actions tied to a staff identity.',
        'Audit events (what was done, when, which app version, which branch).',
        'Session facts needed to prevent concurrent sign-in abuse and to lock an idle till.',
      ],
      bodyAfter: ['Transaction and customer-related data may include:'],
      listAfter: [
        'Official receipt number, date/time, branch, till, cashier, line items, quantities, prices, VAT breakdown, promo attribution, tender type, amount tendered, change.',
        'Optional payment reference entered by staff (not a full card number).',
        'SC/PWD or other discount type, discount amount, and the ID number or note entered for the discount (`discount_id_note`).',
        'Void, refund, and remote refund-approval records, including reasons and approver identity.',
      ],
    },
    {
      title: '5. Sensitive personal information',
      body: [
        'A Senior Citizen or PWD discount indicates a protected status and records an ID number. Under the Data Privacy Act this is sensitive personal information. We process it only to apply the statutory discount, print/store the receipt, and produce the SC/PWD register and related BIR-oriented reports.',
        'Staff must not copy ID numbers into unrelated notes, chat, or personal devices. Merchants should collect the minimum needed for the discount and keep physical ID viewing to the counter.',
      ],
    },
    {
      title: '6. How we collect data',
      list: [
        'Directly from staff at sign-in, PIN entry, shift count, catalog edits, and approvals.',
        'At the till when a cashier completes a sale, void, refund, or cash movement.',
        'Automatically from the till: connectivity, sync queue status, heartbeat/device presence, app version, and (on sign-in, when configured) a Cloudflare Turnstile token used to reduce automated login abuse.',
        'From managers: staff roster, branch profile, company TIN and address, promo rules, catalog.',
      ],
    },
    {
      title: '7. Purposes and lawful bases',
      body: ['We process personal data to:'],
      list: [
        'Operate the POS (sales, inventory, shifts, day-end, promos, devices) — contract / legitimate interest in running authorized stores.',
        'Authenticate users, lock idle tills, audit privileged actions, and detect abuse — legitimate interest and, where applicable, legal obligation.',
        'Apply VAT, sequential OR numbering, SC/PWD discounts, and produce fiscal and management reports — legal obligation of the Merchant; our processing as processor.',
        'Sync offline tills with the hosted database so records are not lost — contract / legitimate interest.',
        'Improve reliability of an authorized deployment (error codes, version checks) — legitimate interest. We do not sell personal data.',
      ],
    },
    {
      title: '8. Where data lives',
      body: [
        'Online records are stored in a hosted PostgreSQL database with row-level security (Supabase). Auth tokens for a browser session are kept in sessionStorage, not localStorage, so closing the browser requires sign-in again.',
        'Each till also keeps a local IndexedDB copy (catalog, recent activity, open shift, sync outbox, offline supervisor PIN verifiers, unlock backoff). That copy exists so the store can trade during an outage. Anyone with physical access to an unlocked till, or who exports the browser profile, may be able to read local data. Physical till security is the Merchant’s duty.',
        'A last-known idle-lock preference may be cached in localStorage so a till that is offline still auto-locks.',
      ],
    },
    {
      title: '9. Sharing and processors',
      body: ['We share personal data only as needed to run the Service or as required by law:'],
      list: [
        'Supabase — database, authentication, and private realtime updates for branch topics.',
        'Cloudflare — hosting/CDN of the web app, and Turnstile bot protection on sign-in when enabled.',
        'Google Fonts — the login and app UI load typefaces from Google’s font service, which may receive the till’s IP address.',
        'The Merchant’s own managers and supervisors, according to role and branch access.',
        'Government authorities (including BIR or the National Privacy Commission) when legally required, or to establish, exercise, or defend legal claims.',
      ],
      bodyAfter: [
        'We do not sell personal data. We do not allow processors to use POS data for their own advertising.',
      ],
    },
    {
      title: '10. Retention',
      list: [
        'Staff accounts: for as long as the person is authorized, then as needed for audit and security.',
        'Sales, OR numbers, VAT breakdowns, SC/PWD registers, voids, and related fiscal records: for at least the period Philippine tax rules require for books of accounts and supporting papers (commonly ten years from the relevant filing deadline), and longer if a dispute or investigation is open.',
        'Audit and security events: for operational security and incident review; older events may be retained where they support fiscal or access investigations.',
        'Offline till copies: until overwritten by sync or until the browser profile is cleared. Clearing a till that has not synced can destroy records — do not do that to “delete” data.',
      ],
    },
    {
      title: '11. Security',
      body: [
        'We use access roles, database row-level security, hashed offline unlock verifiers (PBKDF2), idle auto-lock, PIN attempt backoff, captcha on hosted sign-in, private realtime channels, and audit logging. No method is perfect. You must still control who stands at the till, who can reveal PINs, and who can export reports.',
        'Report a suspected incident to the contact email in this Policy as soon as you can, and do not keep using a compromised login.',
      ],
    },
    {
      title: '12. Your rights',
      body: [
        `Under the Data Privacy Act, data subjects may request access, correction, erasure or blocking, objection to processing, and data portability, and may withdraw consent where processing is based on consent, subject to limitations in the Act and other laws of ${LEGAL_JURISDICTION}.`,
        'Erasure does not apply where we or the Merchant must keep the data for a legal obligation — in particular immutable sales and official receipts. We will not delete a completed OR because a shopper or cashier later asks us to “remove the sale.”',
        'Staff should send account requests to their manager and, if needed, to the contact email below. Customers of a store should contact that store (the Merchant) first; we will refer or assist the Merchant as processor.',
      ],
    },
    {
      title: '13. Cookies and similar technologies',
      body: [
        `${P} is a staff application. It uses strictly necessary storage, not advertising cookies:`,
      ],
      list: [
        'sessionStorage — authentication session for the current browser; cleared when the browser is closed.',
        'localStorage — limited operational flags (for example last idle-lock minutes for offline tills, session-lifecycle flags, and this staff member’s sidebar menu order on this till). Not used to persist the auth token.',
        'IndexedDB — the offline POS database described above.',
        'Cloudflare Turnstile — a challenge widget on sign-in when captcha is configured; Cloudflare processes that challenge under its own terms.',
        'A service worker / PWA cache so the till can load after a deploy and during poor network. This caches application files, not a separate advertising profile.',
      ],
    },
    {
      title: '14. International processing',
      body: [
        'The Merchant and most tills are in the Philippines. Hosting, database, authentication, and CDN providers may process data in other countries. We use them as operators of the Service. If you cannot accept that transfer, do not use the hosted software.',
      ],
    },
    {
      title: '15. Children',
      body: [
        `${P} is not directed at children and has no child accounts. A sale may still involve a minor (for example a PWD discount for a child). That data is processed only as part of the Merchant’s sale and statutory discount, not to profile children.`,
      ],
    },
    {
      title: '16. Automated decisions',
      body: [
        'Pricing, VAT, promo “highest discount wins,” SC/PWD math, idle lock, and PIN lockout are automated operational rules. They are not credit scoring or hiring decisions. A supervisor or manager can reverse a till mistake through the void/refund/approval flows the software provides.',
      ],
    },
    {
      title: '17. Changes to this Policy',
      body: [
        'We will post updates on this page and change the effective date. Material changes will also be reachable from Settings → About. Continued use after an update means the new Policy applies to subsequent processing.',
      ],
    },
    {
      title: '18. Complaints',
      body: [
        'You may complain to us at the email below. You may also lodge a complaint with the National Privacy Commission of the Philippines (privacy.gov.ph).',
      ],
    },
    {
      title: '19. Contact',
      body: [
        `${LEGAL_PROVIDER_NAME} (${LEGAL_TRADE_NAME}) — ${P} privacy and legal: ${LEGAL_CONTACT_EMAIL}.`,
      ],
    },
  ],
}
