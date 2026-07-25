import type { PricingTier } from './types';

// All tiers are "starting at" prices. Every engagement is custom-quoted
// after a free review of the prospect's actual books and volume.

export const TIERS: PricingTier[] = [
  {
    name: 'Essentials',
    tagline: 'Clean books, on time, every month',
    priceFrom: 395,
    bestFor:
      'Owner-operated businesses that need accurate, tax-ready books without the DIY Sundays. Up to about 150 transactions a month across 2 accounts.',
    features: [
      'Up to ~150 transactions/mo categorized weekly',
      '2 bank or credit card accounts reconciled to the penny',
      'Monthly close delivered by the 15th business day',
      'P&L, balance sheet, and cash summary with a plain-English note',
      'Year-end CPA package and coordination with your tax preparer',
      'Secure client portal, e-signatures, and email support',
    ],
    notIncluded: [
      'AP/AR workflows (bill pay and invoicing)',
      'Payroll support',
      'Cash flow forecasting and advisory calls',
    ],
  },
  {
    name: 'Growth',
    tagline: 'Books plus the busywork off your desk',
    priceFrom: 795,
    popular: true,
    bestFor:
      'Businesses with employees, vendors, and momentum, where the owner is still the accounting department. Up to about 400 transactions a month across 5 accounts.',
    features: [
      'Up to ~400 transactions/mo categorized weekly',
      '5 accounts reconciled to the penny',
      'Monthly close delivered by the 10th business day',
      'AP support: bills coded, queued, and paid on your approval',
      'AR support: invoices sent on schedule, weekly aging report',
      'Payroll support: platform kept reconciled, deadlines monitored',
      'Quarterly review call to walk the numbers and the trends',
      'Everything in Essentials, including the year-end CPA package',
    ],
    notIncluded: [
      '13-week cash flow forecasting',
      'Budget vs. actual reporting and monthly advisory',
    ],
  },
  {
    name: 'Controller+',
    tagline: 'A finance department, minus the payroll line',
    priceFrom: 1495,
    bestFor:
      'Higher-volume businesses that need weekly attention, forward-looking cash visibility, and a standing seat at the table for financial decisions.',
    features: [
      'High transaction volume and multi-account or multi-entity support',
      'Weekly bookkeeping, not a month-end catch-up',
      'Monthly close delivered by the 8th business day',
      'Rolling 13-week cash flow forecast, kept current',
      'Annual budget built with you, plus monthly budget vs. actual reporting',
      'Monthly advisory call: margins, pricing, and decisions on the table',
      'Direct line for time-sensitive financial questions',
      'Add-on path to fractional CFO days for financing, pricing, or expansion work',
    ],
  },
];

export const ADDONS: { name: string; price: string; text: string }[] = [
  {
    name: 'QuickBooks cleanup / catch-up',
    price: 'From $750 one-time',
    text: 'Behind or in a mess? We diagnose the file, quote a flat fee, and rebuild your books month by month until they reconcile and mean something. Most cleanups finish in 2 to 4 weeks.',
  },
  {
    name: 'Payroll setup',
    price: 'From $350',
    text: 'Your payroll platform configured correctly the first time: pay schedules, earnings and deductions, tax registrations tracked, and every payroll mapped cleanly into your books.',
  },
  {
    name: 'Fractional CFO day',
    price: 'From $1,200/day',
    text: 'A focused day of senior financial firepower for a specific decision: pricing overhaul, lender package, acquisition model, or expansion math. Scoped in advance, delivered in writing.',
  },
  {
    name: 'New business setup package',
    price: 'From $500',
    text: 'Bank structure, QuickBooks, sales and franchise tax registration guidance, and the habits that keep year one clean, so you never pay for a year-two cleanup.',
  },
];
