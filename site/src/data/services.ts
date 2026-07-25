import type { ServiceDef } from './types';

export const SERVICES: ServiceDef[] = [
  {
    slug: 'monthly-bookkeeping',
    name: 'Monthly Bookkeeping',
    title: 'Monthly bookkeeping that closes on time, every time',
    metaTitle: 'Monthly Bookkeeping Services in Texas | Balance Bridge',
    metaDescription:
      'Monthly bookkeeping for Texas small businesses. Books reconciled to the penny and reports in your inbox by the 10th business day. Plans from $395/mo.',
    icon: 'book',
    oneLiner: 'Every transaction categorized, every account reconciled, reports delivered on a date you can set your watch by.',
    heroSub:
      'We handle the categorizing, reconciling, and month-end close so you get accurate financials on a fixed schedule. You run the business; the books just show up done.',
    symptoms: [
      'You find out how the month went six weeks after it ended.',
      'Your "bookkeeping system" is a folder of receipts and a promise to deal with it Sunday.',
      'QuickBooks says one number, your bank says another, and nobody knows which to trust.',
      'Tax season starts with your CPA sending a list of 40 questions about last year.',
      'You put off invoicing and bills because the books are too messy to know what is safe to spend.',
    ],
    included: [
      'All transactions categorized weekly, not in a month-end scramble',
      'Every bank, credit card, and loan account reconciled to the penny',
      'Month-end close on a fixed calendar, with a written close checklist',
      'Profit and loss, balance sheet, and cash summary delivered to your portal',
      'A plain-English note flagging anything unusual we found that month',
      'Clean, CPA-ready books your tax preparer can use without cleanup fees',
      'Unlimited email questions about your numbers, answered by a human',
    ],
    steps: [
      {
        title: 'Free review',
        text: 'We look at your current books, count real transaction volume, and quote a flat monthly price. No hourly surprises.',
      },
      {
        title: 'Clean start',
        text: 'We fix what needs fixing, connect your accounts with read-only access, and set your close calendar.',
      },
      {
        title: 'Monthly rhythm',
        text: 'We categorize weekly, reconcile monthly, and deliver your reports on the same business day each month.',
      },
      {
        title: 'Stay ahead',
        text: 'Quarterly, we review trends with you and coordinate with your CPA so year-end is a non-event.',
      },
    ],
    priceAnchor: 'Included in plans from $395/mo',
    faqs: [
      {
        q: 'What day do I actually get my reports?',
        a: 'Depends on your plan: by the 15th business day on Essentials, the 10th on Growth, and the 8th on Controller+. We hit the date or we tell you why before it slips, not after.',
      },
      {
        q: 'My books are months behind. Can you still take me on?',
        a: 'Yes. We quote a one-time catch-up project first (from $750, based on how far behind and how messy), get you current, then roll you into a monthly plan.',
      },
      {
        q: 'Do I have to switch accounting software?',
        a: 'We work in QuickBooks Online because it is what most Texas small businesses and their CPAs use. If you are on something else, we will migrate you as part of onboarding and you keep full ownership of the file.',
      },
      {
        q: 'Will you work with the CPA I already have?',
        a: 'Absolutely. That relationship stays yours. We keep the books tax-ready year-round and hand your CPA a clean file at year-end. We do not prepare or file returns.',
      },
    ],
    related: ['bank-reconciliation', 'financial-reporting'],
    industrySlugs: ['professional-services', 'construction-trades', 'restaurants-hospitality'],
  },
  {
    slug: 'payroll-support',
    name: 'Payroll Support',
    title: 'Payroll support that keeps payday boring',
    metaTitle: 'Payroll Support for Small Business TX | Balance Bridge',
    metaDescription:
      'Payroll setup, processing support, and clean payroll accounting for Texas small businesses. Employees paid on time, filings tracked, books tied out.',
    icon: 'users',
    oneLiner: 'Payroll set up right, run on schedule, and booked correctly, so payday never becomes a fire drill.',
    heroSub:
      'We set up and support your payroll platform, keep the payroll entries in your books accurate, and track the filings your provider handles, so nothing falls through the cracks between systems.',
    symptoms: [
      'Payroll takes you two hours every other Thursday and you still worry you missed something.',
      'Your payroll reports and your P&L never quite match, and no one can explain why.',
      'You are not sure whether that new hire should be a W-2 employee or a 1099 contractor.',
      'A late payroll tax notice showed up and you do not know if it was ever resolved.',
      'Contractor payments happen from three different apps and 1099 season is a scavenger hunt.',
    ],
    included: [
      'Payroll platform setup or cleanup (Gusto, QuickBooks Payroll, ADP)',
      'Pay schedule, earnings, and deduction configuration done once, correctly',
      'Payroll journal entries mapped so wages, taxes, and benefits hit the right accounts',
      'Reconciliation of payroll reports to your bank and your books every month',
      'Contractor payment tracking and year-end 1099 preparation support',
      'Filing calendar monitoring so federal and Texas deadlines never sneak up',
    ],
    steps: [
      {
        title: 'Audit what exists',
        text: 'We review your current payroll setup, past filings, and how payroll flows into your books.',
      },
      {
        title: 'Fix the plumbing',
        text: 'We correct account mappings, clean up misbooked payroll entries, and configure the platform properly.',
      },
      {
        title: 'Run the rhythm',
        text: 'Each cycle, payroll posts to your books correctly and we reconcile reports to cash monthly.',
      },
    ],
    priceAnchor: 'Included in plans from $795/mo; setup from $350',
    faqs: [
      {
        q: 'Do you actually process payroll, or just support it?',
        a: 'Your payroll platform processes the runs and files the taxes; that is what those platforms are built for. We set it up correctly, keep it reconciled to your books, monitor deadlines, and fix problems. Most clients spend under 10 minutes per payroll after we take over the rest.',
      },
      {
        q: 'Can you help me decide between employee and contractor?',
        a: 'We will walk you through the IRS and Texas Workforce Commission factors and organize the documentation. For a formal determination on a close call, we bring in your CPA or an employment attorney; classification penalties are not worth guessing on.',
      },
      {
        q: 'We got a payroll tax notice. Can you handle it?',
        a: 'We will research what happened, pull the filings, and coordinate the response with your payroll provider and CPA. Most notices trace back to a setup error, which we fix so it does not recur.',
      },
    ],
    related: ['monthly-bookkeeping', 'new-business-setup'],
    industrySlugs: ['restaurants-hospitality', 'construction-trades', 'medical-dental'],
  },
  {
    slug: 'accounts-payable-receivable',
    name: 'AP & AR',
    title: 'Accounts payable and receivable, handled',
    metaTitle: 'AP & AR Services for Small Business | Balance Bridge',
    metaDescription:
      'Accounts payable and receivable services for Texas small businesses. Bills paid on time, invoices out fast, and collections tracked so cash keeps moving.',
    icon: 'send',
    oneLiner: 'Bills paid on schedule, invoices out the door fast, and a weekly list of exactly who owes you what.',
    heroSub:
      'Cash flow problems usually start as paperwork problems. We run your bill-pay and invoicing workflows so money leaves on your schedule and comes in faster.',
    symptoms: [
      'Invoices go out days or weeks after the work is done, and get paid even later.',
      'You have paid a late fee this year on a bill you had the cash for.',
      'You could not say, right now, which customers owe you money and how overdue they are.',
      'A vendor called about an unpaid invoice you were sure you already paid.',
      'You approve payments from memory instead of from a process.',
    ],
    included: [
      'Vendor bill capture, coding, and a payment run on your approval schedule',
      'Digital approval workflow, so you approve payments from your phone in minutes',
      'Customer invoicing prepared and sent on your cadence',
      'Weekly AR aging report with a plain-English "who to nudge" summary',
      'Polite, systematic follow-up templates for past-due invoices',
      'Vendor statement reconciliation so you never pay the same bill twice',
      'W-9 collection from vendors so 1099 season is already done',
    ],
    steps: [
      {
        title: 'Map the flow',
        text: 'We document how bills arrive and invoices go out today, then design a simpler pipeline with clear approval points.',
      },
      {
        title: 'Set up the tools',
        text: 'We configure bill-pay and invoicing tools connected to your books, with you as the only approver of outgoing money.',
      },
      {
        title: 'Run it weekly',
        text: 'Bills get coded and queued, invoices go out on schedule, and you get an aging report every week.',
      },
    ],
    priceAnchor: 'Included in Growth plans from $795/mo',
    faqs: [
      {
        q: 'Do you have access to move my money?',
        a: 'No. We prepare and queue payments; you approve every release. We work with view-and-prepare access, and the authority to move funds stays with you.',
      },
      {
        q: 'Will you call my customers about overdue invoices?',
        a: 'We start with systematic written reminders sent under your business name, which resolves most past-due balances. For stubborn accounts we prepare the call list and history so you, or we, can escalate deliberately rather than awkwardly.',
      },
      {
        q: 'How much faster will I actually get paid?',
        a: 'The biggest gain comes from invoicing the day work completes instead of weeks later, plus reminders that actually go out. Clients commonly cut days-to-paid by two to three weeks within a quarter. We will measure yours and show you.',
      },
    ],
    related: ['monthly-bookkeeping', 'cash-flow-budgeting'],
    industrySlugs: ['construction-trades', 'professional-services', 'medical-dental'],
  },
  {
    slug: 'bank-reconciliation',
    name: 'Bank Reconciliation',
    title: 'Bank reconciliation you can bet the business on',
    metaTitle: 'Bank Reconciliation Services Texas | Balance Bridge',
    metaDescription:
      'Monthly bank and credit card reconciliation for Texas businesses. Every account tied out to the penny, discrepancies chased down, fraud spotted early.',
    icon: 'scale',
    oneLiner: 'Every bank and card account tied out to the penny each month, with discrepancies chased to an answer.',
    heroSub:
      'Reconciliation is the difference between numbers you hope are right and numbers you know are right. We tie every account to its statement, every month, and investigate anything that does not match.',
    symptoms: [
      'Your QuickBooks balance and your bank balance disagree, and have for a while.',
      'There are transactions in your books from months ago that never cleared and no one has asked why.',
      'You found a subscription charge you did not recognize, and wondered what else you have missed.',
      'Your last reconciliation was done by clicking "match all" and hoping.',
      'Undeposited funds keeps growing and nobody knows what is in it.',
    ],
    included: [
      'Monthly reconciliation of every bank, credit card, loan, and merchant account',
      'Every unmatched item investigated to a documented answer, not written off',
      'Stale uncleared checks and deposits researched and resolved',
      'Duplicate and unrecognized charges flagged to you the week we find them',
      'Merchant processor deposits (Stripe, Square, Clover) tied out gross-to-net, fees booked correctly',
      'A reconciliation report in your monthly package showing every account tied out',
    ],
    steps: [
      {
        title: 'Baseline',
        text: 'We reconcile every account to the most recent statement and document any historical breaks we inherit.',
      },
      {
        title: 'Monthly tie-out',
        text: 'As statements land, we match, investigate, and resolve. Anything odd gets flagged to you fast.',
      },
      {
        title: 'Report and prevent',
        text: 'Your close package shows every account reconciled, and we fix the process gaps that caused recurring breaks.',
      },
    ],
    priceAnchor: 'Included in all plans from $395/mo',
    faqs: [
      {
        q: 'Why does reconciliation matter if my bank feed imports everything?',
        a: 'Bank feeds import what the bank saw; they do not catch duplicates, missing transactions, processor fees, or fraud. Reconciliation compares your books to the official statement line by line. The feed is the raw material; the reconciliation is the quality check.',
      },
      {
        q: 'Have you actually caught fraud this way?',
        a: 'Yes. Recurring charges after canceled subscriptions, card skimming, double-charged vendors, and in one case a former employee\'s card still being used. Monthly reconciliation is the earliest tripwire most small businesses have.',
      },
      {
        q: 'My accounts have not been reconciled in over a year. Where do we start?',
        a: 'With a catch-up reconciliation project, priced flat after we see the accounts. We work forward from your last clean month, document what we find, and hand you a set of books you can finally trust.',
      },
    ],
    related: ['monthly-bookkeeping', 'quickbooks-setup-cleanup'],
    industrySlugs: ['restaurants-hospitality', 'ecommerce-retail'],
  },
  {
    slug: 'quickbooks-setup-cleanup',
    name: 'QuickBooks Setup & Cleanup',
    title: 'QuickBooks cleanup and setup done right the first time',
    metaTitle: 'QuickBooks Cleanup & Setup in Texas | Balance Bridge',
    metaDescription:
      'QuickBooks Online cleanup, catch-up, and setup for Texas businesses. Fixed-fee projects that turn a messy file into books your CPA can actually use.',
    icon: 'sparkles',
    oneLiner: 'We untangle messy QuickBooks files and set up new ones so the numbers finally mean something.',
    heroSub:
      'A QuickBooks file full of duplicates, misclassified transactions, and mystery balances is worse than no file at all. We fix it on a flat fee, or set yours up correctly from day one.',
    symptoms: [
      'Your P&L shows a profit you know is not real, or a loss you know is not either.',
      'Opening balance equity has a number in it and nobody can say why.',
      'Accounts receivable shows customers who paid you years ago.',
      'Your CPA quoted extra fees just to make your file usable at tax time.',
      'You set up QuickBooks yourself in a weekend and have regretted it ever since.',
    ],
    included: [
      'A diagnostic review of your file with a written findings summary before we start',
      'Chart of accounts rebuilt around how you actually run the business',
      'Duplicates removed, transactions recategorized, and balances corrected with an audit trail',
      'Every bank and card account reconciled through the cleanup period',
      'AR and AP scrubbed so open invoices and bills reflect reality',
      'Bank feeds, rules, and user permissions configured correctly',
      'A handoff walkthrough, recorded, so you know what changed and why',
    ],
    steps: [
      {
        title: 'Diagnostic',
        text: 'We review your file and give you a written scope: what is broken, what it takes to fix, and a flat price.',
      },
      {
        title: 'Cleanup',
        text: 'We fix the file month by month, reconciling as we go, with a change log of every correction.',
      },
      {
        title: 'Handoff or handover',
        text: 'Take the clean file and run with it, or roll into a monthly plan so it never gets messy again.',
      },
    ],
    priceAnchor: 'One-time projects from $750',
    faqs: [
      {
        q: 'How long does a cleanup take?',
        a: 'Most single-entity cleanups covering 6 to 18 months finish in 2 to 4 weeks. Multi-year or multi-entity projects take longer, and we will give you a real timeline in the diagnostic, not a guess on a sales call.',
      },
      {
        q: 'Is cleanup priced hourly?',
        a: 'No. After the diagnostic we quote a flat project fee starting at $750. If we find something bigger mid-project, we pause and re-scope with you before spending your money.',
      },
      {
        q: 'Can you set up QuickBooks for a brand-new business?',
        a: 'Yes, and it is far cheaper than cleaning up later. Setup includes your chart of accounts, bank feeds, sales tax settings, users, and a training session, typically inside our new business setup package.',
      },
      {
        q: 'QuickBooks Online or Desktop?',
        a: 'We work in QuickBooks Online and can migrate you from Desktop. For nearly every Texas small business, Online\'s bank feeds, CPA access, and app ecosystem win out.',
      },
    ],
    related: ['monthly-bookkeeping', 'bank-reconciliation'],
    industrySlugs: ['ecommerce-retail', 'construction-trades', 'real-estate'],
  },
  {
    slug: 'financial-reporting',
    name: 'Financial Reporting',
    title: 'Financial reports you actually read',
    metaTitle: 'Financial Reporting for Small Business | Balance Bridge',
    metaDescription:
      'Monthly financial statements for Texas small businesses, delivered on schedule with a plain-English summary of what changed and what to do about it.',
    icon: 'chart',
    oneLiner: 'Monthly statements on a fixed date, plus a plain-English note on what changed and what deserves your attention.',
    heroSub:
      'A P&L you do not understand is just a PDF. We deliver accurate statements on schedule and translate them into the three or four things that actually matter this month.',
    symptoms: [
      'You judge how the business is doing by the checking account balance.',
      'Reports arrive, you skim the bottom line, and file them unread.',
      'Your banker asked for financial statements and it took two weeks to produce them.',
      'You cannot see which jobs, locations, or service lines actually make money.',
      'Margins are slipping and you found out from your gut, not your reports.',
    ],
    included: [
      'Monthly P&L, balance sheet, and statement of cash flows on a fixed delivery date',
      'Month-over-month and year-over-year comparisons with variances highlighted',
      'A one-page plain-English summary: what changed, why, and what to watch',
      'Custom views by job, location, or class where your business needs them',
      'KPI tracking for the handful of numbers that drive your business',
      'Lender- and investor-ready statement packages on request',
    ],
    steps: [
      {
        title: 'Define what matters',
        text: 'We learn how you make money and pick the views and KPIs worth tracking. No 40-page report dumps.',
      },
      {
        title: 'Close and deliver',
        text: 'After each month closes, your package lands in the portal on its scheduled date with the summary up top.',
      },
      {
        title: 'Review together',
        text: 'On Growth and Controller+ plans, we walk the numbers with you on a recurring call and turn them into decisions.',
      },
    ],
    priceAnchor: 'Included in plans from $395/mo',
    faqs: [
      {
        q: 'What is in the monthly package?',
        a: 'P&L, balance sheet, cash flow statement, comparisons to prior periods, and a one-page summary in plain English. Growth and Controller+ plans add custom views like job profitability or location comparisons.',
      },
      {
        q: 'Can you produce statements for a loan application?',
        a: 'Yes. We prepare the statement package most Texas lenders ask for from your bookkeeping records, and coordinate with your CPA if the lender requires CPA-prepared or reviewed statements, which are a different product than bookkeeping reports.',
      },
      {
        q: 'What if I do not understand something in the reports?',
        a: 'Ask. Plain-English answers to questions about your own numbers are included in every plan, and no question is too basic. That is the point of the summary page too.',
      },
    ],
    related: ['monthly-bookkeeping', 'cash-flow-budgeting'],
    industrySlugs: ['professional-services', 'medical-dental', 'real-estate'],
  },
  {
    slug: 'cash-flow-budgeting',
    name: 'Cash Flow & Budgeting',
    title: 'Cash flow forecasting and budgets that earn their keep',
    metaTitle: 'Cash Flow & Budgeting Services TX | Balance Bridge',
    metaDescription:
      'Cash flow forecasting and budgeting for Texas small businesses. See tight weeks coming, plan hires and purchases, and stop managing by bank balance.',
    icon: 'trending',
    oneLiner: 'A rolling 13-week cash forecast and a budget you check against reality, so tight weeks stop being surprises.',
    heroSub:
      'Profitable businesses still run out of cash; timing is the killer. We build a rolling forecast from your real receivables, payables, and payroll so you see crunches weeks out, while there is still time to act.',
    symptoms: [
      'You have delayed your own paycheck to make payroll.',
      'A big deposit makes you feel rich for a week, then quarterly taxes hit.',
      'You want to hire but cannot tell if you can afford it in month four, not just month one.',
      'Your "budget" was written in January and never opened again.',
      'Slow season arrives every year, and every year it is somehow a surprise.',
    ],
    included: [
      'A rolling 13-week cash flow forecast, updated on a set schedule',
      'Scenario versions for real decisions: the hire, the truck, the second location',
      'An annual operating budget built with you, not just extrapolated from last year',
      'Monthly budget-versus-actual reporting with variances explained in plain English',
      'Seasonal cash planning and a reserve target sized to your business',
      'Early-warning flags when the forecast shows a crunch coming',
    ],
    steps: [
      {
        title: 'Build the model',
        text: 'We map your real cash rhythms: receivable timing, payables, payroll, debt, taxes, and seasonality.',
      },
      {
        title: 'Keep it current',
        text: 'The forecast updates from your actual books on schedule, so it stays a tool instead of becoming a relic.',
      },
      {
        title: 'Decide with it',
        text: 'Before big commitments, we run the scenario and show the cash impact by week. Then you decide with eyes open.',
      },
    ],
    priceAnchor: 'Included in Controller+ plans from $1,495/mo',
    faqs: [
      {
        q: 'Why 13 weeks?',
        a: 'One quarter is far enough out to act on, and close enough in to stay accurate. Weekly granularity is what catches problems that a monthly view averages away, like payroll landing two days before a big receivable.',
      },
      {
        q: 'Do I need clean books first?',
        a: 'Yes. A forecast built on unreconciled books is fiction with formatting. If your books need work, we handle cleanup first; forecasting is included in Controller+ plans and available as an add-on to Growth.',
      },
      {
        q: 'Is a budget worth it for a small company?',
        a: 'A useful budget is not a 30-tab spreadsheet; it is a dozen lines you actually check against reality each month. That habit alone is where most owners find their first margin improvements.',
      },
    ],
    related: ['financial-reporting', 'controller-cfo-advisory'],
    industrySlugs: ['restaurants-hospitality', 'construction-trades', 'ecommerce-retail'],
  },
  {
    slug: 'controller-cfo-advisory',
    name: 'Controller & CFO Advisory',
    title: 'Fractional controller and CFO advisory for growing Texas businesses',
    metaTitle: 'Fractional CFO Services in Texas | Balance Bridge',
    metaDescription:
      'Fractional controller and CFO advisory for Texas businesses. Senior financial leadership on a monthly plan, for a fraction of a full-time hire.',
    icon: 'compass',
    oneLiner: 'Senior financial leadership on a fraction of a full-time salary: margins, pricing, financing, and a plan.',
    heroSub:
      'Somewhere between $1M and $10M in revenue, businesses outgrow bookkeeping-only. Advisory adds the person who owns the numbers, pressure-tests decisions, and sits on your side of the table with lenders.',
    symptoms: [
      'Revenue keeps growing but the profit and the cash never seem to.',
      'You set prices years ago and have no idea what your real margin is today.',
      'A bank or investor asked hard questions about your numbers and you improvised.',
      'Every big financial decision lands on you alone, at 11 p.m.',
      'You have a bookkeeper but nobody who tells you what the numbers mean for what to do next.',
    ],
    included: [
      'A monthly advisory call working through your numbers and your decisions',
      'Margin and pricing analysis by product, service line, or job',
      'A financial dashboard with the KPIs that actually drive your business',
      'Cash flow forecasting and scenario modeling for major decisions',
      'Lender and investor preparation: the package, the story, and the rehearsal',
      'Compensation, hiring, and equipment decisions modeled before you commit',
      'Coordination with your CPA on entity structure and tax planning questions',
    ],
    steps: [
      {
        title: 'Deep dive',
        text: 'We spend the first month inside your numbers and your model, and come back with a written assessment and priorities.',
      },
      {
        title: 'Fix the leaks',
        text: 'Early months target the found money: pricing gaps, margin leaks, cash conversion, and cost creep.',
      },
      {
        title: 'Lead the numbers',
        text: 'Ongoing, you get a standing monthly session, a live dashboard, and a call-anytime line for financial decisions.',
      },
    ],
    priceAnchor: 'Advisory plans from $1,495/mo',
    faqs: [
      {
        q: 'What is the difference between a controller and a CFO here?',
        a: 'Controller work makes the numbers right and on time: close discipline, reporting quality, internal controls. CFO work makes the numbers useful: strategy, pricing, financing, forecasting. Most clients need a blend, and our plans flex between the two.',
      },
      {
        q: 'When does advisory make sense over bookkeeping alone?',
        a: 'Common triggers: passing roughly $1M in revenue, hiring past ten people, taking on debt or investors, margins you cannot explain, or a big decision like a second location. If you are guessing on decisions with five-figure consequences, it is time.',
      },
      {
        q: 'How does this compare to hiring a full-time CFO?',
        a: 'A full-time CFO in Texas typically runs $180K to $250K plus benefits. Most businesses under $15M need CFO-level thinking a few days a month, not a full-time seat. Advisory delivers the thinking without the payroll line.',
      },
      {
        q: 'Do you give tax advice?',
        a: 'We surface the questions worth asking and model the financial side, then coordinate the answer with your CPA, who owns tax strategy and filings. You get one joined-up answer instead of two contradicting ones.',
      },
    ],
    related: ['cash-flow-budgeting', 'financial-reporting'],
    industrySlugs: ['professional-services', 'construction-trades', 'medical-dental'],
  },
  {
    slug: 'new-business-setup',
    name: 'New Business Setup',
    title: 'New business accounting setup, done once and done right',
    metaTitle: 'New Business Accounting Setup TX | Balance Bridge',
    metaDescription:
      'Accounting setup for new Texas businesses. Chart of accounts, QuickBooks, payroll, and sales tax registration handled in one flat-fee package.',
    icon: 'rocket',
    oneLiner: 'Your accounting foundation built in week one, so you never pay for a cleanup in year two.',
    heroSub:
      'The most expensive bookkeeping mistakes are made in the first ninety days, before there is a bookkeeper. We set up the accounts, software, and habits so your books start clean and stay that way.',
    symptoms: [
      'You formed the LLC, opened the doors, and are still running everything through a personal card.',
      'You do not know if you should register for Texas sales tax, franchise tax, or both.',
      'QuickBooks is sitting in a browser tab, untouched, because the setup screens lost you.',
      'You are about to hire your first employee and payroll feels like a legal minefield.',
      'Every founder friend has warned you about their year-two cleanup bill.',
    ],
    included: [
      'Business bank account and credit card structure that keeps funds cleanly separated',
      'QuickBooks Online configured with a chart of accounts built for your industry',
      'Texas sales tax and franchise tax registration guidance, coordinated with your CPA',
      'Payroll platform setup when you are ready for your first hire',
      'Receipt capture and bookkeeping habits that take minutes a week, not weekends',
      'A 60-minute working session covering exactly how to keep it clean',
      'A written setup summary your future CPA will thank you for',
    ],
    steps: [
      {
        title: 'Foundation call',
        text: 'We map your entity, revenue streams, and plans, and confirm the registration and account structure you need.',
      },
      {
        title: 'Build week',
        text: 'We stand up the accounts, software, and workflows, configured for your business rather than the defaults.',
      },
      {
        title: 'Launch and support',
        text: 'You get the walkthrough, the written guide, and 30 days of included questions while it all becomes routine.',
      },
    ],
    priceAnchor: 'Flat-fee packages from $500',
    faqs: [
      {
        q: 'Do you form the LLC for me?',
        a: 'Formation is filed with the Texas Secretary of State by you or your attorney. We pick up from there: everything that makes the entity financially real, from bank structure to books to registrations, coordinated with your CPA on tax elections.',
      },
      {
        q: 'Does my new Texas business owe franchise tax?',
        a: 'Most Texas entities must file a franchise tax report even when no tax is due, and thresholds have changed in recent years. We will walk you through the requirements and verify current figures with the Texas Comptroller as part of setup.',
      },
      {
        q: 'I have been open six months with no bookkeeping. Same package?',
        a: 'Close. We add a small catch-up component to record your first months properly, then complete the standard setup. Six months of catch-up is a molehill; thirty is a mountain. Come in early.',
      },
    ],
    related: ['quickbooks-setup-cleanup', 'monthly-bookkeeping'],
    industrySlugs: ['professional-services', 'ecommerce-retail', 'construction-trades'],
  },
  {
    slug: 'tax-prep-coordination',
    name: 'Tax Prep Coordination',
    title: 'Tax-ready books and a CPA handoff with zero scramble',
    metaTitle: 'Tax-Ready Bookkeeping in Texas | Balance Bridge',
    metaDescription:
      'Tax-ready bookkeeping for Texas businesses. We keep books CPA-clean all year and run the year-end handoff, so filing season is quiet, not chaotic.',
    icon: 'file-check',
    oneLiner: 'Books kept CPA-clean all year and a complete year-end package delivered to your tax preparer in January.',
    heroSub:
      'We are not a CPA firm and we do not file returns. What we do is make your CPA\'s job fast and your tax season quiet: clean books all year, and an organized year-end handoff without the March scramble.',
    symptoms: [
      'Every spring, your CPA sends a question list that takes you weeks to answer.',
      'You have filed an extension for reasons that had nothing to do with strategy.',
      'Your tax bill included cleanup hours billed at CPA rates for bookkeeper work.',
      'Estimated payments are guesses because mid-year numbers are never ready.',
      'Your CPA and your bookkeeper have never once spoken to each other.',
    ],
    included: [
      'Books maintained to your CPA\'s standards all year, not patched in January',
      'A complete year-end package: statements, reconciliations, loan and asset schedules',
      'Direct communication with your CPA, so questions come to us first',
      'Clean records supporting quarterly estimated payment calculations by your CPA',
      'Texas franchise tax report data prepared for your CPA or filing service',
      '1099 data compiled with W-9s already collected through the year',
      'Adjusting entries from the filed return booked back, so books match the return',
    ],
    steps: [
      {
        title: 'Connect with your CPA',
        text: 'We introduce ourselves, learn their preferences, and agree on the year-end handoff format and timing.',
      },
      {
        title: 'Stay ready all year',
        text: 'Monthly closes keep the books tax-ready continuously. Your CPA gets mid-year access whenever planning requires it.',
      },
      {
        title: 'Deliver the package',
        text: 'In January, your CPA receives the complete package. Their follow-up questions come to us, not your inbox.',
      },
    ],
    priceAnchor: 'Included in all monthly plans',
    faqs: [
      {
        q: 'Do you prepare or file tax returns?',
        a: 'No. Balance Bridge is a bookkeeping and accounting services firm, not a CPA firm. Returns are prepared and filed by your CPA or enrolled agent. Our job is to make their work fast, accurate, and cheaper for you.',
      },
      {
        q: 'What if I do not have a CPA?',
        a: 'We will refer you to Texas CPAs we work with regularly, matched to your industry and size. You choose and engage them directly; we simply know who does good work at fair rates.',
      },
      {
        q: 'Will this actually lower my tax prep bill?',
        a: 'Usually, yes. CPAs bill for time, and untangling messy books is billed at their rates. Clients who come to us after a rough tax season commonly report meaningfully lower prep invoices once their CPA receives clean, reconciled books.',
      },
      {
        q: 'Can you help with Texas franchise tax?',
        a: 'We prepare the revenue and margin data the report is built from and hand it to your CPA or filing service. Thresholds and rules change, so we always verify current figures with the Texas Comptroller rather than assuming last year\'s.',
      },
    ],
    related: ['monthly-bookkeeping', 'financial-reporting'],
    industrySlugs: ['professional-services', 'real-estate', 'medical-dental'],
  },
];
