import type { QA } from './types';

export const FAQS: (QA & { category: string })[] = [
  // Getting started
  {
    category: 'Getting started',
    q: 'How do we switch from our current bookkeeper?',
    a: 'You sign one authorization, and we handle the rest: requesting records, transferring the QuickBooks file, and reconciling what we inherit. Most switches complete inside two weeks, and you never have to have an awkward breakup call; a short written notice is enough, and we can even draft it for you.',
  },
  {
    category: 'Getting started',
    q: 'How long does onboarding take before the service is fully running?',
    a: 'Typically two to three weeks from signed proposal to your first monthly close. Week one is access and account connections, week two is our review and any cleanup scoping, and then your close calendar starts. If your books need significant catch-up work, that runs as a separate project first, with its own quoted timeline.',
  },
  {
    category: 'Getting started',
    q: 'What do you need access to?',
    a: 'Read-only bank and credit card feeds, your QuickBooks file, and statements. That is it for most clients. We cannot move your money: payment approvals always stay with you, and anything sensitive flows through the encrypted portal rather than email attachments.',
  },
  {
    category: 'Getting started',
    q: 'Do you work with the CPA we already have?',
    a: 'Yes, and we prefer it. We introduce ourselves to your CPA during onboarding, learn how they like the year-end package, and take their bookkeeping questions off your plate all year. We are not a CPA firm and do not file returns; keeping your CPA fast and happy is part of our job.',
  },
  // Services
  {
    category: 'Services',
    q: 'Do you only work in QuickBooks?',
    a: 'We standardize on QuickBooks Online because it is what most Texas small businesses and their CPAs run, and standardizing is why our quality stays high. If you are on Xero, Wave, or Desktop, we will migrate you as part of onboarding, and you always own your file and your data.',
  },
  {
    category: 'Services',
    q: 'Our books are months (or years) behind. Do you do catch-up work?',
    a: 'Constantly; it may be our most common starting point. Catch-up and cleanup run as a flat-fee project from $750, quoted after a free review of your file so the price reflects the actual mess, not a form estimate. Once you are current, monthly service keeps you there.',
  },
  {
    category: 'Services',
    q: 'What is the difference between payroll processing and payroll support?',
    a: 'Processing is running the payroll itself, which your payroll platform (Gusto, QuickBooks Payroll, ADP) does, including tax filings. Support is everything around it that platforms do not do: correct setup, account mapping, reconciling payroll to your books each month, monitoring deadlines, and untangling notices. We provide the support; the platform does the processing.',
  },
  // Pricing
  {
    category: 'Pricing',
    q: 'What actually determines my monthly price?',
    a: 'Three things drive it: monthly transaction volume, the number of accounts and entities we reconcile, and the scope you need (bookkeeping only versus AP/AR, payroll support, or advisory). Revenue by itself does not; a $2M business with clean, simple activity can cost less than a $500K business with six credit cards. Every quote follows a free review of your real numbers.',
  },
  {
    category: 'Pricing',
    q: 'Am I locked into a contract?',
    a: 'No long-term contracts. Service is month to month, and you can cancel with 30 days\' notice. If you leave, we finish the month cleanly and hand over your file in good order; your books are yours, and we do not hold them hostage.',
  },
  {
    category: 'Pricing',
    q: 'Will my price go up over time?',
    a: 'Only when your business does. Prices change when your volume or scope moves you into a different tier, and we tell you in writing at least 30 days before anything changes, with the reason attached. No silent increases on the anniversary of your signup.',
  },
  // Security & portal
  {
    category: 'Security & portal',
    q: 'How are my financial documents protected?',
    a: 'Everything moves through an encrypted client portal, in transit and at rest, never as email attachments. Bank connections are read-only feeds through the same connection services your bank supports, and access inside our team is limited to the people who work on your account.',
  },
  {
    category: 'Security & portal',
    q: 'Do you require multi-factor authentication?',
    a: 'Yes, on both sides. Our team uses MFA on every system that touches client data, and your portal login requires it too. It is thirty extra seconds that removes the single most common way small business financial accounts get compromised.',
  },
  {
    category: 'Security & portal',
    q: 'Are the electronic signatures you use legally valid?',
    a: 'Yes. E-signatures on engagement letters and authorizations are legally binding in the United States under the federal ESIGN Act and the Texas Uniform Electronic Transactions Act, the same standing as ink. Every signed document is stored in your portal with a full audit trail.',
  },
  // Working together
  {
    category: 'Working together',
    q: 'How often will we actually communicate?',
    a: 'Every month you get your close package with a plain-English summary; Growth clients add a quarterly review call and Controller+ clients a monthly one. Between those, you can send questions anytime through the portal or email, and if we spot something odd in your accounts, we flag it the week we find it rather than saving it for the report.',
  },
  {
    category: 'Working together',
    q: 'How fast do you respond when I have a question?',
    a: 'Within one business day, and usually the same day. Time-sensitive items like a payroll problem or a bank issue jump the queue. If a question needs real research, we tell you that day what we are digging into and when you will have the answer.',
  },
  {
    category: 'Working together',
    q: 'Is everything really remote? What if I want to meet in person?',
    a: 'We are remote-first by design, which is how we serve businesses from El Paso to Houston on the same standards. Onboarding, reviews, and screen-sharing sessions all happen over video, and most clients find a screen share beats a conference room for looking at numbers together. We are Texas-based, keep Texas hours, and you always talk to the same team.',
  },
];
