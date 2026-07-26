# Omnichannel Capture Architecture

Balance Bridge Financial · v1.0 · July 2026

**The principle: many front doors, one hallway.** Every channel a client can reach us through drops into a single normalized intake queue. Everything downstream — extraction, matching, filing, the audit trail — is written once and is channel-agnostic. Adding WhatsApp in year two must not require touching the pipeline.

---

## 1. The pipeline every channel feeds

```
  SMS/MMS ┐
 WhatsApp ┤
  PWA cam ┤
    Email ┤──▶  INTAKE QUEUE  ──▶ dedupe ──▶ extract ──▶ classify ──▶ match ──▶ file
   Portal ┤     (normalized)       (hash)     (OCR/AI)   (doc type)  (to txn)   │
Bank feed ┤                                                                     ▼
 POS/Payr ┤                                                      confident? auto-file
    Voice ┘                                                      unsure?    human queue
```

Rules that make it work:

- **The original is never mutated.** Raw file + raw payload stored immutably; every extraction is a separate record pointing at it. If AI gets it wrong, the truth is still there.
- **Idempotency at the door.** Content hash + channel message ID. A client who texts the same photo three times because they weren't sure it went through creates one document, not three.
- **Identity resolution is explicit.** A phone number, an email address, a WhatsApp ID all map to a client through a lookup table. Unrecognized sender → quarantine, never guessed.
- **Every item carries provenance.** Which channel, which sender, when, raw payload retained. This is financial data — you must be able to answer "where did this come from" a year later.
- **Confidence gates the automation.** High confidence auto-files; anything below threshold routes to a human. Never guess silently.

---

## 2. Channels — what to build, in order

| # | Channel | Why it matters | Effort | Notes |
|---|---|---|---|---|
| 1 | **SMS / MMS** | Lowest-friction capture that exists. A contractor texts a photo from the truck. No app, no login, no password. | M | Requires US **10DLC registration** (days–weeks) and **TCPA opt-in**. Start now. |
| 2 | **Mobile PWA camera** | Installable, auto-crop, multi-page, **offline queue** for job sites with no signal. No app store. | M | Sync-on-reconnect is the killer feature for trades. |
| 3 | **Email forwarding** | `receipts+acme@balancebridge.us`. Forward a bill from Gmail — zero new habits. | S | Cheapest to build, immediate value. |
| 4 | **Bank / card feeds** | Transactions arrive automatically; kills statement-chasing entirely. | M | Plaid or QBO. The anchor everything matches against. |
| 5 | **WhatsApp** | Significant among TX small-business owners, especially El Paso, San Antonio, Houston. | M | WhatsApp Business API; approval lead time. |
| 6 | **Portal drag-and-drop** | Bulk and year-end dumps. | ✅ Built | Already live. |
| 7 | **POS / payroll / commerce connectors** | Square, Toast, Shopify, Stripe, Gusto. Data, not documents. | L | Sequence by client mix. |
| 8 | **Watched cloud folder** | Google Drive / Dropbox for clients who already scan. | S | Meets existing behavior. |
| 9 | **Voice note** | Call a number, leave context: "that $4,300 was Johnson job materials." Transcribed, attached to the transaction. | M | Genuinely differentiating for drivers. |

---

## 3. The confirmation loop (do not skip this)

The reason clients abandon capture tools is silence — they send something and never learn whether it landed. Every channel replies in-channel within seconds:

> *"Got it — Home Depot, $412.83, matched to your Chase ••4021. Reply **J** if this was for a job."*

That single message does four jobs: confirms receipt, shows the extraction so errors surface immediately, closes the categorization question at the moment of context, and trains the client that the system works. It converts a filing tool into a conversation.

Two-way is the point — a client should be able to answer our open questions **by replying to a text**, not by logging in.

---

## 4. Data model additions

```
intake_items      id, client_id (nullable until resolved), channel, external_id,
                  sender_identity, received_at, raw_payload jsonb, storage_key,
                  content_hash, status, quarantine_reason
                  UNIQUE (channel, external_id), UNIQUE (client_id, content_hash)

channel_identities client_id, channel, identity (phone/email/wa_id), verified_at
                  -- how an inbound sender resolves to a client; never inferred

extractions       id, intake_item_id, model, extracted jsonb (vendor, date, amount,
                  tax, line_items), confidence, created_at
                  -- append-only; re-runs add rows, never overwrite

txn_matches       extraction_id, transaction_id, confidence, matched_by (ai|human),
                  confirmed_at

outbound_messages client_id, channel, body, sent_at, in_reply_to
                  -- the confirmation loop, auditable
```

`documents` (already built) gains `intake_item_id`. Existing portal uploads become just another channel — backfill them as `channel='portal'` so there is exactly one code path.

---

## 5. Constraints worth knowing before you commit

- **10DLC**: US A2P SMS requires brand + campaign registration. Unregistered traffic gets filtered. Start the paperwork before the build.
- **TCPA**: documented opt-in required, plus STOP handling. Capture consent at onboarding, in the engagement letter.
- **PII over SMS**: confirm amounts and vendors, never account numbers or balances. Assume the phone is unlocked on a truck seat.
- **MMS image quality** is often poor — always offer the PWA as the higher-fidelity path, and let OCR fail gracefully to a human.
- **Storage cost and retention**: images add up. Set a retention policy aligned to record-keeping rules from day one.
- **Quarantine, don't guess**: an unrecognized sender must never be auto-attached to a client. Wrong client attribution in financial records is a serious incident.

---

## 6. Build order

1. **Foundation first** — `intake_items` + extraction + matching pipeline, with the existing portal upload rewired through it. No new channel yet. This is the piece everything else plugs into.
2. **Email forwarding** — cheapest channel, proves the pipeline end to end.
3. **SMS/MMS + confirmation loop** — the step-change in client experience. Start 10DLC registration in parallel with step 1.
4. **PWA camera with offline queue** — the trades unlock.
5. **Bank feeds** — kills the largest remaining chase category.
6. **WhatsApp, voice notes, connectors** — as the client mix demands.

**Metric that proves it worked:** percentage of documents arriving without a human asking for them. Target 80%+ within two closes. Secondary: median time from expense to filed document — hours, not weeks.
