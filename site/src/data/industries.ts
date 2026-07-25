import type { IndustryDef } from './types';

export const INDUSTRIES: IndustryDef[] = [
  {
    slug: 'construction-trades',
    name: 'Construction & Trades',
    title: 'Bookkeeping for construction and trade contractors',
    metaTitle: 'Bookkeeping for Construction & Trades TX | Balance Bridge',
    metaDescription:
      'Construction bookkeeping for Texas contractors. Job costing, retainage tracking, and clean books so you finally know which jobs make money.',
    icon: 'building',
    oneLiner: 'Job costing that shows which projects make money, and books that keep up with retainage, draws, and subs.',
    heroSub:
      'Contractors do not go broke from lack of work; they go broke from jobs that quietly lose money. We set up job costing and keep the books current so you can see margins while the job is still open, not after.',
    pains: [
      'You bid from gut feel because you have never seen true cost per job, including labor burden.',
      'Retainage is scattered across contracts and spreadsheets, and some of it may never get collected.',
      'Progress billings, deposits, and draws hit the books as a blur, so revenue never matches reality.',
      'Materials get bought on three cards and two supplier accounts, and coding them to jobs takes all weekend.',
      'Your busiest quarter somehow produces the tightest cash, and nobody can explain why.',
    ],
    howWeHelp: [
      {
        title: 'Job costing that works on a phone',
        text: 'Every labor hour, material buy, and sub invoice coded to its job in QuickBooks, with a receipt workflow your crew leads can handle from the truck.',
      },
      {
        title: 'Retainage tracked to the dollar',
        text: 'Receivable retainage held on your balance sheet where you can see it, aged, and chased when contracts release it. Payable retainage to subs tracked the same way.',
      },
      {
        title: 'Job profitability you see mid-job',
        text: 'Monthly reports showing estimated versus actual by job, so a bleeding project gets a change order conversation instead of a post-mortem.',
      },
      {
        title: 'Cash flow built around draw schedules',
        text: 'A forecast that maps payables and payroll against draw timing, so material buys land after deposits, not before.',
      },
      {
        title: 'Sub compliance without the shoebox',
        text: 'W-9s and insurance certificates collected before subs are paid, so 1099 season and your GL audit are already handled.',
      },
    ],
    serviceSlugs: ['monthly-bookkeeping', 'accounts-payable-receivable', 'cash-flow-budgeting', 'controller-cfo-advisory'],
    faqs: [
      {
        q: 'Can you set up job costing in QuickBooks Online?',
        a: 'Yes. We use projects and class tracking to capture labor, materials, subs, and equipment by job, and apply a labor burden rate so "profitable" jobs stop hiding payroll taxes and insurance. Most contractors see real per-job margins within two closed months.',
      },
      {
        q: 'Do you understand retainage?',
        a: 'Yes, on both sides. We book retainage receivable separately from regular AR so it does not distort collections, age it by contract, and flag balances that are due for release. Same discipline for retainage you hold on subs.',
      },
      {
        q: 'We are on percentage-of-completion for some contracts. Can you handle it?',
        a: 'We maintain the job cost data and work-in-progress schedules that percentage-of-completion accounting is built on, and coordinate the method itself with your CPA, who determines the right treatment for your contracts and taxes.',
      },
    ],
  },
  {
    slug: 'restaurants-hospitality',
    name: 'Restaurants & Hospitality',
    title: 'Bookkeeping for restaurants and hospitality businesses',
    metaTitle: 'Restaurant Bookkeeping Services Texas | Balance Bridge',
    metaDescription:
      'Restaurant bookkeeping for Texas operators. Daily sales reconciliation, tip reporting support, and prime cost visibility on thin margins.',
    icon: 'utensils',
    oneLiner: 'Daily sales tied out, tips and invoices under control, and prime cost visible before the margin disappears.',
    heroSub:
      'Restaurants run on margins where a two-point drift is the difference between a good year and a hard one. We reconcile sales daily, keep vendor invoices and tips clean, and put prime cost in front of you weekly.',
    pains: [
      'POS totals, processor deposits, and the bank never match, and nobody has time to find out why.',
      'Tip reporting is a monthly anxiety: pooled tips, credit card tips, and payroll never quite line up.',
      'Vendor invoices pile up on a clipboard by the walk-in, and price creep on key items goes unnoticed for months.',
      'You know sales were good last week, but you have no idea if you made money.',
      'Sales tax on top of comps, discounts, and delivery platforms feels like guesswork every filing.',
    ],
    howWeHelp: [
      {
        title: 'Daily sales reconciliation',
        text: 'POS sales tied to processor deposits and bank activity daily, with fees, comps, and platform commissions booked where you can see them. Missing deposits get caught in days, not quarters.',
      },
      {
        title: 'Tip reporting that ties out',
        text: 'Credit card tips, cash tips, and tip pools flowing correctly from POS to payroll to the books, so payroll reports and your P&L finally agree and your CPA has clean data for tip credit questions.',
      },
      {
        title: 'Vendor invoices off the clipboard',
        text: 'Invoices captured digitally, coded to food, beverage, and supplies categories, and price-checked, so a 12 percent creep on proteins shows up in a report instead of at year-end.',
      },
      {
        title: 'Prime cost weekly, not eventually',
        text: 'Food, beverage, and labor cost as a percent of sales reported weekly. On thin margins, this is the number that decides the year, and it is useless if it arrives late.',
      },
      {
        title: 'Cash flow for seasonality',
        text: 'A forecast built around your real seasonality, so slow months are funded by design and payroll never depends on a good weekend.',
      },
    ],
    serviceSlugs: ['monthly-bookkeeping', 'bank-reconciliation', 'payroll-support', 'cash-flow-budgeting'],
    faqs: [
      {
        q: 'Which POS systems do you work with?',
        a: 'Toast, Square, Clover, Lightspeed, and most modern systems. We map your POS categories into the books once, then reconcile the daily flow from sales to deposit automatically, with exceptions worked by a human.',
      },
      {
        q: 'Can you handle multiple locations?',
        a: 'Yes. Each location is tracked separately so you can see P&L by store, plus a consolidated view. Most multi-location operators discover their locations perform far less alike than they assumed.',
      },
      {
        q: 'Do you file our sales tax returns?',
        a: 'We keep the sales, comps, and platform data clean and organized so your filings are accurate, and coordinate the actual filing with your CPA or filing service. Texas rates vary by location, so we verify current figures with the Comptroller.',
      },
    ],
  },
  {
    slug: 'medical-dental',
    name: 'Medical & Dental',
    title: 'Bookkeeping for medical and dental practices',
    metaTitle: 'Bookkeeping for Medical & Dental TX | Balance Bridge',
    metaDescription:
      'Practice bookkeeping for Texas physicians and dentists. Insurance deposit timing, provider comp data, and clean books. We handle books, not billing.',
    icon: 'stethoscope',
    oneLiner: 'Clean practice books that handle insurance deposit timing and give you real numbers for provider compensation.',
    heroSub:
      'A practice can produce well and still feel broke, because insurance pays on its own calendar. We keep the books clean around remittance timing and give you the numbers that compensation and growth decisions depend on. We handle the books, not your billing.',
    pains: [
      'Insurance remittances land weeks after the visit, so bank deposits tell you nothing about how the practice is doing.',
      'EFT deposits arrive bundled and netted against fees, and matching them to remittance advices takes hours nobody has.',
      'Provider compensation is due, and the collections data behind it is a spreadsheet argument.',
      'Equipment financing, tenant improvements, and software subscriptions are scattered across the books with no clear picture of practice overhead.',
      'Your practice management system and QuickBooks have never agreed on a single number.',
    ],
    howWeHelp: [
      {
        title: 'Books built around remittance timing',
        text: 'We reconcile insurance EFTs and patient payments to the bank, book processor and clearinghouse fees correctly, and keep the timing gap between production and cash from distorting your P&L.',
      },
      {
        title: 'Clean data for provider compensation',
        text: 'Collections and expense allocations maintained accurately by provider or class, so compensation formulas run on numbers everyone trusts. You set the formula; we make the inputs solid.',
      },
      {
        title: 'Overhead you can actually manage',
        text: 'A practice-specific chart of accounts that separates clinical supplies, lab fees, staff costs, facility, and equipment, benchmarked over time so overhead creep is visible early.',
      },
      {
        title: 'Equipment and buildout tracked properly',
        text: 'Loans, leases, and depreciation schedules for chairs, imaging, and buildouts kept current and coordinated with your CPA, so the balance sheet reflects what the practice actually owns and owes.',
      },
      {
        title: 'A clear boundary with your billing team',
        text: 'Your billers work claims and denials; we make sure what they collect lands correctly in the books. We reconcile to their reports monthly so nothing falls in the gap between systems.',
      },
    ],
    serviceSlugs: ['monthly-bookkeeping', 'financial-reporting', 'payroll-support', 'controller-cfo-advisory'],
    faqs: [
      {
        q: 'Do you do medical billing or coding?',
        a: 'No. Claims, coding, and collections stay with your billing team or service. We handle the accounting side: reconciling what is collected to the bank and the books, and reporting on the practice as a business. The two functions work best clearly separated.',
      },
      {
        q: 'Do you need access to patient information?',
        a: 'No. We work from bank data, remittance totals, and summary reports from your practice management system. We do not need, or want, patient-level clinical data, and our processes are designed to keep it that way.',
      },
      {
        q: 'Can you support an associate buy-in or practice sale?',
        a: 'Clean, well-organized books are the foundation of any valuation. We maintain them to that standard, prepare the financial packages, and coordinate with your CPA and broker, who lead the transaction itself.',
      },
    ],
  },
  {
    slug: 'ecommerce-retail',
    name: 'Ecommerce & Retail',
    title: 'Bookkeeping for ecommerce and retail businesses',
    metaTitle: 'Ecommerce Bookkeeping Services Texas | Balance Bridge',
    metaDescription:
      'Ecommerce bookkeeping for Texas sellers. Multi-channel sales, inventory and COGS, marketplace fees, and sales tax nexus handled with clean books.',
    icon: 'cart',
    oneLiner: 'Multi-channel sales tied out, real COGS and margins by channel, and sales tax nexus tracked before it bites.',
    heroSub:
      'Selling on Shopify, Amazon, and a retail counter means three fee structures, three payout schedules, and one very confused bank feed. We tie it all out and show you what you actually earn per channel after fees.',
    pains: [
      'Marketplace payouts arrive as lump sums with fees, refunds, and reserves netted out, and your books just call it "sales."',
      'You know revenue by channel but not profit by channel, so you scale ads on gut feel.',
      'Inventory and COGS are a year-end guess, which means your margins are a year-end guess too.',
      'Sales tax nexus is a phrase you have heard and are actively avoiding thinking about.',
      'Refunds, chargebacks, and platform reserves make your cash never match your dashboard.',
    ],
    howWeHelp: [
      {
        title: 'Channel payouts tied out gross-to-net',
        text: 'Shopify, Amazon, Etsy, and POS settlements broken out into gross sales, fees, refunds, and reserves, reconciled to the bank. "Deposit from Amazon" stops being a category.',
      },
      {
        title: 'Real margins by channel',
        text: 'P&L by sales channel with marketplace fees, shipping, and payment costs allocated where they belong, so you can see that one channel earns 22 points and another earns 6 before you double the ad spend.',
      },
      {
        title: 'Inventory and COGS discipline',
        text: 'A monthly inventory and cost-of-goods process, synced with your inventory tool where you have one, so gross margin is a monthly fact instead of an annual surprise.',
      },
      {
        title: 'Sales tax nexus monitoring',
        text: 'We track your sales by state against economic nexus thresholds, flag where registration obligations are approaching, and organize the data your CPA or sales tax service needs to register and file.',
      },
      {
        title: 'Clean books for lenders and platforms',
        text: 'Inventory financing, platform capital, and bank credit all start with credible books. We keep yours ready for the application before you need the money.',
      },
    ],
    serviceSlugs: ['monthly-bookkeeping', 'quickbooks-setup-cleanup', 'bank-reconciliation', 'cash-flow-budgeting'],
    faqs: [
      {
        q: 'Which platforms and tools do you support?',
        a: 'Shopify, Amazon, Etsy, Walmart Marketplace, WooCommerce, and retail POS systems like Square and Clover, connected to QuickBooks Online through connectors such as A2X where volume justifies it. We pick the stack for your volume, not the fanciest one.',
      },
      {
        q: 'Do you handle sales tax registration and filings?',
        a: 'We monitor nexus exposure and keep the sales data clean and state-ready. Registrations and filings are executed by your CPA or a dedicated sales tax service, and we coordinate directly with them so nothing is duplicated or missed.',
      },
      {
        q: 'Our last two years of ecommerce books are a mess. Where do we start?',
        a: 'With a cleanup project. Ecommerce cleanups mostly involve rebuilding sales gross-to-net from platform reports, which we do routinely. Once the history is credible, monthly service keeps it that way.',
      },
    ],
  },
  {
    slug: 'professional-services',
    name: 'Professional Services',
    title: 'Bookkeeping for professional services firms',
    metaTitle: 'Bookkeeping for Professional Services | Balance Bridge',
    metaDescription:
      'Bookkeeping for Texas consultancies, agencies, and firms. Utilization and realization visibility, WIP tracking, and books that respect trust accounting.',
    icon: 'briefcase',
    oneLiner: 'Books that show utilization, realization, and profit per client, because your inventory is hours.',
    heroSub:
      'In a services firm the product is time, and the leaks are invisible: unbilled work, write-offs, and clients that consume twice what they pay for. We keep the books clean and make those leaks show up in a report.',
    pains: [
      'Work gets delivered in January and invoiced in March, and nobody can say how much unbilled work is sitting in the pipeline.',
      'You bill $200 an hour but have no idea what an hour actually costs to deliver.',
      'Some clients are quietly unprofitable, and they are usually the loudest ones.',
      'Retainers and prepayments hit revenue when the cash lands, not when the work happens, so every month is misstated.',
      'If you hold client funds in trust, you know the bookkeeping rules are strict, and you are not certain yours would survive a review.',
    ],
    howWeHelp: [
      {
        title: 'WIP and unbilled work made visible',
        text: 'A monthly work-in-progress view of delivered-but-unbilled work, so revenue leakage gets billed instead of forgotten and month-end revenue reflects work actually performed.',
      },
      {
        title: 'Profitability by client and engagement',
        text: 'Time and cost tracked against clients or projects, producing a report that names your most and least profitable relationships. Pricing conversations get much easier with it in hand.',
      },
      {
        title: 'Retainers booked properly',
        text: 'Prepayments held as liabilities and recognized as the work is delivered, so your P&L shows real monthly performance instead of cash timing noise.',
      },
      {
        title: 'Trust accounting awareness',
        text: 'For firms holding client funds, we keep trust balances strictly segregated from operating funds, reconciled monthly with per-client ledgers, and structured to the standards your bar or licensing body expects. Compliance sign-off stays with your counsel.',
      },
      {
        title: 'Utilization and realization on one page',
        text: 'The two numbers that run a services firm, reported monthly from your time and billing data, with trend lines so a slipping realization rate gets caught in weeks.',
      },
    ],
    serviceSlugs: ['monthly-bookkeeping', 'financial-reporting', 'accounts-payable-receivable', 'controller-cfo-advisory'],
    faqs: [
      {
        q: 'We are a law firm with an IOLTA account. Can you handle it?',
        a: 'We perform three-way reconciliation monthly: trust bank balance to the trust ledger to the sum of individual client ledgers, with documentation you can produce on request. Your responsibilities under State Bar of Texas rules remain yours, and we structure the books to support them.',
      },
      {
        q: 'Our revenue is a mix of retainers, fixed fees, and hourly. Is that a problem?',
        a: 'It is normal, and it is exactly why services firm books go wrong. We set up revenue recognition patterns for each arrangement type so the P&L reflects work delivered, and your CPA signs off on the treatment.',
      },
      {
        q: 'Do we need to change our time-tracking software?',
        a: 'Rarely. We integrate with what you have (Harvest, Clockify, Toggl, practice management suites) and pull the data into the books. If your current tool genuinely cannot support billing, we will say so and suggest options.',
      },
    ],
  },
  {
    slug: 'real-estate',
    name: 'Real Estate',
    title: 'Bookkeeping for real estate investors and firms',
    metaTitle: 'Real Estate Bookkeeping Services TX | Balance Bridge',
    metaDescription:
      'Real estate bookkeeping for Texas investors and brokerages. Entity-per-property books, escrow tracking, and commission accounting kept clean.',
    icon: 'home',
    oneLiner: 'Per-property books across all your entities, escrow tracked properly, and commissions clean at closing.',
    heroSub:
      'Real estate portfolios turn into accounting mazes fast: an LLC per property, escrow balances, security deposits, and commission splits. We keep each entity clean and give you the portfolio view on top.',
    pains: [
      'Every property has its own LLC, and money moves between them with no paper trail, creating intercompany knots your CPA untangles at your expense.',
      'You cannot see cash-on-cash return by property without building a spreadsheet from scratch.',
      'Escrow balances, security deposits, and property manager statements never quite reconcile to the bank.',
      'Closing statements get booked as one blob, burying loan costs, prorations, and basis details your CPA needs later.',
      'Commission splits, referral fees, and agent draws make brokerage books a monthly headache.',
    ],
    howWeHelp: [
      {
        title: 'Entity-per-property structure kept clean',
        text: 'Separate, complete books for each entity with intercompany transfers documented as loans or contributions, not mystery entries. Your liability protection is only as good as the separation in the books.',
      },
      {
        title: 'Performance by property',
        text: 'A portfolio dashboard on top of the entity books: NOI, cash flow, and cash-on-cash by property, so the underperformer surfaces in a report instead of at refinance time.',
      },
      {
        title: 'Escrow and deposits reconciled',
        text: 'Lender escrow balances, tenant security deposits, and earnest money tracked in their own accounts and reconciled monthly, with property manager statements tied to the bank.',
      },
      {
        title: 'Closings booked line by line',
        text: 'Settlement statements decomposed properly: purchase price, loan costs, prorated taxes, and fees each to the right account, preserving the basis detail your CPA needs for depreciation and eventual sale.',
      },
      {
        title: 'Commission accounting for brokerages',
        text: 'Gross commission income, agent splits, referral fees, and transaction fees tracked per deal, so agent 1099s and office profitability both come out clean.',
      },
    ],
    serviceSlugs: ['monthly-bookkeeping', 'financial-reporting', 'quickbooks-setup-cleanup', 'tax-prep-coordination'],
    faqs: [
      {
        q: 'We have nine LLCs. Do we need nine QuickBooks subscriptions?',
        a: 'Usually yes, one file per entity, because commingled books undermine the reason the entities exist. We structure multi-entity pricing accordingly and keep a consolidated portfolio view on top, so clean separation does not cost you visibility.',
      },
      {
        q: 'Can you work with our property management company\'s statements?',
        a: 'Yes. We reconcile PM statements to bank activity monthly, book rents, management fees, maintenance, and reserves correctly, and flag discrepancies. Owners are often surprised what a real reconciliation of PM statements turns up.',
      },
      {
        q: 'Do you track depreciation and handle 1031 exchanges?',
        a: 'We maintain the fixed asset records and closing details that depreciation schedules and exchange calculations are built from, and coordinate with your CPA, who owns the tax treatment. Clean basis records are what make those strategies work.',
      },
    ],
  },
];
