# Oversight: Client Health, Bookkeeper Performance & Alerts

Balance Bridge Financial · Design proposal v1.0 · July 2026
**Status: awaiting approval. Nothing built yet.**

---

## 1. The trap to avoid first

Measuring logins and hours is easy to build and easy to get wrong. Track them as a productivity score and you get three predictable outcomes: people pad their time, they stay logged in doing nothing, and your best bookkeeper — the fast one — looks worst. Surveillance metrics also drive away exactly the senior people you most want to keep.

So the design principle here is:

> **Measure outcomes. Use activity for capacity and wellbeing, never as a score.**

Hours and logins are still worth capturing — they tell you who is drowning, who is disengaged, and whether you can take another client. They just don't belong in a performance ranking. Everything below is built on that split.

And one more, which matters more than any metric:

> **Every status must name its reason and say who is blocked.**

A client can go red because *we* are behind, or because *they* won't send statements. If those look identical on a dashboard, the number is worse than useless — it punishes a bookkeeper for a client's behavior, and they will learn to game it or resent it. So every health signal carries `blocked_by: firm | client | external`.

---

## 2. Client health — a RAG status that explains itself

Six dimensions, each independently scored, rolled into one status. Thresholds are explicit and configurable — never a vibe.

| # | Dimension | Green | Yellow | Red |
|---|---|---|---|---|
| 1 | **Close timeliness** | Delivered on or before target | 1–5 days late | >5 days late, or a period skipped |
| 2 | **Client responsiveness** | No request older than 7 days | Something outstanding 14–30 days | >30 days, or silent >21 days |
| 3 | **Books condition** | All accounts reconciled, <5 stale uncategorized | 1 account behind, or 5–25 stale | >1 period unreconciled, or >25 stale |
| 4 | **Risk signals** | No unresolved anomalies | Unresolved medium anomaly | Unresolved high anomaly (duplicate payment, missing deposit) |
| 5 | **Relationship** | Messages answered within SLA | An SLA breach, or a complaint | Escalation raised, or churn signal |
| 6 | **Commercial** | Invoices current, effort within fee | Invoice 1–30 days overdue, or effort 1.5× fee | Invoice >30 days overdue, or effort >2× fee |

**Overall status = the worst dimension.** One red makes the client red. Averaging hides exactly the thing you need to see.

Every status carries, at all times:
- **The reason, in words** — *"Yellow: the March close is 3 days past target and two bank statements are outstanding."*
- **`blocked_by`** — firm, client, or external
- **A trend arrow** — improving, stable, or degrading over the last 30 days
- **Time in current status** — a client sitting in yellow for six weeks is a different problem from one that turned yellow yesterday

---

## 3. Bookkeeper performance — outcomes first

### Tier 1 — Outcomes (this is the scorecard)
- **On-time close rate** — closes delivered by target ÷ closes due
- **Quality: pre-flight pass rate** on first attempt
- **Quality: reviewer rejection rate** and post-delivery corrections
- **Portfolio health** — distribution of their clients across RAG, **counting only firm-blocked reds**
- **Client responsiveness achieved** — how fast *their* clients answer, which measures how well they run the relationship
- **Message response time** — median time to first reply, and SLA breaches

### Tier 2 — Throughput (context, not ranking)
- Minutes per 100 transactions categorized
- Work items cleared per active day
- **Rule leverage** — share of their categorizations resolved by rules with no model call. Rising over time means they're teaching the system, which is the compounding asset.
- AI suggestion accept vs. override rate. **Both directions are signal**: near-100% acceptance may mean rubber-stamping; near-zero may mean the model is badly tuned for that client.

### Tier 3 — Capacity and wellbeing (never a score)
- Active clients carried
- **Hours per client**, derived automatically from queue activity — not a manual timer, not a stopwatch
- **Login pattern** — sessions, active days, and specifically *out-of-hours and weekend work*, which is a burnout signal to act on, not a diligence badge to reward
- Effort vs. fee per client — tells you which engagements to reprice, not who to blame

