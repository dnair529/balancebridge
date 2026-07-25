// ILLUSTRATIVE COMPOSITES — replace with real client quotes before production launch. See docs/content/SWAP-LIST.md
import type { Testimonial, CaseStudy } from './types';

export const TESTIMONIALS: Testimonial[] = [
  {
    quote:
      'Our books used to close 45 days late, when they closed at all. Now the package is in my inbox on the 8th of every month, and for the first time I trust the numbers enough to make decisions with them.',
    name: 'Marcus T.',
    role: 'Owner',
    company: 'Commercial electrical contractor, Fort Worth',
    industry: 'Construction & Trades',
  },
  {
    quote:
      'They found $1,900 a month in duplicate software subscriptions and processor fees during the cleanup. The service paid for itself before the first monthly close.',
    name: 'Dana R.',
    role: 'Founder',
    company: 'Marketing agency, Austin',
    industry: 'Professional Services',
  },
  {
    quote:
      'My CPA called after year-end to ask what changed, because the file she got in January needed zero cleanup for the first time in six years. My prep bill came in about a third lower.',
    name: 'Priya S.',
    role: 'Practice Owner',
    company: 'Dental practice, San Antonio',
    industry: 'Medical & Dental',
  },
  {
    quote:
      'Three locations, and I could never tell you which one made money in a given month. Now I get a per-store P&L and a weekly prime cost number. We fixed a labor problem at one store within three weeks of seeing it.',
    name: 'Luis G.',
    role: 'Managing Partner',
    company: 'Restaurant group, Houston',
    industry: 'Restaurants & Hospitality',
  },
  {
    quote:
      'Amazon and Shopify deposits used to just get booked as "sales." Balance Bridge broke everything out gross-to-net, and it turned out one channel was earning a fifth of the margin of the other. We moved the ad budget the same month.',
    name: 'Whitney K.',
    role: 'Co-founder',
    company: 'Ecommerce home goods brand, Dallas',
    industry: 'Ecommerce & Retail',
  },
  {
    quote:
      'Eight properties, eight LLCs, and intercompany transfers nobody had documented in years. They untangled it, and now I see cash-on-cash by property every month without building a spreadsheet myself.',
    name: 'Robert M.',
    role: 'Principal',
    company: 'Residential rental portfolio, El Paso',
    industry: 'Real Estate',
  },
];

export const CASE_STUDIES: CaseStudy[] = [
  {
    title: 'From gut-feel bids to 4-point margin gains for a Fort Worth contractor',
    industry: 'Construction & Trades',
    challenge:
      'A 22-person commercial subcontractor was winning plenty of work but could not say which jobs made money. Materials landed on three credit cards, labor burden was ignored in bids, and retainage lived in a spreadsheet last updated two quarters back. Books closed 45 days late on a good month, and two big jobs were quietly bleeding.',
    actions: [
      'Cleaned up 14 months of books and rebuilt the chart of accounts around jobs, not just expense types',
      'Set up job costing in QuickBooks Online with a receipt workflow crew leads run from their phones',
      'Applied a fully loaded labor burden rate so job costs included payroll taxes, insurance, and equipment',
      'Built a retainage schedule tracking every held balance by contract and release condition',
      'Moved the company to a monthly close delivered by the 10th business day, with estimated-versus-actual reporting per job',
    ],
    results: [
      'Close went from roughly 45 days late to delivered on the 10th business day, every month',
      'Two chronically underpriced job types identified; bid margins on them raised 4 to 6 points, and win rates held',
      '$38,000 in releasable retainage found and collected within 90 days',
      'Owner now reviews per-job margin monthly and has declined three bids that the numbers showed would lose money',
    ],
  },
  {
    title: 'Daily sales reconciliation helped a Houston restaurant group survive its slow season',
    industry: 'Restaurants & Hospitality',
    challenge:
      'A three-location restaurant group ran healthy summer sales but limped through every first quarter, covering January payroll on the owner\'s personal credit line two years running. POS, processor deposits, and the bank never matched, tip reporting was a monthly scramble, and no one saw prime cost until weeks after the month ended.',
    actions: [
      'Implemented daily sales reconciliation tying POS totals to processor deposits and bank activity for each location',
      'Rebuilt tip flows so credit card tips and tip pools moved cleanly from POS to payroll to the books',
      'Digitized vendor invoices and set up per-location food and beverage cost tracking with price-creep flags',
      'Delivered a weekly prime cost report per location and a 13-week cash forecast built around the group\'s real seasonality',
      'Set a reserve target funded automatically during peak months',
    ],
    results: [
      'A processor configuration error surfaced in the first month of daily reconciliation; roughly $7,200 in missed deposits recovered',
      'Prime cost variance between the best and worst location narrowed from 9 points to 3 within two quarters',
      'The next slow season was covered entirely from the planned reserve; no personal borrowing for the first time in three years',
      'Monthly close now lands on the 8th, and the owner reviews one page per store instead of a shoebox',
    ],
  },
  {
    title: 'Cleanup and nexus workpapers got a Dallas ecommerce brand loan-ready in nine weeks',
    industry: 'Ecommerce & Retail',
    challenge:
      'A home goods brand selling on Shopify and Amazon needed inventory financing to land a wholesale deal, but the bank\'s first review stalled immediately: 20 months of marketplace payouts booked as lump-sum "sales," no monthly COGS, and no answer to the lender\'s question about sales tax exposure in other states.',
    actions: [
      'Rebuilt 20 months of revenue gross-to-net from platform settlement reports, separating fees, refunds, and reserves',
      'Established a monthly inventory and COGS process synced with the company\'s inventory tool',
      'Ran a state-by-state economic nexus review and prepared workpapers; coordinated registrations in two states through the client\'s CPA',
      'Produced a lender package with 20 restated months plus three clean current closes, and moved the company onto a monthly plan',
    ],
    results: [
      'Restated books showed true blended gross margin of 41 percent versus the 58 percent the raw books implied, with channel-level detail the lender accepted',
      'Nexus exposure documented and resolved before underwriting, removing the lender\'s stated deal-breaker',
      'A $250,000 inventory line of credit approved roughly nine weeks after the cleanup started',
      'Channel-level margin reporting drove an ad-spend shift that improved blended margin about 3 points over the following two quarters',
    ],
  },
];
