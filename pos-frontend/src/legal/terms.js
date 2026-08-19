import {
  LEGAL_CONTACT_EMAIL,
  LEGAL_EFFECTIVE_DATE,
  LEGAL_JURISDICTION,
  LEGAL_PRODUCT_NAME,
  LEGAL_PROVIDER_NAME,
  LEGAL_TRADE_NAME,
} from './meta'

const P = LEGAL_PRODUCT_NAME

export const TERMS_DOCUMENT = {
  id: 'terms',
  title: 'Terms and Conditions',
  eyebrow: 'Legal',
  effectiveDate: LEGAL_EFFECTIVE_DATE,
  summary: `These Terms govern authorized use of ${P}, an offline-first point of sale for retail and meat counters in the Philippines.`,
  sections: [
    {
      title: '1. Agreement',
      body: [
        `By signing in to ${P}, installing it on a till, or otherwise using the software, you agree to these Terms and Conditions (the “Terms”) on behalf of yourself and, if you are a manager or owner, the business that operates the store.`,
        'If you do not agree, do not use the software. Staff who are given a login code or PIN by their employer use the system under these same Terms.',
      ],
    },
    {
      title: '2. Who we are',
      body: [
        `${P} is proprietary software owned by ${LEGAL_PROVIDER_NAME}, operating as ${LEGAL_TRADE_NAME} (“we”, “us”, “the Provider”).`,
        `These Terms are a contract between the Provider and the authorized business (the “Merchant”) and its staff (“you”). They are not a consumer shopping agreement. Shoppers at the counter buy from the Merchant, not from ${P}.`,
      ],
    },
    {
      title: '3. Nature of the service',
      body: [
        `${P} is a multi-branch point of sale with offline tills, shift and cash-drawer controls, BIR-oriented VAT and SC/PWD handling, sequential official receipt numbering, and a sync queue to a hosted database.`,
        'Until the software reaches version 1.0.0, it is in testing and is not offered for live trading. While it is marked “In development / Not for live sales,” you must not rely on it as the sole system of record for real money, BIR filing, or customer-facing fiscal receipts without your own independent controls.',
        'Access is by invitation only. Holding a URL, a staff code, or a copy of the app does not grant a license. Authorized use is limited to persons and organizations that have our express written permission.',
      ],
    },
    {
      title: '4. Accounts, roles, and credentials',
      body: [
        'Staff sign in with a staff code and PIN, or (for managers) an email and password. Roles (cashier, supervisor, manager, master) and module permissions control what the interface shows. Database row-level security still applies independently of the screens.',
      ],
      list: [
        'You must keep login codes, PINs, and passwords confidential. Do not share a till login.',
        'Managers may recover a staff PIN for operations. Treat recovered PINs as secrets and rotate them after disclosure.',
        'Idle lock, screen lock, and “browser closed requires sign-in again” are security controls, not optional decorations. Do not disable or circumvent them.',
        'You are responsible for activity that occurs under your credentials, including offline sales queued on a till you left signed in.',
      ],
    },
    {
      title: '5. Merchant responsibilities',
      body: [
        'The Merchant, not the Provider, is the seller of goods, the taxpayer, and the operator of each branch. You are responsible for:',
      ],
      list: [
        'BIR registration, TIN, official receipts, VAT, SC/PWD discounts, books of accounts, and any other tax or consumer-law duties that apply to your stores.',
        'Training staff, counting cash, dual-control day-end, voids, refunds, and petty-cash approvals according to your own internal controls.',
        'The accuracy of catalog prices, stock, promos, and the business name / TIN printed on receipts.',
        'Giving customers any privacy notice or SC/PWD consent your business is required to give at the point of sale.',
        'Devices, printers, cash drawers, scanners, network, and physical security of tills (including IndexedDB data that remains on a device while offline).',
        'Not clearing browser storage on a till that still has unsynced sales.',
      ],
    },
    {
      title: '6. Sales, receipts, and statutory discounts',
      body: [
        'Completed sales are intended to be immutable operational records. Voids, refunds, and supervisor-gated corrections are logged; they do not silently rewrite history.',
        'SC/PWD discounts require an ID number to be recorded on the transaction (OSCA / PWD ID or equivalent note). That identifier is stored with the sale, printed on the receipt when present, and included in SC/PWD registers. Collect only what the discount requires, and show the ID to staff only as needed to complete the sale.',
        'Payment method and any payment reference you enter (for example a card or e-wallet reference) are stored with the transaction. Do not type full card numbers, CVVs, or other payment-card data into free-text fields. This POS is not a card-acquiring system.',
      ],
    },
    {
      title: '7. Offline operation and sync',
      body: [
        'Tills are designed to keep selling without a network. Sales, shifts, and related actions are written first to the device (IndexedDB) and an outbox, then uploaded in order when the server is reachable.',
        'A till that has pending or blocked queue items still holds the only copy of that work. Clearing site data, swapping browsers, or re-imaging the device can destroy unsynced sales and break official receipt sequence. You must treat the till as a fiscal device until sync succeeds.',
      ],
    },
    {
      title: '8. Acceptable use',
      body: ['You may not:'],
      list: [
        'Use the software without written authorization, or after access has been revoked.',
        'Attempt to bypass role gates, row-level security, captcha, PIN lockout, or audit logging.',
        'Reverse engineer, copy, resell, sublicense, or host the software for third parties.',
        'Probe, scrape, or attack the hosted database, auth, or realtime channels.',
        'Falsify sales invoices, invoice numbers, VAT figures, or SC/PWD claims.',
        'Use the system to process transactions you know to be fraudulent or unlawful.',
      ],
    },
    {
      title: '9. Intellectual property',
      body: [
        `${P}, including source code, designs, schemas, documentation, and the ${P} name, is the exclusive property of ${LEGAL_PROVIDER_NAME}. These Terms grant a limited, revocable, non-exclusive right to use the deployed system for the Merchant’s authorized stores. They do not transfer ownership.`,
        'You may not remove copyright or proprietary notices. Feedback you give us may be used to improve the software without obligation to you.',
      ],
    },
    {
      title: '10. Third-party infrastructure',
      body: [
        `${P} is hosted and operated using third-party processors, including a cloud database and authentication provider (Supabase) and edge hosting, CDN, and bot-protection (Cloudflare, including Turnstile on sign-in). Their availability and policies affect the Service. We do not control public internet, till hardware, or your shop network.`,
      ],
    },
    {
      title: '11. Changes, availability, and support',
      body: [
        'We may update the software, require a reload when a new build is deployed, and change features as the product matures toward 1.0. We do not guarantee uninterrupted access, including during network outages. That is why offline mode exists, and why unsynced tills must be protected.',
        'Support is provided at our discretion for authorized deployments. Quote the on-screen support code (for example AUTH01, SYNC09) when you contact us.',
      ],
    },
    {
      title: '12. Disclaimer of warranties',
      body: [
        `THE SOFTWARE IS PROVIDED “AS IS” AND “AS AVAILABLE,” WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, AND NON-INFRINGEMENT. In particular, while ${P} implements BIR-oriented VAT, SC/PWD, and sequential invoice numbering, we do not warrant that a given deployment is BIR-accredited, that reports are complete for filing, or that the system is ready for live sales before version 1.0.0.`,
      ],
    },
    {
      title: '13. Limitation of liability',
      body: [
        `To the maximum extent permitted by law of ${LEGAL_JURISDICTION}, the Provider is not liable for lost profits, lost cash, inventory shrinkage, tax assessments, penalties, lost data (including unsynced till data you cleared), business interruption, or indirect, incidental, or consequential damages arising from use of the software.`,
        'Our total liability for any claim relating to the software is limited to the amount you paid us for the software in the three months before the claim, or one thousand Philippine pesos (₱1,000), whichever is greater. Some mandatory consumer protections cannot be waived; those remain.',
      ],
    },
    {
      title: '14. Indemnity',
      body: [
        'The Merchant will defend and indemnify the Provider against claims arising from the Merchant’s sales, tax filings, SC/PWD handling, staff conduct, cash handling, or misuse of the software, except to the extent caused by our wilful misconduct.',
      ],
    },
    {
      title: '15. Suspension and end of use',
      body: [
        'We may suspend or revoke access if these Terms are breached, if a deployment is unsafe, or if we are required to do so by law. You may stop using the software at any time. Fiscal records already written remain subject to tax-retention rules; stopping use does not entitle anyone to delete those records where the law requires they be kept.',
      ],
    },
    {
      title: '16. Privacy',
      body: [
        `How we process personal data is described in the ${P} Privacy Policy, which forms part of these Terms. If there is a conflict about personal data, the Privacy Policy controls on that point.`,
      ],
    },
    {
      title: '17. Changes to these Terms',
      body: [
        'We may update these Terms. The effective date at the top of the page will change. Continued use after an update constitutes acceptance. Material changes will be posted in the app (this page and Settings → About).',
      ],
    },
    {
      title: '18. Governing law',
      body: [
        `These Terms are governed by the laws of ${LEGAL_JURISDICTION}. Courts located in ${LEGAL_JURISDICTION} have exclusive jurisdiction, except where a mandatory venue rule says otherwise.`,
      ],
    },
    {
      title: '19. Contact',
      body: [
        `Licensing, authorization, and these Terms: ${LEGAL_PROVIDER_NAME} (${LEGAL_TRADE_NAME}). Email: ${LEGAL_CONTACT_EMAIL}.`,
      ],
    },
  ],
}
