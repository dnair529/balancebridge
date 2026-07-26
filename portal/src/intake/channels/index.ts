/**
 * The channel registry — the only place that knows the full list of front
 * doors. Everything downstream takes a `Channel` and asks here.
 *
 * Adding a channel is: write the adapter, add one line below. The pipeline,
 * the confirmation loop, the routes and the audit trail are untouched.
 */

import type { Channel, ChannelAdapter, OutboundChannel } from './types.js';
import { smsAdapter } from './sms.js';
import { whatsappAdapter } from './whatsapp.js';
import { emailAdapter } from './email.js';
import { pwaAdapter } from './pwa.js';
import { portalAdapter } from './portal.js';
import { voiceAdapter } from './voice.js';
import { cloudFolderAdapter } from './cloudFolder.js';
import { bankFeedAdapter } from './bankFeed.js';

/** Exhaustive by construction: a channel without an adapter fails to compile. */
const REGISTRY: Readonly<Record<Channel, ChannelAdapter>> = {
  sms: smsAdapter,
  whatsapp: whatsappAdapter,
  email: emailAdapter,
  pwa: pwaAdapter,
  portal: portalAdapter,
  voice: voiceAdapter,
  cloud_folder: cloudFolderAdapter,
  bank_feed: bankFeedAdapter,
};

export function adapterFor(channel: Channel): ChannelAdapter {
  return REGISTRY[channel];
}

export function allAdapters(): readonly ChannelAdapter[] {
  return Object.values(REGISTRY);
}

/**
 * Where a reply to an inbound item on `channel` should go out. A voice note is
 * answered by text; a PWA capture is answered in-app.
 */
export function outboundChannelFor(channel: Channel): OutboundChannel | null {
  return REGISTRY[channel].outboundChannel ?? null;
}

/** The adapter that actually performs the send for a given inbound channel. */
export function senderFor(channel: Channel): ChannelAdapter | null {
  const out = outboundChannelFor(channel);
  if (!out) return null;
  if (out === 'push') return null;
  return REGISTRY[out];
}

/** Operational summary for the admin integrations view. */
export function channelStatuses(): readonly { channel: Channel; configured: boolean }[] {
  return allAdapters().map((a) => ({ channel: a.channel, configured: a.configured }));
}

export * from './types.js';
export { smsAdapter, whatsappAdapter, emailAdapter, pwaAdapter, portalAdapter, voiceAdapter, cloudFolderAdapter, bankFeedAdapter };
