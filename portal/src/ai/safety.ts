/**
 * The tax/legal advice tripwire.
 *
 * Balance Bridge is a bookkeeping firm, not a CPA firm. "What did I spend on
 * fuel" is our question. "Can I deduct this" is not — that is a licensure and
 * liability line, not a style preference (CLIENT-PLATFORM-STRATEGY.md §3,
 * STAFF-WORKSPACE.md §10.7).
 *
 * Defence in depth: the system prompt tells the model to refuse, and this
 * module refuses *before* the model is ever called, so a jailbroken or
 * misbehaving provider cannot produce advice we then have to catch on the way
 * out. Detection is deliberately eager — a false positive costs one bookkeeper
 * ten seconds; a false negative costs the firm its licence exposure.
 */

export type AdviceCategory = 'tax' | 'legal' | 'investment';

export interface AdviceCheck {
  readonly triggered: boolean;
  readonly category: AdviceCategory | null;
  /** The phrase that tripped the check, for the audit trail. */
  readonly matched: string | null;
  readonly reason: string;
}

const CLEAR: AdviceCheck = {
  triggered: false,
  category: null,
  matched: null,
  reason: 'No tax, legal, or investment advice request detected.',
};

interface Rule {
  readonly category: AdviceCategory;
  readonly pattern: RegExp;
  readonly reason: string;
}

/**
 * Each pattern targets a *request for a recommendation or a determination*,
 * not a mere mention of the topic. "Send the tax folder to my CPA" must pass;
 * "should I elect S-corp" must not.
 */
const RULES: readonly Rule[] = [
  {
    category: 'tax',
    pattern:
      /\b(can|could|should|may|am i able to|is it ok to|do i get to)\s+(i|we|my (business|company|llc)|the (business|company|llc))\s+(deduct|write[- ]off|write off|expense|depreciate|amortize|amortise|claim)\b/i,
    reason: 'Asks whether something is deductible — a determination only a CPA may make.',
  },
  {
    category: 'tax',
    pattern: /\b(is|are|was|were)\s+(this|that|these|those|it|the \w+)\s+(tax[- ]?)?(deductible|writeoff|write[- ]off)\b/i,
    reason: 'Asks for a deductibility determination.',
  },
  {
    category: 'tax',
    pattern:
      /\b(how much (tax|taxes) (will|do|would|should) (i|we)|what (will|do|would) (i|we) owe|how much (will|do|would) (i|we) owe|tax liability|estimated (tax|taxes) payment|quarterly (tax|taxes))\b/i,
    reason: 'Asks us to estimate a tax liability or payment.',
  },
  {
    category: 'tax',
    pattern:
      /\b(s[- ]?corp|c[- ]?corp|llc|sole prop\w*|partnership)\s+(election|status|conversion)\b|\b(should|can|would) (i|we) (elect|convert to|switch to|form|set up)\s+(an?\s+)?(s[- ]?corp|c[- ]?corp|llc|partnership|trust)\b/i,
    reason: 'Asks about entity structure or election — CPA/attorney territory.',
  },
  {
    category: 'tax',
    pattern:
      /\b(section 179|bonus depreciation|augusta rule|qbi|199a|1031 exchange|de minimis safe harbor|home office deduction|mileage (rate|deduction)|depreciation (method|schedule) (should|to use))\b/i,
    reason: 'Asks about a specific tax treatment or election.',
  },
  {
    category: 'tax',
    pattern:
      /\b(how (do|should) (i|we) (file|report)|do (i|we) (need to|have to) file|when (do|should) (i|we) file|which form|what form (do|should))\b.{0,40}\b(1099|w-?2|w-?9|941|940|1040|1120|1065|schedule c|franchise tax|sales tax|return)\b/i,
    reason: 'Asks how or whether to file — we do not prepare or file returns.',
  },
  {
    category: 'tax',
    pattern: /\b(tax|taxes)\s+(advice|strategy|planning|guidance|recommendation)\b|\b(advise|advice) (me|us) on\b.{0,30}\b(tax|taxes)\b/i,
    reason: 'Explicitly asks for tax advice, strategy, or planning.',
  },
  {
    category: 'tax',
    pattern: /\b(minimi[sz]e|reduce|lower|avoid|save on|shelter)\s+(my |our |the )?(tax|taxes|tax bill|taxable income)\b/i,
    reason: 'Asks how to reduce a tax burden — tax planning.',
  },
  {
    category: 'legal',
    pattern:
      /\b(is (this|that|it) legal|am i liable|are we liable|liability for|breach of contract|sue|lawsuit|legal advice|do i need a lawyer|is (this|that) enforceable|terminate the (contract|agreement)|non[- ]?compete)\b/i,
    reason: 'Asks a legal question — route to an attorney.',
  },
  {
    category: 'legal',
    pattern: /\b(1099|w-?2)\b.{0,30}\b(vs\.?|or|versus)\b.{0,20}\b(w-?2|1099|employee|contractor)\b|\bclassify (him|her|them|the worker|this person) as\b/i,
    reason: 'Asks about worker classification — a legal and tax determination.',
  },
  {
    category: 'investment',
    pattern:
      /\b(should (i|we) (invest|buy|lease|finance|take (out )?(a )?loan|borrow)|good investment|worth (buying|financing)|which (loan|lender|investment))\b/i,
    reason: 'Asks for an investment or financing recommendation.',
  },
];

/**
 * Scan text for a request that would put us over the advice line.
 * Runs on the *inbound* client message, before any provider call.
 */
export function checkForAdviceRequest(text: string | null | undefined): AdviceCheck {
  if (!text) return CLEAR;
  for (const rule of RULES) {
    const m = rule.pattern.exec(text);
    if (m) {
      return {
        triggered: true,
        category: rule.category,
        matched: m[0].slice(0, 120),
        reason: rule.reason,
      };
    }
  }
  return CLEAR;
}

/**
 * Outbound scan. Catches a model that answered an advice question anyway —
 * belt and braces on top of {@link checkForAdviceRequest}.
 */
const OUTBOUND_ADVICE = [
  /\byou (should|ought to|can|could) (deduct|write it off|expense|elect|file|claim)\b/i,
  /\b(this|that|it) (is|will be) (tax[- ]?)?deductible\b/i,
  /\byou'?ll owe (roughly|about|approximately|around)?\s*\$?[\d,]/i,
  /\bi (recommend|suggest|advise) (you |that you )?(elect|file|deduct|convert|restructure|form an?)\b/i,
  /\bfor tax purposes,? you (should|can|must)\b/i,
];

export function containsAdviceOutput(text: string): AdviceCheck {
  for (const pattern of OUTBOUND_ADVICE) {
    const m = pattern.exec(text);
    if (m) {
      return {
        triggered: true,
        category: 'tax',
        matched: m[0].slice(0, 120),
        reason: 'Draft contained a tax/legal recommendation and was suppressed before review.',
      };
    }
  }
  return CLEAR;
}
