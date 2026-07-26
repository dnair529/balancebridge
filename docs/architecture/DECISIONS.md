# Recommended Decisions

Balance Bridge Financial · v1.0 · July 2026
Recommendations on the nine open questions, with reasoning. Override anything — but these are what I'd build if it were my firm.

---

## 1. Signup: self-serve, but rename it "Start your free books review"

**Recommendation: self-serve, creating a `pending` account. Not invite-only.**

The instinct toward invite-only is about controlling quality. But your constraint as a new firm is deal *flow*, not deal quality, and an invite wall loses the owner who decides at 11pm that they're done doing this themselves.

The real objection to self-serve is that it contradicts your positioning — the site says every engagement is quoted after a free review. So don't call it signup. **Call it what it actually is: "Start your free books review."** Identical form, but now it *is* the review intake rather than a competing path around it.

That reframing does three things at once. It captures intent at any hour. It arrives with the qualification data — months behind, volume, current software, revenue band — that makes your consultation dramatically better than a cold call. And it opens the SMS channel on day one.

The account stays `pending` until you review, price and assign. You keep total pricing control; you just stop losing the 11pm decision.

---

## 2. Payment: on file at signature, first charge at assignment

**Recommendation: payment method captured with the engagement letter, before assignment. First monthly charge on assignment day. Cleanup and catch-up projects 50% at signature, 50% at delivery.**

The rule underneath: **never let cost begin before payment is secured.** Your cost starts the moment a bookkeeper is assigned and starts setup — so that's the line, not the first close.

Catch-up work is split because it's front-loaded labour with no recurring revenue yet attached. Half upfront is standard and filters out tyre-kickers.

One material detail: **default to ACH, offer card.** Stripe ACH is roughly 0.8% capped at $5; cards are 2.9% + 30¢. On an $795/month engagement that's about $5 versus $23 — over $200 a year per client, on every client, forever. Make ACH the pre-selected option and card the alternative.

Secondary benefit: with payment on file, an overdue invoice becomes genuinely rare, which makes it a *meaningful* red signal instead of background noise.

---

## 3. Fees: yes, the assigned bookkeeper sees them

**Recommendation: the assigned bookkeeper sees that client's fee and the effort-vs-fee ratio. They never see firm-wide revenue, other clients' fees, or margin.**

The case for hiding fees is fee envy. The case for showing them is that without the fee, a bookkeeper cannot judge scope — and every "the client asked for something extra" question escalates to you. You become the bottleneck on your own growth.

More importantly, effort-vs-fee is a headline metric in the oversight design. If the person generating the effort can't see the ratio, only you can spot a bad engagement, and you'll spot it months late. Showing it turns them into a partner in profitability: *"we're running 3× the fee on Ramirez, can we talk about repricing"* is a conversation you want, six months earlier than you'd otherwise get it.

Scope-limit it hard, though. One client's economics, not the firm's.

*Caveat:* if you pay hourly, seeing a large fee can breed resentment. Defuse it by being open about what the fee actually covers — software, review time, insurance, admin, the free consultation that won them.

---

## 4. Staffing: primary + named backup on every client, reviewer on higher tiers

**Recommendation: every client gets a primary and a named backup from day one. A reviewer is added on Growth and Controller+, and on any client in red.**

A single bookkeeper per client is a single point of failure. Illness, holiday, resignation — the client is stranded and nobody has context. But a full team on a $395/month engagement is overhead you can't carry.

The backup costs nothing until used. Access is pre-provisioned and they receive the client context brief, so coverage is instant rather than a scramble. It's also what makes it possible for a bookkeeper to actually take a holiday, which matters more for retention than most perks.

**The client only ever sees the primary.** One name, one face, one relationship. Internal structure should be invisible to them — surfacing it just makes a small firm look bureaucratic.

Reviewer on the higher tiers gives you a real quality gate where the fee supports it, and turns reviewer-rejection-rate into a genuine quality metric rather than a theoretical one.

---

## 5. Client self-invites: yes, into two constrained roles

**Recommendation: the client owner can invite colleagues, into "Contributor" or "Full access", with the firm notified and able to revoke.**

The office manager who uploads the invoices is exactly the person you need in the system. Routing that through you is friction on the one metric that matters most — documents arriving without anyone asking.

