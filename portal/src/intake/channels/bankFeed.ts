/**
 * Bank / card feed — channel #4 (OMNICHANNEL-CAPTURE.md §2: "Transactions
 * arrive automatically; kills statement-chasing entirely. The anchor everything
 * matches against").
 *
 * STUB, and a deliberately shaped one. A bank feed is *data, not documents* —
 * it produces `transactions` rows, which are the things receipts get matched
 * *to*. So it satisfies the adapter contract (it is a front door, it carries
 * provenance, it dedupes at the door) but its intake items are payload-only:
 * no attachment, no extraction, no confirmation message. A client does not
 * want a text every time their card feed syncs.
 *
 * TODO(bank-feed), in this order:
 *   1. Plaid Link → `item_id` / `access_token`, sealed with `lib/crypto`,
 *      recorded against `integrations` (provider `plaid`), one row per client.
 *   2. `verifySignature`: Plaid signs webhooks with a JWT in the
 *      `Plaid-Verification` header (ES256; fetch + cache the key by `kid` from
 *      `/webhook_verification_key/get`, and compare the body's SHA-256 against
 *      the JWT's `request_body_sha256`). QBO uses an HMAC-SHA256
 *      `intuit-signature` header over the raw body.
 *   3. On `SYNC_UPDATES_AVAILABLE`, call `/transactions/sync` with the stored
 *      cursor and upsert into `transactions` keyed on
 *      `(account_id, external_id)` — the unique index already exists.
 *   4. Map institution accounts to `accounts`, storing the **mask only**. The
 *      schema comment is load-bearing: never store a full account number.
 *   5. Feed new transactions into `services/documentRequests.ts` so a charge
 *      that needs a receipt starts chasing itself.
 */

import {
  ChannelNotConfiguredError,
  parseJson,
  type ChannelAdapter,
  type InboundMessage,
  type SendResult,
  type WebhookRequest,
} from './types.js';
import { intakeConfig } from '../config.js';

interface FeedWebhook {
  webhook_type?: string;
  webhook_code?: string;
  item_id?: string;
  /** Present on QBO-style notifications. */
  realmId?: string;
  new_transactions?: number;
}

export class BankFeedAdapter implements ChannelAdapter {
  readonly channel = 'bank_feed' as const;

  /** Always false until step 1 of the TODO above lands. */
  get configured(): boolean {
    return intakeConfig.bankFeed.configured;
  }

  parseWebhook(req: WebhookRequest): InboundMessage | null {
    const p = parseJson<FeedWebhook>(req.rawBody);
    const identity = p?.item_id ?? p?.realmId;
    if (!p || !identity) return null;

    return {
      channel: this.channel,
      // A feed notification has no message id; the item + code + arrival window
      // is the best stable key available until the sync cursor is implemented.
      externalId: `${identity}:${p.webhook_code ?? 'unknown'}:${new Date().toISOString().slice(0, 13)}`,
      senderIdentity: identity,
      receivedAt: new Date(),
      text: null,
      attachments: [],
      raw: p,
    };
  }

  async send(_to: string, _body: string): Promise<SendResult> {
    throw new ChannelNotConfiguredError(
      this.channel,
      'BANK_FEED_PROVIDER — a feed is inbound-only; there is nothing to send',
    );
  }
}

export const bankFeedAdapter = new BankFeedAdapter();
