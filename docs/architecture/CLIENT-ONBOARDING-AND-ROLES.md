# Client Signup, Assignment & Role Model

Balance Bridge Financial · Design proposal v1.0 · July 2026
**Status: awaiting approval. Nothing built yet.**

---

## 1. The governing idea

**Assignment is the access control.** A bookkeeper sees no client data at all until an admin assigns them to that client. This is stronger and simpler than a permission matrix: there is exactly one question to answer — *is there an active assignment?* — and it is auditable, reversible, and obvious to everyone.

Three consequences follow:
- A bookkeeper's world is "my assigned clients," never "all clients."
- Only an admin creates bookkeeper accounts and makes assignments.
- The moment of assignment is also the moment the client learns who their bookkeeper is. One event, both sides.

---

## 2. Signup is not one form

The instinct is a single long registration page. That kills conversion and produces garbage data, because an owner filling in their EIN at 11pm on a phone will abandon halfway.

Split it into four stages, each with a different job:

```
 PUBLIC            PROSPECT              ADMIN                  ACTIVE
 ─────────         ─────────             ─────────              ─────────
 Sign up     →     Onboarding      →     Review, price,   →     Bookkeeper
 (60 sec)          wizard                assign                 sets up;
                   (resumable)           bookkeeper             client works
```

Nothing sensitive is asked before the client has a reason to trust us with it.

---

## 3. Stage 1 — Signup page (~60 seconds)

The entire goal is to create an account and open a capture channel. Nine fields, one screen.

| Field | Why it earns its place |
|---|---|
| Business name | Identity |
| Your name | Who we're talking to |
| Work email | Becomes the login |
| **Mobile number** | This is the SMS capture channel — the single most valuable field on the page |
| Password | Account |
| Industry | Drives the chart of accounts and the checklist we generate |
| Books status: *current / behind / never kept* | Instantly qualifies the engagement and sets expectations |
| Approx. monthly transactions (band) | Drives the price band |
| How did you hear about us | Attribution (optional) |

Plus three **separate, unticked** consents — never bundled:
- Terms of service and privacy policy
- **SMS consent** (TCPA requires explicit, documented opt-in; stored with a timestamp on the channel identity)
- Marketing email (optional, genuinely optional)

**What this creates:** a `pending` client and a client user who can log in, complete onboarding, and upload documents — but **cannot message a bookkeeper**, because none is assigned yet. Pending state is what prevents self-serve signup from becoming a spam and fraud surface.

---

## 4. Stage 2 — Onboarding wizard (progressive, saveable, resumable)

Seven short sections with a progress bar. Every section saves independently; they can stop and come back. Sections A–C unlock a real quote, so the wizard tells them that.

**A · Business profile**
Legal entity name and DBA · entity type (sole prop / LLC / S-corp / C-corp / partnership) · **EIN** (encrypted at rest) · formation state and date · Texas taxpayer number if applicable · physical and mailing address · website · fiscal year end.

**B · The engagement**
Which services they want (mapped to your ten) · how far behind the books are, in months · current software (QuickBooks Online/Desktop, Xero, spreadsheets, nothing) · annual revenue band · employees and contractor counts · payroll — do they run it, and who with · sales tax — do they collect it, and at what filing frequency · **their CPA's name and email** (we coordinate, they file) · prior bookkeeper, for transition.

**C · Financial accounts** — what we will reconcile
For each: institution, nickname, type, **last four digits only**, and whether it's active.
Bank accounts · credit cards · loans · merchant and POS (Square, Stripe, Shopify, Toast) · payroll provider.

> **Hard rule: we never ask for full account numbers or online banking passwords.** Last four is enough to reconcile and label. Real data access comes later through Plaid or a read-only accountant invite — both revocable, neither requiring the client to hand over credentials. This is stated on the page, because saying it out loud is a trust signal.

**D · People and access**
Others at their company who need the portal, with a role each (owner / manager / view-only), and who is authorized to sign.