### Fairness adjustment — non-negotiable
Raw comparison is dishonest: three messy catch-up clients will always look worse than three clean ones. So every scorecard shows **difficulty-adjusted** figures, using transaction volume, account count, months of backlog and industry complexity — and always displays the firm-blocked vs. client-blocked split alongside.

---

## 4. Alerts

**Triggered on transition, not on state.** Alerting on "is red" fires forever; alerting on "turned red" fires once and demands a decision.

| Event | Who is told | How |
|---|---|---|
| Green → Yellow | Assigned bookkeeper, plus admin in the daily digest | Digest |
| Yellow → Red | Bookkeeper **and** admin | Immediate |
| Any → Green (recovery) | Both | Digest — recoveries deserve visibility too |
| Red for >7 days | Admin | Immediate, escalating |
| Close target missed | Bookkeeper + admin | Immediate |
| Client silent >21 days | Bookkeeper + admin | Immediate |
| Invoice >30 days overdue | Admin only | Digest |
| Bookkeeper >2× normal weekend hours | Admin only | Weekly, framed as wellbeing |
| Quarantined intake >48h | Bookkeeper | Digest |

**Alert fatigue is the failure mode.** Defaults: digest daily at 8am CT, immediate only for red transitions and missed closes. Every alert is acknowledgeable, has an owner, and — where sensible — a one-click action ("nudge client", "reassign", "snooze with reason"). An alert nobody can act on shouldn't exist.

---

## 5. The three admin screens

**Portfolio board** — every client as a row: RAG chip with reason, trend arrow, time in status, assigned bookkeeper, days to close, `blocked_by`, effort vs fee. Filter by status, bookkeeper, industry. This is your morning screen.

**Bookkeeper scorecard** — per person, per period: the Tier 1 outcomes prominently, Tier 2 as context, Tier 3 in a separate clearly-labelled capacity section. Portfolio breakdown, trend over six months, difficulty-adjusted comparison against the team median.

**Client scorecard** — per client: the six dimensions over time, status history with reasons, who was assigned when, effort and fee, books health checklist, open items. This is what you read before a client call or a pricing conversation.

Plus an **alert inbox** with acknowledge and resolve, and a full history — because "who knew what, when" is the whole point of oversight.

---

## 6. What has to be built

**Schema**
- `client_status_history` — client_id, status, previous_status, dimension_scores jsonb, reasons jsonb, blocked_by, computed_at
- `alerts` — kind, severity, client_id, user_id, title, detail, action_url, status (open/acknowledged/resolved), acknowledged_by/at, resolved_by/at
- `alert_preferences` — per user and kind: immediate / digest / off
- `staff_metrics_daily` — user_id, date, pre-aggregated rollups so reports stay fast at scale
- `health_thresholds` — configurable per dimension, so you tune without a deploy

Login and session data needs **no new table** — `sessions` already records created_at, ip and user_agent. Hours come from the existing `time_entries` with its `automatic` flag.

**Services**
- `clientHealth.ts` — score six dimensions, resolve overall, produce reasons and `blocked_by`
- `statusTransitions.ts` — detect changes, write history, raise alerts
- `staffMetrics.ts` — nightly rollup with the difficulty adjustment
- `alerts.ts` — routing, digest batching, acknowledgment
- A scheduled job (nightly, plus on-demand recompute)

**Screens** — portfolio board, bookkeeper scorecard, client scorecard, alert inbox, threshold settings.

---

## 7. Questions this raises

1. **Do bookkeepers see their own scorecard?** I'd argue strongly yes — hidden metrics breed distrust, and self-visible metrics drive self-correction. But whether they see *each other's* is a culture decision.
2. **What are your actual SLA numbers?** The table above assumes close by the 10th and message replies within 1 business day. Confirm or change.
3. **Who receives immediate alerts at 2am** — nobody until 8am, or is red genuinely wake-someone-up?
4. **Should client health be visible to the client?** Their books health already is. Engagement health (are they responsive, are they paying) probably should not be.