- **Contributor** — can capture and upload, answer questions about items they submitted. Cannot see reports, insights, or billing. This is the receipts-and-invoices role, and it's the common case.
- **Full access** — everything the owner sees except inviting others and billing.

Only the designated owner may invite. Invites expire in 7 days and require email verification. Your admin sees every client user and can revoke any of them. That gives the client the speed they need and you the duty-of-care control you need.

---

## 6. Scorecards: bookkeepers see their own in full; team median, never a leaderboard

**Recommendation: full visibility of their own scorecard, with the same difficulty adjustment you see. They see the team *median* as a benchmark, never each other's individual numbers.**

Hidden metrics that affect someone's job are corrosive. People know they're being measured and reliably imagine something worse than the truth. Visible metrics drive self-correction with no management intervention — which is the whole point when one person is running 40 clients.

The median rather than a leaderboard is deliberate. *"You're at 92% on-time, team median is 88%"* is motivating and fair. Named rankings create competition in a team of three or four people who need to cover for each other — you'd be trading collaboration for a scoreboard.

And they should see their numbers **before** you raise them in any conversation. No surprises in a performance discussion is basic dignity, and it makes the conversation about problem-solving instead of defence.

---

## 7. SLAs: publish loose, manage tight

**Recommendation: internal targets deliberately tighter than public promises.**

| | Public promise | Internal alert |
|---|---|---|
| Close — Essentials | 15th business day | Day 12 |
| Close — Growth | 10th | Day 8 |
| Close — Controller+ | 8th | Day 6 |
| Message reply | 1 business day | 4 business hours |
| Client question outstanding | — | nudge 3d · escalate 7d · yellow 14d |
| Document request outstanding | — | yellow 14d · red 30d |

The close dates already appear on your pricing page, so they're a promise you've made — use them as-is.

The principle: **never set the internal target equal to the public promise.** If you alert at the moment you've already broken your word, every alert is a failure notice. Alert at 80% of the way and the gap is your recovery margin.

---

## 8. Alerts: nothing wakes anyone for bookkeeping

**Recommendation: quiet hours 7pm–7am CT and all weekend. Everything queues to 8am CT the next business day. Two exceptions.**

Bookkeeping has no 2am emergency. Nothing in a red client status can be fixed at 2am, and waking someone for something unactionable is the fastest way to teach a team to ignore alerts entirely — at which point the alert system is worse than none.

The two genuine exceptions aren't bookkeeping alerts at all, they're security alerts:
- A security event — burst of failed logins, session from an unexpected country, a permission or role change
- A fraud or payment signal on the firm's own Stripe account

Those justify interruption because they're time-sensitive and actionable. Red clients and missed closes go in the 8am digest.

---

## 9. Client-facing health: show the books score, hide the engagement grade

**Recommendation: books health yes, in full. Engagement RAG no — but surface the underlying facts without the judgment.**

**Books health (the 20-point score) should be prominent.** It's about their business, they can act on it, and watching it climb from 12 to 19 makes your value visible in a way a P&L never will. It's the single best retention artefact you have.

**Engagement health should never be client-facing.** Telling a client they're "yellow because you're slow to respond" is passive-aggressive and corrodes a relationship you need to keep warm.

But don't hide the substance — hide the *grade*. Instead of a colour, the client sees *"3 things need you"* and *"2 documents have been outstanding 18 days."* Identical information, fully actionable, no scolding. **The RAG is a management instrument; the specifics are the client experience.**

---

## 10. One thing you didn't ask, and should decide now

**Do not tie these metrics to compensation in year one.**

The moment a number determines pay, people optimise the number instead of the outcome. On-time close rate becomes closes marked delivered while incomplete. Throughput becomes rubber-stamped AI suggestions. You'd be destroying the quality signal precisely as you start depending on it.

Use year one for coaching, capacity planning and repricing decisions. Once you've watched the data for a few quarters and trust that it reflects reality, consider a modest bonus on **outcome** metrics only — on-time close and quality — never on throughput or hours.

Two related things worth settling early:

**Offboarding and data export.** Clients own their data. Build a one-click export (documents, transactions, reports) from day one. It costs little, it's the right thing, and being visibly unafraid of a client leaving is itself a trust signal.

**Bookkeeper offboarding.** When someone leaves, assignments end and access stops immediately, the backup steps up, and clients are told by *you*, not by silence. The assignment model already makes this a single action — make sure it's a documented runbook, not an improvisation.
