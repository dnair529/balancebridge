// Central business config. PLACEHOLDER values are tracked in docs/content/SWAP-LIST.md
export const BUSINESS = {
  name: 'Balance Bridge Financial',
  shortName: 'Balance Bridge',
  legalName: 'Balance Bridge Financial LLC', // PLACEHOLDER — confirm legal entity name
  domain: 'balancebridge.us',
  url: 'https://balancebridge.us',
  portalUrl: 'https://portal.balancebridge.us',
  phone: '(512) 555-0146', // PLACEHOLDER
  phoneHref: 'tel:+15125550146', // PLACEHOLDER
  email: 'hello@balancebridge.us', // PLACEHOLDER — create mailbox
  serviceArea: 'Texas (remote-first, statewide)',
  cities: ['Dallas–Fort Worth', 'Houston', 'Austin', 'San Antonio', 'El Paso'],
  hours: 'Mon–Fri, 8:30am–5:30pm CT',
  replyPromise: 'We reply within 1 business day',
  calendarUrl: 'https://cal.com/balancebridge/intro', // PLACEHOLDER — create Cal.com account
  founded: '2019', // PLACEHOLDER
  social: {
    linkedin: 'https://www.linkedin.com/company/balance-bridge-financial', // PLACEHOLDER
  },
  certifications: [
    // PLACEHOLDER — verify before production launch
    'QuickBooks Online ProAdvisor',
    'Xero Partner',
    'AIPB Certified Bookkeeper',
  ],
} as const;

export const CTA = {
  primary: 'Book a free consultation',
  primaryHref: '/contact/',
  quote: 'Get a custom quote',
  quoteHref: '/pricing/#quote',
  leadMagnet: 'Get the free Texas Financial Health Checklist',
  leadMagnetHref: '/free-review/',
} as const;