**E · Communication preferences**
Preferred channel · best hours · any additional capture numbers (a field manager's phone, say), each with its own consent · whether they want the monthly summary by email or portal only.

**F · Documents** — a checklist, each item capturable from the phone
Prior year tax return · last three bank statements per account · chart of accounts export · formation documents and EIN letter · W-9s for contractors · voided check or bank letter (optional) · QuickBooks accountant invite.

**G · Agreement**
Review the proposed plan and price · **e-sign the engagement letter** (DocuSeal, already built) · payment method via Stripe-hosted checkout, so no card data ever reaches us.

### What we deliberately never collect
Full bank or card numbers · online banking credentials · SSNs (unless a specific filing requires one, and then encrypted with a written justification) · anything we cannot articulate a use for. Every extra field is a liability, not an asset.

---

## 5. Stage 3 — Admin review and assignment

A **Pending clients** queue for the admin. For each:

1. Read the submitted profile and the auto-generated complexity assessment (volume, accounts, months behind, services).
2. Set the plan and price — the wizard's answers produce a suggested tier, admin confirms or overrides.
3. **Assign a bookkeeper** (and optionally a reviewer for the close).
4. Set the monthly close target date — this is the SLA the work queue measures against.
5. Activate.

Only an admin can do any of this. Only an admin can create a bookkeeper account at all.

---

## 6. Stage 4 — Assignment fires everything

The moment of assignment is a single event with effects on both sides:

**For the bookkeeper**
- The client appears in their world for the first time — queue, documents, messages, close.
- A setup checklist is generated: connect accounts, build the chart of accounts, import history, reconcile opening balances, set the close calendar.
- The client's onboarding gaps become document requests automatically.

**For the client — this is the relationship moment, so make it good**
- *"Meet Sam Reyes, your bookkeeper"* — real photo, direct email, direct phone, working hours, response promise.
- A message thread opens **already containing a hello from their bookkeeper**, so the channel is never an empty box.
- Their SMS capture number activates, with a confirming text: *"You're set up — text a receipt photo to this number any time."*
- Their "what we need from you" list populates.
- A short "how this works" card: how to send us things, when your books close, how to reach a human.

**Handoff and offboarding.** Reassignment is the same mechanism in reverse: the old assignment ends (access stops immediately), the new one begins, and the client is told. Nothing to clean up by hand, and the audit log shows exactly who could see what, when.

---

## 7. The communication gateway

Built on the existing threads/messages tables, with additions:

- **Auto-created thread on assignment**, so there is never a blank inbox.
- **Client sees only their assigned bookkeeper** (plus the firm for billing/admin matters). They never see staff structure.
- **Notifications leak nothing.** The email or text says *"You have a new message from Sam at Balance Bridge"* and links to the portal. Amounts, vendors and balances stay behind the login. This matters — email is not a secure channel and a phone on a truck seat is not a private device.
- **Attachments flow into the intake pipeline**, so a receipt sent in a message is filed exactly like one texted in.
- **Response SLA is visible** to both sides; overdue threads raise a work item.
- **Escalation to admin** available to the bookkeeper, and a "something's wrong" path for the client that reaches the owner rather than dead-ending.

---

## 8. Capabilities by role

### Admin / Owner — the only role that can create people
- Create, disable and reset **bookkeeper accounts** (exclusive)
- Approve pending signups; set plan and price
- **Assign and reassign clients to bookkeepers** (exclusive)
- All clients, always
- Integrations and credentials · billing and revenue · firm-wide capacity and per-client profitability
- Audit log · retention · rules oversight · AI usage and safety metrics

### Bookkeeper / Staff — assigned clients only
- Work queue, filtered to their assignments
- For assigned clients: documents, messages, tasks, transactions, categorization, rules, reconciliation, close, anomalies, client brief
- Firm memory (precedents), their own capacity
- **Cannot:** create or modify any user · see or search unassigned clients · touch integrations or credentials · see firm-wide revenue or profitability · read the audit log · change pricing

### Client — their own business only
- Capture from any channel · answer questions · see what's needed
- Documents, secure messages with their bookkeeper, e-signature
- Insights: approved close narrative, shared anomalies, books health, compliance calendar
- Billing and payment history
- Invite colleagues at their own company (owner-level client users only)

---

## 9. What has to be built

**Schema**
- `client_assignments` — client_id, user_id, role (owner/reviewer/backup), assigned_by, assigned_at, ended_at
- `client_onboarding` — section-by-section progress + submitted answers (jsonb), resumable
- `client_financial_accounts` — institution, nickname, type, last4, status *(no full numbers, ever)*
- `client_contacts` — the client's own people and their access level
- Extend `clients` with status (`pending` / `active` / `paused` / `offboarded`), entity fields, encrypted EIN, plan, close target day

**Access layer** — the important one
A single scoping helper every staff query passes through: admin sees all, staff sees only actively-assigned clients. Enforced in one place, not sprinkled across routes, and backed by the row-level security policies already written.

**Screens**
Public signup · onboarding wizard (7 sections, resumable) · admin pending queue · admin assign/reassign · admin bookkeeper account management · client "meet your bookkeeper" · bookkeeper setup checklist.

**Flows**
Signup → pending · onboarding completion → quote → engagement letter e-sign → payment · assignment → dual notification + auto thread + document requests · reassignment/offboarding.

---

## 10. Open questions for Deepak

1. **Self-serve or invite-only?** Should anyone be able to sign up and land in the pending queue, or should signup be reachable only by a link you send after a consultation? Self-serve captures more; invite-only keeps the queue clean.
2. **Payment before or after assignment?** Card on file at signature, or first invoice after the first close?
3. **Can a bookkeeper see a client's revenue and fee?** They need volume to do the work; whether they see what the client pays is a firm culture decision.
4. **One bookkeeper per client, or a team?** The schema supports owner + reviewer + backup; how do you want to actually run it?
5. **Should clients be able to invite their own colleagues** without firm approval?
