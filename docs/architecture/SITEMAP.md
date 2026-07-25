# Site Map & Information Architecture

## Public site (balancebridge.us)

```
/                               Home
├── /about/                     About — story, values, team, certifications
├── /services/                  Services hub (10 cards → detail pages)
│   ├── /services/monthly-bookkeeping/
│   ├── /services/payroll-support/
│   ├── /services/accounts-payable-receivable/
│   ├── /services/bank-reconciliation/
│   ├── /services/quickbooks-setup-cleanup/
│   ├── /services/financial-reporting/
│   ├── /services/cash-flow-budgeting/
│   ├── /services/controller-cfo-advisory/
│   ├── /services/new-business-setup/
│   └── /services/tax-prep-coordination/
├── /industries/                Industries hub
│   ├── /industries/construction-trades/
│   ├── /industries/restaurants-hospitality/
│   ├── /industries/medical-dental/
│   ├── /industries/ecommerce-retail/
│   ├── /industries/professional-services/
│   └── /industries/real-estate/
├── /pricing/                   3 tiers + comparison + quote CTA + pricing FAQs
├── /locations/                 Texas service area
│   ├── /locations/dallas-fort-worth/
│   ├── /locations/houston/
│   ├── /locations/austin/
│   ├── /locations/san-antonio/
│   └── /locations/el-paso/
├── /resources/                 Blog index (filterable by category)
│   └── /resources/<slug>/      52-post plan; 6 live at launch
├── /faq/                       Site-wide FAQs (schema-marked)
├── /contact/                   Form + calendar embed + direct contact
├── /free-review/               Lead magnet landing: free 20-point books review
├── /privacy/  /terms/          Legal
└── /portal/  → portal.balancebridge.us   Client portal (separate app)
```

## Client portal (portal.balancebridge.us)

```
/login  /forgot-password  /accept-invite
/dashboard        Snapshot: open tasks, unread messages, recent files, next deadline
/documents        Upload + browse (folders per year/category), e-sign status
/messages         Secure threads with the firm
/tasks            Checklists (onboarding, month-end, year-end)
/billing          Invoice & payment history (Stripe), pay now links
/signatures       Pending / completed e-sign requests (DocuSeal embeds)
/settings         Profile, password, MFA, notification prefs
/admin/*          Staff-only: clients, requests, templates, audit log
```

## Global elements

- **Header:** logo · Services ▾ · Industries ▾ · Pricing · Resources · About · Contact · [Client Portal] (ghost) · **[Book a free consultation]** (primary, persistent)
- **Sticky mobile CTA bar:** appears after 60% scroll — "Book a free consultation" + phone icon.
- **Footer:** 4 columns (Services, Company, Resources, Contact + service-area cities), certifications strip, legal links, sitemap link.
- **Lead magnet:** "The Texas Small Business Financial Health Checklist" (PDF) — exit/inline capture on blog + home.

## Primary user journeys

1. **Owner researching cost** → Google → pricing blog post → /pricing/ → quote form → booked call. (BOFU content → transparent tiers → low-friction form.)
2. **Messy-books owner** → "quickbooks cleanup" search → service page → free review lead magnet → consult.
3. **Referral checking credibility** → Home → About/testimonials → Contact.
4. **Existing client** → header portal link → login → upload docs / pay invoice.

## Conversion architecture

- Primary CTA everywhere: **Book a free consultation** (calendar-backed).
- Secondary: **Get a quote** (pricing) and **Free books review** (lead magnet).
- Trust signals: testimonial band (marked illustrative until real), case-study cards with concrete numbers, certification logos, "reply within 1 business day" promise, security note on portal (encryption, MFA).
- Every service page ends: related industries + pricing link + consult CTA. Every blog post ends: relevant service link + consult CTA.
