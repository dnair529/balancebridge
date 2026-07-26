/**
 * `stub-deterministic-v1` — a local, deterministic provider.
 *
 * This is not a mock and it is not a placeholder: it is the provider that runs
 * until API keys exist, and it produces genuinely usable output. Same input,
 * same output, always — no randomness, no clock, no network.
 *
 * Its heuristics are real:
 *   - extraction   → regex/label parsing of receipt and invoice text
 *   - categorization → prior human decisions first, then a vendor keyword map,
 *                      with a hard-coded ambiguity list that deliberately
 *                      returns low confidence instead of guessing
 *   - narrative    → template driven entirely by the figures it was given
 *   - anomaly      → duplicate/price-increase/outlier/new-vendor rules
 *   - precedent    → weighted token overlap
 *   - preflight    → threshold rules over the supplied facts
 *
 * Everything it returns is still only a *suggestion*. The guardrails above it
 * (confidence gating, Suggestion<T>, ai_runs logging) are identical whichever
 * provider is selected — which is the point of testing against this one.
 */

import {
  clampConfidence,
  daysBetween,
  median,
  money,
  movement,
  normalizeVendor,
  pctChange,
} from '../format.js';
import { extractPayload } from '../request.js';
import type { AiProvider, AiRequest, AiResponse } from '../provider.js';
import { AiOutputError } from '../provider.js';
import type {
  AnomalyKind,
  AnomalyModel,
  AnomalyPayload,
  AnomalyResultModel,
  CategorizeModel,
  CategorizePayload,
  CategoryRef,
  CheckModel,
  DocType,
  ExtractModel,
  ExtractPayload,
  LineItemModel,
  NarrativeModel,
  NarrativePayload,
  PrecedentPayload,
  PrecedentResultModel,
  PreflightPayload,
  PreflightResultModel,
  ReconcileModel,
  ReconcilePayload,
  ReplyModel,
  ReplyPayload,
  Severity,
  TransactionRef,
} from '../payloads.js';
import { checkForAdviceRequest } from '../safety.js';
import { taxAdviceDeflection } from '../prompts.js';

export const STUB_PROVIDER_NAME = 'stub-deterministic-v1';
const STUB_MODEL = 'local-heuristics-v1';

export class StubProvider implements AiProvider {
  readonly name = STUB_PROVIDER_NAME;

  async complete(req: AiRequest): Promise<AiResponse> {
    const payload = extractPayload<Record<string, unknown>>(req);
    if (payload === undefined) {
      throw new AiOutputError(
        this.name,
        'Stub provider requires a request built by buildRequest() — no <payload> envelope found.',
      );
    }

    const json = dispatch(req, payload);
    const text = JSON.stringify(json, null, 2);

    return {
      text,
      json,
      // Deterministic, length-derived "usage" so cost dashboards have a shape
      // to render before real providers are wired up.
      inputTokens: Math.ceil((req.system.length + req.messages.reduce((n, m) => n + m.content.length, 0)) / 4),
      outputTokens: Math.ceil(text.length / 4),
      model: STUB_MODEL,
    };
  }
}

function dispatch(req: AiRequest, payload: Record<string, unknown>): unknown {
  switch (req.task) {
    case 'extract':
      return doExtract(payload as unknown as ExtractPayload);
    case 'categorize':
      return doCategorize(payload as unknown as CategorizePayload);
    case 'narrative':
      return doNarrative(payload as unknown as NarrativePayload);
    case 'reply_draft':
      return doReply(payload as unknown as ReplyPayload);
    case 'anomaly':
      return doAnomalies(payload as unknown as AnomalyPayload);
    case 'precedent_search':
      return doPrecedents(payload as unknown as PrecedentPayload);
    case 'preflight':
      return doPreflight(payload as unknown as PreflightPayload);
    case 'reconcile':
      return doReconcile(payload as unknown as ReconcilePayload);
  }
}

/* ========================================================================== */
/* extract — regex heuristics over document text                              */
/* ========================================================================== */

/** Vendors we recognise verbatim. Canonical name -> match tokens. */
const KNOWN_VENDORS: readonly (readonly [string, readonly string[]])[] = [
  ['The Home Depot', ['home depot', 'homedepot']],
  ["Lowe's", ["lowe's", 'lowes']],
  ["McCoy's Building Supply", ['mccoy']],
  ['SiteOne Landscape Supply', ['siteone']],
  ['White Cap', ['white cap', 'whitecap']],
  ['Ferguson', ['ferguson']],
  ['Sherwin-Williams', ['sherwin']],
  ['Harbor Freight Tools', ['harbor freight']],
  ['Tractor Supply Co.', ['tractor supply']],
  ['Ace Hardware', ['ace hardware']],
  ['Grainger', ['grainger', 'w.w. grainger']],
  ['Fastenal', ['fastenal']],
  ['Shell', ['shell oil', 'shell #', 'shell service', 'shell']],
  ['Chevron', ['chevron']],
  ['Exxon', ['exxon', 'exxonmobil']],
  ['Valero', ['valero']],
  ['QuikTrip', ['quiktrip', 'qt #']],
  ["Buc-ee's", ['buc-ee', 'bucee']],
  ["Love's Travel Stop", ["love's travel", 'loves travel']],
  ['Pilot Flying J', ['pilot flying', 'flying j']],
  ["O'Reilly Auto Parts", ["o'reilly", 'oreilly']],
  ['AutoZone', ['autozone']],
  ['NAPA Auto Parts', ['napa auto', 'napa ']],
  ['Discount Tire', ['discount tire']],
  ['Office Depot', ['office depot']],
  ['Staples', ['staples']],
  ['Amazon', ['amazon', 'amzn']],
  ['Costco Wholesale', ['costco']],
  ['Walmart', ['walmart', 'wal-mart']],
  ['Target', ['target']],
  ['H-E-B', ['h-e-b', 'heb ']],
  ['Sysco', ['sysco']],
  ['US Foods', ['us foods']],
  ['UPS', ['ups store', 'united parcel', 'ups ']],
  ['FedEx', ['fedex', 'federal express']],
  ['USPS', ['usps', 'postal service']],
  ['AT&T', ['at&t', 'att ']],
  ['Verizon', ['verizon']],
  ['Comcast Business', ['comcast']],
  ['Spectrum', ['spectrum']],
  ['Intuit QuickBooks', ['intuit', 'quickbooks']],
  ['Adobe', ['adobe']],
  ['Microsoft', ['microsoft', 'msft']],
  ['Google', ['google']],
  ['Dropbox', ['dropbox']],
  ['Zoom', ['zoom.us', 'zoom video']],
  ['Gusto', ['gusto']],
  ['ADP', ['adp payroll', 'adp ']],
  ['Paychex', ['paychex']],
  ['State Farm', ['state farm']],
  ['Progressive', ['progressive ins', 'progressive']],
  ['Whataburger', ['whataburger']],
  ['Chipotle', ['chipotle']],
  ['Starbucks', ['starbucks']],
];

const MONTHS: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

function doExtract(payload: ExtractPayload): ExtractModel {
  const text = payload.text ?? '';
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const evidence: string[] = [];

  const vendor = findVendor(text, lines, evidence);
  const date = findDate(text, evidence);
  const totalCents = findTotal(text, evidence);
  const taxCents = findTax(text, evidence);
  const lineItems = findLineItems(lines);
  const docType = findDocType(text, totalCents !== null, evidence);

  if (lineItems.length > 0) {
    evidence.push(`parsed ${lineItems.length} itemised line${lineItems.length === 1 ? '' : 's'}`);
  }

  // Arithmetic cross-check: do the line items plus tax reconcile to the total?
  let reconciles: boolean | null = null;
  if (totalCents !== null && lineItems.length > 0) {
    const sum = lineItems.reduce((n, li) => n + (li.amountCents ?? 0), 0) + (taxCents ?? 0);
    reconciles = Math.abs(sum - totalCents) <= 2; // tolerate rounding on the receipt
    evidence.push(
      reconciles
        ? `line items + tax reconcile to the printed total (${money(totalCents)})`
        : `line items + tax = ${money(sum)} but the printed total is ${money(totalCents)}`,
    );
  }

  let confidence = 35;
  if (vendor.known) confidence += 22;
  else if (vendor.name) confidence += 8;
  if (date) confidence += 15;
  if (totalCents !== null) confidence += 20;
  if (taxCents !== null) confidence += 5;
  if (lineItems.length > 0) confidence += 5;
  if (docType !== 'unknown') confidence += 5;
  if (reconciles === true) confidence += 5;
  if (reconciles === false) confidence -= 20;
  if (text.trim().length < 40) confidence -= 25;
  // A local heuristic never claims certainty.
  confidence = Math.min(confidence, 96);

  return {
    docType,
    vendor: vendor.name,
    date,
    totalCents,
    taxCents,
    lineItems,
    confidence: clampConfidence(confidence),
    reasoning: evidence.length
      ? `Read from the document text: ${evidence.join('; ')}.`
      : 'Nothing recognisable in the supplied text — no vendor, date, or total could be read.',
  };
}

function findVendor(
  text: string,
  lines: readonly string[],
  evidence: string[],
): { name: string | null; known: boolean } {
  const haystack = text.toLowerCase();
  // Prefer the earliest match in the document — the letterhead, not a footer.
  let best: { name: string; at: number } | null = null;
  for (const [canonical, tokens] of KNOWN_VENDORS) {
    for (const token of tokens) {
      const at = haystack.indexOf(token);
      if (at !== -1 && (best === null || at < best.at)) best = { name: canonical, at };
    }
  }
  if (best) {
    evidence.push(`vendor "${best.name}" recognised in the document header`);
    return { name: best.name, known: true };
  }

  // Fallback: the first substantial line that is not an address, phone, or date.
  for (const line of lines.slice(0, 6)) {
    if (line.length < 3 || line.length > 60) continue;
    if (/^\d/.test(line)) continue; // street number / date / amount
    if (/\d{3}[-.\s]?\d{3}[-.\s]?\d{4}/.test(line)) continue; // phone
    if (/^(receipt|invoice|statement|order|customer|thank you)/i.test(line)) continue;
    const cleaned = line.replace(/[*#]+/g, '').replace(/\s{2,}/g, ' ').trim();
    // Reject OCR noise rather than hand back a "vendor" nobody can act on:
    // must read as words, with no digits buried inside them ("sc4nn3d").
    if (!/^[A-Za-z][A-Za-z0-9&'.,\- ]{2,}$/.test(cleaned)) continue;
    if (/[A-Za-z]\d|\d[A-Za-z]/.test(cleaned)) continue;
    if (!/\b[A-Za-z]{3,}\b/.test(cleaned)) continue;
    evidence.push(`vendor read from the first header line ("${cleaned}") — not a recognised vendor`);
    return { name: cleaned, known: false };
  }
  return { name: null, known: false };
}

function findDate(text: string, evidence: string[]): string | null {
  // A labelled date wins over any loose date in the body.
  const labelled = /(?:date|dated|invoice date|transaction date|sale date)\s*[:#]?\s*([A-Za-z0-9/.,\- ]{6,20})/i.exec(text);
  const candidates = labelled?.[1] ? [labelled[1], text] : [text];

  for (const [i, candidate] of candidates.entries()) {
    const iso = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(candidate);
    if (iso?.[1] && iso[2] && iso[3]) {
      evidence.push(`date ${iso[0]}${i === 0 && labelled ? ' from the "date" label' : ''}`);
      return `${iso[1]}-${iso[2]}-${iso[3]}`;
    }
    const us = /\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/.exec(candidate);
    if (us?.[1] && us[2] && us[3]) {
      const yr = us[3].length === 2 ? `20${us[3]}` : us[3];
      const out = `${yr}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}`;
      evidence.push(`date ${out} parsed from "${us[0]}"${i === 0 && labelled ? ' (labelled)' : ''}`);
      return out;
    }
    const named = /\b([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})\b/.exec(candidate);
    const mm = named?.[1] ? MONTHS[named[1].slice(0, 3).toLowerCase()] : undefined;
    if (named?.[2] && named[3] && mm) {
      const out = `${named[3]}-${mm}-${named[2].padStart(2, '0')}`;
      evidence.push(`date ${out} parsed from "${named[0]}"`);
      return out;
    }
  }
  return null;
}

function parseAmount(raw: string): number | null {
  const cleaned = raw.replace(/[$,\s]/g, '');
  if (!/^-?\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  return Math.round(Number.parseFloat(cleaned) * 100);
}

function findTotal(text: string, evidence: string[]): number | null {
  // "TOTAL" but never "SUBTOTAL"; prefer the last occurrence (receipts print
  // subtotal, tax, then total, and card slips repeat the total at the bottom).
  const re = /(?<!sub)\b(grand\s+total|total\s+due|amount\s+due|balance\s+due|total)\b[^\dA-Za-z\n-]{0,15}\$?\s*(-?[\d,]+\.\d{2})/gi;
  let match: RegExpExecArray | null;
  let found: { label: string; cents: number } | null = null;
  while ((match = re.exec(text)) !== null) {
    if (!match[1] || !match[2]) continue;
    const cents = parseAmount(match[2]);
    if (cents === null) continue;
    // Later labels override earlier ones, but an explicit "amount due" wins.
    if (found === null || !/amount|balance|grand/i.test(found.label)) {
      found = { label: match[1], cents };
    }
  }
  if (found) {
    evidence.push(`total ${money(found.cents)} from the "${found.label.trim()}" line`);
    return found.cents;
  }
  return null;
}

function findTax(text: string, evidence: string[]): number | null {
  // The rate, when printed, sits between the label and the amount
  // ("SALES TAX 8.25%   36.19") — skip it, and never read a percentage as money.
  const re =
    /\b(sales\s+tax|tx\s+tax|tax)\b\s*(?:\(?\s*[\d.]+\s*%\s*\)?)?[^\dA-Za-z\n-]{0,15}\$?\s*(-?[\d,]+\.\d{2})(?!\s*%)/i;
  const m = re.exec(text);
  if (m?.[2]) {
    const cents = parseAmount(m[2]);
    if (cents !== null) {
      evidence.push(`tax ${money(cents)} from the "${(m[1] ?? 'tax').trim()}" line`);
      return cents;
    }
  }
  return null;
}

const NON_ITEM_LABELS =
  /^(sub\s*total|subtotal|total|tax|sales tax|balance|amount due|change|cash|card|visa|mastercard|amex|discover|tender|payment|tip|gratuity|auth|approval|account|terms|due date)\b/i;

function findLineItems(lines: readonly string[]): LineItemModel[] {
  const items: LineItemModel[] = [];
  for (const line of lines) {
    // "<description> ... <amount>" with the amount last on the line.
    const m = /^(.{2,70}?)\s{1,}\$?(-?[\d,]+\.\d{2})$/.exec(line);
    if (!m?.[1] || !m[2]) continue;
    const description = m[1].replace(/\.{2,}/g, ' ').replace(/\s{2,}/g, ' ').trim();
    if (!description || NON_ITEM_LABELS.test(description)) continue;
    if (!/[A-Za-z]{2}/.test(description)) continue;

    // Pull a leading quantity if one is printed ("2 SHEET PLYWOOD" / "2 x ...").
    const q = /^(\d{1,3})\s*(?:x|@)?\s+(.*)$/i.exec(description);
    const quantity = q?.[1] ? Number.parseInt(q[1], 10) : null;
    const desc = q?.[2] ? q[2].trim() : description;

    items.push({ description: desc, quantity, amountCents: parseAmount(m[2]) });
    if (items.length >= 50) break;
  }
  return items;
}

function findDocType(text: string, hasTotal: boolean, evidence: string[]): DocType {
  const t = text.toLowerCase();
  const tests: readonly (readonly [DocType, RegExp])[] = [
    ['w9', /request for taxpayer identification|form\s+w-?9/],
    ['statement', /statement of account|beginning balance|closing balance|statement period/],
    ['invoice', /\binvoice\s*(#|no\.?|number)|\binvoice\b.*\bdue\b|terms:\s*net\s*\d+/],
    ['bill', /\bbill to\b.*\bamount due\b|\bstatement due\b/],
    ['contract', /this agreement|hereby agrees|scope of work|terms and conditions/],
    ['receipt', /thank you for shopping|customer copy|cashier|register|store\s*#|merchant copy|approved\b/],
  ];
  for (const [type, re] of tests) {
    if (re.test(t)) {
      evidence.push(`document type "${type}" from its wording`);
      return type;
    }
  }
  if (hasTotal) {
    evidence.push('document type defaulted to "receipt" — it has a total but no other markers');
    return 'receipt';
  }
  return 'unknown';
}

/* ========================================================================== */
/* categorize — prior human decisions first, then a vendor keyword map         */
/* ========================================================================== */

/** Canonical category name -> vendor/description tokens. */
const CATEGORY_KEYWORDS: readonly (readonly [string, readonly string[]])[] = [
  ['Fuel', ['shell', 'chevron', 'exxon', 'valero', 'quiktrip', 'buc-ee', 'texaco', 'sunoco', 'flying j', "love's travel", 'fuel', 'gas station', 'marathon petro']],
  ['Job Materials', ['mccoy', 'siteone', 'white cap', 'ferguson', 'sherwin', 'builders firstsource', '84 lumber', 'lumber', 'ready mix', 'concrete supply', 'rebar']],
  ['Shop Supplies & Small Tools', ['harbor freight', 'grainger', 'fastenal', 'ace hardware', 'tractor supply', 'northern tool']],
  ['Vehicle Repairs & Maintenance', ["o'reilly", 'oreilly', 'autozone', 'napa auto', 'discount tire', 'oil change', 'brake', 'transmission', 'tire shop']],
  ['Software & Subscriptions', ['adobe', 'microsoft', 'google workspace', 'dropbox', 'zoom', 'intuit', 'quickbooks', 'github', 'slack', 'godaddy', 'aws', 'subscription']],
  ['Payroll', ['gusto', 'adp', 'paychex', 'payroll', 'wages', 'direct deposit pr']],
  ['Insurance', ['state farm', 'progressive', 'geico', 'allstate', 'hartford', 'insurance', 'liability policy', 'workers comp']],
  ['Meals', ['whataburger', 'chipotle', 'starbucks', 'mcdonald', 'restaurant', 'taqueria', 'pizza', 'cafe', 'bbq', 'deli', 'sonic drive']],
  ['Office Supplies', ['office depot', 'staples', 'officemax', 'paper co']],
  ['Utilities', ['at&t', 'verizon', 'comcast', 'spectrum', 'oncor', 'txu', 'reliant energy', 'city of ', 'water dept', 'waste management', 'electric co']],
  ['Bank Fees', ['service charge', 'monthly fee', 'wire fee', 'overdraft', 'nsf fee', 'analysis charge', 'merchant fee']],
  ['Rent', ['rent', 'property mgmt', 'property management', 'leasing', 'storage unit']],
  ['Professional Fees', ['attorney', 'law office', 'legal', 'cpa', 'accounting', 'bookkeeping', 'consultant']],
  ['Shipping & Postage', ['ups ', 'fedex', 'usps', 'postal', 'shipping', 'freight']],
  ['Advertising & Marketing', ['google ads', 'facebook ads', 'meta platforms', 'yelp', 'angi', 'thumbtack', 'nextdoor ads', 'billboard']],
  ['Permits & Licenses', ['permit', 'licens', 'inspection fee', 'city inspect']],
  ['Equipment Rental', ['sunbelt rentals', 'united rentals', 'herc rentals', 'equipment rental']],
  ['Dues & Subscriptions', ['chamber of commerce', 'association dues', 'membership']],
];

/**
 * Vendors that genuinely cannot be resolved from the transaction line alone for
 * a typical client. Guessing here is exactly the failure mode we are avoiding:
 * a Home Depot charge is job materials on one job and shop supplies on another.
 */
const AMBIGUOUS_VENDORS: readonly (readonly [string, readonly string[], string])[] = [
  ['The Home Depot', ['home depot'], 'Could be job materials for a specific job, or shop supplies. Needs the receipt or the job it belongs to.'],
  ["Lowe's", ["lowe's", 'lowes'], 'Could be job materials or shop supplies — the receipt detail decides it.'],
  ['Amazon', ['amazon', 'amzn'], 'Amazon covers office supplies, small tools, and personal purchases. Needs the itemised order.'],
  ['Costco Wholesale', ['costco'], 'Could be office supplies, meals for a crew, or personal. Needs the receipt.'],
  ['Walmart', ['walmart', 'wal-mart'], 'Could be shop supplies, meals, or personal. Needs the receipt.'],
  ['Target', ['target'], 'Could be office supplies or personal. Needs the receipt.'],
];

function doCategorize(payload: CategorizePayload): CategorizeModel {
  const txn = payload.transaction;
  const haystack = `${txn.counterparty ?? ''} ${txn.description}`.toLowerCase();
  const normalized = normalizeVendor(txn.counterparty ?? txn.description);

  // 1. Prior human decisions for this client and vendor. Strongest evidence.
  const prior = payload.priorDecisions.find(
    (p) => normalizeVendor(p.counterparty) === normalized && normalized !== '',
  );
  if (prior) {
    const cat = payload.categories.find((c) => c.id === prior.categoryId);
    if (cat) {
      const confidence = clampConfidence(84 + Math.min(prior.count, 12));
      return {
        categoryId: cat.id,
        categoryName: cat.name,
        confidence,
        reasoning:
          `Matched to ${prior.count} prior ${prior.counterparty} entr${prior.count === 1 ? 'y' : 'ies'} ` +
          `this bookkeeper categorised as ${cat.name} for this client.`,
      };
    }
  }

  // 2. Known-ambiguous vendor: refuse to guess, and hand back a question.
  const ambiguous = AMBIGUOUS_VENDORS.find(([, tokens]) => tokens.some((t) => haystack.includes(t)));
  if (ambiguous) {
    const [name, , why] = ambiguous;
    const guess = matchCategoryByKeyword(haystack, payload.categories);
    return {
      categoryId: guess?.id ?? null,
      categoryName: guess?.name ?? null,
      confidence: 48,
      ambiguous: true,
      reasoning:
        `${name} at ${money(Math.abs(txn.amountCents))} on ${txn.postedAt}, with no prior decision for this ` +
        `vendor on this client. ${why} Sending it to a human rather than guessing.`,
      suggestedQuestion: `What was the ${money(Math.abs(txn.amountCents))} ${name} charge on ${txn.postedAt} for?`,
    };
  }

  // 3. Vendor keyword map.
  const hit = matchCategoryByKeyword(haystack, payload.categories);
  if (hit) {
    return {
      categoryId: hit.id,
      categoryName: hit.name,
      confidence: hit.strong ? 82 : 68,
      reasoning:
        `"${(txn.counterparty ?? txn.description).trim()}" matched the ${hit.name} vendor list on "${hit.token}"` +
        (hit.strong ? '' : ' (a general keyword rather than a named vendor, so confidence is held down)') +
        `. No prior decision exists for this vendor on this client.`,
    };
  }

  // 4. Nothing. Say so; do not invent a category.
  return {
    categoryId: null,
    categoryName: null,
    confidence: 22,
    ambiguous: true,
    reasoning:
      `No prior decision and no vendor match for "${(txn.counterparty ?? txn.description).trim()}" ` +
      `(${money(txn.amountCents)} on ${txn.postedAt}). Returning nothing rather than a guess.`,
    suggestedQuestion: `What was the ${money(Math.abs(txn.amountCents))} charge from "${(txn.counterparty ?? txn.description).trim()}" on ${txn.postedAt}?`,
  };
}

function matchCategoryByKeyword(
  haystack: string,
  categories: readonly CategoryRef[],
): { id: string; name: string; token: string; strong: boolean } | null {
  for (const [canonical, tokens] of CATEGORY_KEYWORDS) {
    for (const token of tokens) {
      if (!haystack.includes(token)) continue;
      const cat = findCategory(categories, canonical);
      if (!cat) continue;
      // A named vendor is stronger evidence than a generic word like "rent".
      const strong = token.length >= 5 && !/^(rent|legal|fuel|permit|licens|shipping|freight|subscription)$/.test(token.trim());
      return { id: cat.id, name: cat.name, token: token.trim(), strong };
    }
  }
  return null;
}

/** Match the client's chart of accounts loosely — names vary by client. */
function findCategory(categories: readonly CategoryRef[], canonical: string): CategoryRef | undefined {
  const target = canonical.toLowerCase();
  const exact = categories.find((c) => c.name.toLowerCase() === target);
  if (exact) return exact;
  const head = target.split(/[&,]/)[0]?.trim() ?? target;
  return categories.find(
    (c) => c.name.toLowerCase().includes(head) || head.includes(c.name.toLowerCase()),
  );
}

/* ========================================================================== */
/* narrative — template driven entirely by the supplied figures                */
/* ========================================================================== */

function doNarrative(payload: NarrativePayload): NarrativeModel {
  const f = payload.figures;
  const s: string[] = [];
  const highlights: string[] = [];

  const netWord = f.netCents >= 0 ? 'kept' : 'ran a loss of';
  s.push(
    `${payload.businessName} brought in ${money(f.revenueCents)} in ${payload.period.label} and ` +
      `${netWord} ${money(Math.abs(f.netCents))} after ${money(f.expensesCents)} of expenses.`,
  );

  if (f.priorRevenueCents !== null) {
    const move = movement(f.revenueCents, f.priorRevenueCents);
    s.push(`Revenue was ${move} against the prior period's ${money(f.priorRevenueCents)}.`);
    highlights.push(`Revenue ${move} to ${money(f.revenueCents)}`);
  } else {
    highlights.push(`Revenue ${money(f.revenueCents)}`);
  }

  if (f.priorNetCents !== null) {
    const pct = pctChange(f.netCents, f.priorNetCents);
    const marginNow = f.revenueCents ? Math.round((f.netCents / f.revenueCents) * 100) : null;
    const marginPrior =
      f.priorRevenueCents && f.priorRevenueCents !== 0
        ? Math.round((f.priorNetCents / f.priorRevenueCents) * 100)
        : null;
    if (marginNow !== null && marginPrior !== null) {
      const pts = marginNow - marginPrior;
      s.push(
        `That puts your margin at ${marginNow}%, ` +
          (pts === 0 ? 'level with last period.' : `${pts > 0 ? 'up' : 'down'} ${Math.abs(pts)} points from ${marginPrior}%.`),
      );
      highlights.push(`Margin ${marginNow}% (${pts >= 0 ? '+' : ''}${pts} pts)`);
    } else if (pct !== null) {
      s.push(`Bottom line was ${movement(f.netCents, f.priorNetCents)} on the prior period.`);
    }
  }

  for (const driver of payload.drivers.slice(0, 3)) {
    const amount = driver.amountCents !== null ? ` (${money(Math.abs(driver.amountCents))})` : '';
    s.push(sentence(`${driver.label}${amount}: ${driver.detail}`));
    highlights.push(`${driver.label}${amount}`);
  }

  const movers = [...payload.topCategories]
    .filter((c) => c.priorAmountCents !== null && c.priorAmountCents !== 0)
    .map((c) => ({ c, pct: pctChange(c.amountCents, c.priorAmountCents ?? 0) ?? 0 }))
    .sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct))
    .slice(0, 2);
  for (const m of movers) {
    s.push(
      `${m.c.name} came to ${money(m.c.amountCents)}, ${movement(m.c.amountCents, m.c.priorAmountCents ?? 0)} ` +
        `from ${money(m.c.priorAmountCents ?? 0)}.`,
    );
  }

  if (f.cashOnHandCents !== null) {
    const receivables = f.receivablesCents !== null ? ` with ${money(f.receivablesCents)} still owed to you` : '';
    const payables = f.payablesCents !== null ? ` and ${money(f.payablesCents)} in bills to pay` : '';
    s.push(`You closed the period with ${money(f.cashOnHandCents)} in the bank${receivables}${payables}.`);
    highlights.push(`Cash ${money(f.cashOnHandCents)}`);
  }

  const watch = payload.watchItems.slice(0, 3);
  if (watch.length) {
    const lead = watch.length === 1 ? 'One thing' : watch.length === 2 ? 'Two things' : 'Three things';
    s.push(`${lead} worth watching: ${watch.map((w) => w.replace(/\.$/, '')).join('; ')}.`);
  }
  s.push('Everything above is reconciled to the bank. Anything here you want the detail behind, just ask.');

  // The narrative is only as good as the figures it was handed.
  let confidence = 70;
  if (f.priorRevenueCents !== null) confidence += 10;
  if (payload.drivers.length > 0) confidence += 8;
  if (payload.topCategories.length >= 3) confidence += 5;
  if (f.cashOnHandCents !== null) confidence += 5;
  if (payload.watchItems.length > 0) confidence += 2;

  return {
    narrative: s.join(' '),
    highlights,
    watchItems: [...watch],
    confidence: clampConfidence(Math.min(confidence, 94)),
    reasoning:
      `Built from the supplied figures only: revenue ${money(f.revenueCents)}, expenses ${money(f.expensesCents)}, ` +
      `net ${money(f.netCents)}, ${payload.drivers.length} named driver(s), ${payload.topCategories.length} ` +
      `category movement(s)${f.priorRevenueCents === null ? ', no prior period supplied' : ''}. ` +
      'No figure appears that was not passed in. Draft only — a bookkeeper approves before it sends.',
  };
}

/* ========================================================================== */
/* reply_draft                                                                */
/* ========================================================================== */

function doReply(payload: ReplyPayload): ReplyModel {
  // The advice tripwire runs in the task too; duplicated here so the stub is
  // safe on its own terms.
  const advice = checkForAdviceRequest(payload.clientMessage);
  if (advice.triggered) {
    return {
      reply: taxAdviceDeflection(payload.clientName),
      confidence: 92,
      reasoning: `Declined on the tax/legal line: ${advice.reason} Matched "${advice.matched}".`,
      deflected: true,
      deflectionReason: advice.reason,
      grounding: [],
    };
  }

  const greeting = payload.clientName ? `Hi ${payload.clientName},` : 'Hi,';
  const body: string[] = [];
  const grounding: string[] = [];

  // Answer from the supplied context, quoting the facts we were given.
  const asked = payload.clientMessage.toLowerCase();
  const relevant = payload.context.filter((c) => {
    const words = c.label.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
    return words.some((w) => asked.includes(w));
  });
  const used = relevant.length > 0 ? relevant : payload.context.slice(0, 2);

  if (used.length > 0) {
    body.push(used.map((c) => `${c.label}: ${c.value}.`).join(' '));
    grounding.push(...used.map((c) => `${c.label} = ${c.value}`));
  } else {
    body.push(
      "Good question — we don't have that in front of us right now. We'll pull it and come back to you today.",
    );
  }

  if (payload.threadSummary) {
    grounding.push(`thread context: ${payload.threadSummary}`);
  }

  if (payload.openQuestions.length > 0) {
    const list = payload.openQuestions.slice(0, 3);
    body.push(
      `While we have you — we're still waiting on ${list.length === 1 ? 'one thing' : `${list.length} things`}: ` +
        `${list.join('; ')}. Whenever you get a minute.`,
    );
  }

  body.push("Anything else you want pulled, just say the word and we'll get it over to you.");

  let confidence = 45;
  if (relevant.length > 0) confidence += 30;
  else if (payload.context.length > 0) confidence += 12;
  if (payload.threadSummary) confidence += 8;
  if (payload.openQuestions.length > 0) confidence += 5;

  return {
    reply: `${greeting}\n\n${body.join('\n\n')}\n\n— Balance Bridge Financial`,
    confidence: clampConfidence(Math.min(confidence, 90)),
    reasoning:
      relevant.length > 0
        ? `Grounded in ${relevant.length} supplied context fact(s) that match the question: ${relevant
            .map((c) => c.label)
            .join(', ')}.`
        : `No supplied context matched the question directly, so the draft commits to following up rather than answering. ${payload.context.length} context item(s) were available.`,
    deflected: false,
    deflectionReason: null,
    grounding,
  };
}

/* ========================================================================== */
/* anomaly — rule based                                                       */
/* ========================================================================== */

const DUP_WINDOW_DAYS = 7;
const PRICE_INCREASE_RATIO = 1.15;
const OUTLIER_RATIO = 3;
/** Below this, an outlier is not worth a bookkeeper's attention. */
const OUTLIER_MIN_CENTS = 50_000; // $500
const NEW_VENDOR_MIN_CENTS = 100_000; // $1,000

function doAnomalies(payload: AnomalyPayload): AnomalyResultModel {
  const txns = [...payload.transactions].sort((a, b) => a.postedAt.localeCompare(b.postedAt));
  const outflows = txns.filter((t) => t.amountCents < 0);
  const byVendor = new Map<string, TransactionRef[]>();
  for (const t of outflows) {
    const key = normalizeVendor(t.counterparty ?? t.description);
    if (!key) continue;
    const list = byVendor.get(key);
    if (list) list.push(t);
    else byVendor.set(key, [t]);
  }

  const found: AnomalyModel[] = [];

  // 1. Duplicate payment — same vendor, same amount, inside a short window.
  for (const [vendor, list] of byVendor) {
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const a = list[i];
        const b = list[j];
        if (!a || !b) continue;
        if (a.amountCents !== b.amountCents) continue;
        const gap = daysBetween(a.postedAt, b.postedAt);
        if (gap < 0 || gap > DUP_WINDOW_DAYS) continue;
        const amount = Math.abs(a.amountCents);
        found.push({
          kind: 'duplicate_payment',
          severity: amount >= 50_000 ? 'high' : 'medium',
          summary: `Possible duplicate payment to ${vendor} — ${money(amount)} twice in ${gap} day${gap === 1 ? '' : 's'}.`,
          detail:
            `${a.postedAt}: ${a.description} ${money(a.amountCents)}. ` +
            `${b.postedAt}: ${b.description} ${money(b.amountCents)}. ` +
            `Identical amount to the same vendor ${gap} day${gap === 1 ? '' : 's'} apart. ` +
            `If it is genuinely two payments, ${money(amount)} is recoverable from the vendor.`,
          transactionIds: [a.id, b.id],
          confidence: amount >= 50_000 ? 88 : 80,
          reasoning: `Rule: same normalised vendor ("${vendor}"), identical amount, ≤${DUP_WINDOW_DAYS} days apart.`,
        });
      }
    }
  }

  // 2. Recurring vendor price increase.
  for (const [vendor, list] of byVendor) {
    if (list.length < 3) continue;
    const latest = list[list.length - 1];
    if (!latest) continue;
    const priorAmounts = list.slice(0, -1).map((t) => Math.abs(t.amountCents));
    const base = median(priorAmounts);
    const now = Math.abs(latest.amountCents);
    if (base <= 0 || now <= base * PRICE_INCREASE_RATIO) continue;
    const pct = pctChange(now, base) ?? 0;
    found.push({
      kind: 'price_increase',
      severity: pct >= 40 ? 'medium' : 'low',
      summary: `${vendor} went up ${pct}% — ${money(base)} a month to ${money(now)}.`,
      detail:
        `${list.length} charges from ${vendor} in this window. The prior ${priorAmounts.length} ran a median of ` +
        `${money(base)}; ${latest.postedAt} came in at ${money(now)}, ${pct}% higher. ` +
        `Annualised that is about ${money((now - base) * 12)} more.`,
      transactionIds: list.map((t) => t.id),
      confidence: 74,
      reasoning: `Rule: ≥3 charges from one vendor and the latest exceeds the median of the rest by >${Math.round((PRICE_INCREASE_RATIO - 1) * 100)}%.`,
    });
  }

  // 3. Unusual amount, judged against the vendor's OWN history only.
  //
  // Deliberately not "large compared to the client's median": payroll, a
  // supplier invoice and an insurance premium are all large and all normal, and
  // flagging them trains bookkeepers to ignore the list. A vendor's charge is
  // only anomalous against that vendor's own pattern.
  for (const [vendor, list] of byVendor) {
    if (list.length < 2) continue;
    const latest = list[list.length - 1];
    if (!latest) continue;
    const now = Math.abs(latest.amountCents);
    if (now < OUTLIER_MIN_CENTS) continue; // small money is not worth an alert
    const others = list.slice(0, -1).map((t) => Math.abs(t.amountCents));
    const base = median(others);
    if (base <= 0 || now <= base * OUTLIER_RATIO) continue;
    found.push({
      kind: 'unusual_amount',
      severity: now >= 200_000 ? 'high' : 'medium',
      summary: `${vendor} charge of ${money(now)} is ${Math.round(now / base)}× their usual ${money(base)}.`,
      detail:
        `${latest.postedAt}: ${latest.description} ${money(latest.amountCents)}. ` +
        `This vendor's other ${others.length} charge${others.length === 1 ? '' : 's'} in the window ` +
        `${others.length === 1 ? 'was' : 'run a median of'} ${money(base)}. ` +
        'Worth confirming what it covered before it lands in the close.',
      transactionIds: [latest.id, ...list.slice(0, -1).map((t) => t.id)],
      confidence: others.length >= 2 ? 78 : 68,
      reasoning:
        `Rule: latest charge >${OUTLIER_RATIO}× the median of this vendor's other charges ` +
        `(n=${others.length}) and ≥${money(OUTLIER_MIN_CENTS)}.`,
    });
  }

  // 4. New vendor with real money attached.
  for (const [vendor, list] of byVendor) {
    if (list.length !== 1) continue;
    const only = list[0];
    if (!only) continue;
    const amount = Math.abs(only.amountCents);
    if (amount < NEW_VENDOR_MIN_CENTS) continue;
    if (found.some((f) => f.transactionIds.includes(only.id))) continue;
    found.push({
      kind: 'new_vendor',
      severity: amount >= 500_000 ? 'medium' : 'low',
      summary: `First payment to ${vendor} — ${money(amount)} on ${only.postedAt}.`,
      detail:
        `${only.description} ${money(only.amountCents)}. No other activity with this vendor in the window. ` +
        'Confirm a W-9 is on file if this is a contractor, before 1099 season makes it urgent.',
      transactionIds: [only.id],
      confidence: 70,
      reasoning: `Rule: exactly one transaction for this vendor in the window and ≥${money(NEW_VENDOR_MIN_CENTS)}.`,
    });
  }

  // 5. Deposits stopped.
  const inflows = txns.filter((t) => t.amountCents > 0);
  const lastDate = txns[txns.length - 1]?.postedAt;
  const lastInflow = inflows[inflows.length - 1];
  if (inflows.length >= 2 && lastDate && lastInflow) {
    const quiet = daysBetween(lastInflow.postedAt, lastDate);
    if (quiet >= 21) {
      found.push({
        kind: 'missing_deposit',
        severity: 'medium',
        summary: `No deposits in the last ${quiet} days — the most recent was ${lastInflow.postedAt}.`,
        detail:
          `${inflows.length} deposits in the window, the last on ${lastInflow.postedAt} for ` +
          `${money(lastInflow.amountCents)}, then nothing through ${lastDate}. ` +
          'Either a feed is not syncing or invoices are not being paid — both are worth knowing now.',
        transactionIds: [lastInflow.id],
        confidence: 66,
        reasoning: 'Rule: ≥21 days between the last money-in transaction and the end of the window.',
      });
    }
  }

  const ranked = found
    .sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || b.confidence - a.confidence)
    .slice(0, 25);

  // Batch confidence = the strongest finding. The question the batch answers is
  // "is this list worth a bookkeeper opening?", not "is every row certain" —
  // each row carries its own confidence and its own needsHuman gate.
  const overall = ranked.length === 0 ? 90 : Math.max(...ranked.map((a) => a.confidence));

  return {
    anomalies: ranked,
    confidence: clampConfidence(overall),
    reasoning:
      `Ran 5 deterministic rules over ${txns.length} transactions ` +
      `(${outflows.length} outflow, ${inflows.length} inflow, ${byVendor.size} distinct vendors). ` +
      (ranked.length === 0
        ? 'Nothing tripped a rule — reporting nothing rather than padding the list.'
        : `${ranked.length} item(s) flagged: ${[...new Set(ranked.map((a) => a.kind))].join(', ')}.`),
  };
}

/** Ensure a supplied fragment ends as a sentence. */
function sentence(text: string): string {
  const t = text.trim();
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

function severityRank(s: Severity): number {
  return s === 'high' ? 3 : s === 'medium' ? 2 : 1;
}

/* ========================================================================== */
/* precedent_search — weighted token overlap                                  */
/* ========================================================================== */

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'for', 'to', 'in', 'on', 'we', 'i', 'how', 'did', 'do', 'does',
  'what', 'is', 'was', 'were', 'with', 'that', 'this', 'it', 'be', 'been', 'our', 'their', 'his', 'her',
  'last', 'year', 'ago', 'about', 'when', 'handle', 'handled', 'client', 'clients',
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

function doPrecedents(payload: PrecedentPayload): PrecedentResultModel {
  const queryTokens = [...new Set(tokenize(payload.query))];
  const scored = payload.precedents.map((p) => {
    const titleTokens = new Set(tokenize(p.title));
    const tagTokens = new Set(p.tags.flatMap((t) => tokenize(t)));
    const bodyTokens = new Set(tokenize(p.body));

    const inTitle = queryTokens.filter((t) => titleTokens.has(t));
    const inTags = queryTokens.filter((t) => tagTokens.has(t));
    const inBody = queryTokens.filter((t) => bodyTokens.has(t));

    let raw = inTitle.length * 3 + inTags.length * 3 + inBody.length;
    const sameClient = p.clientId !== null && p.clientId === payload.clientId;
    const sameIndustry = p.industry !== null && payload.industry !== null && p.industry === payload.industry;
    if (sameClient) raw += 2;
    if (sameIndustry) raw += 1.5;

    const ceiling = queryTokens.length * 3 + 3.5 || 1;
    const score = clampConfidence((raw / ceiling) * 100);

    const why: string[] = [];
    if (inTitle.length) why.push(`title mentions ${inTitle.map(q).join(', ')}`);
    if (inTags.length) why.push(`tagged ${inTags.map(q).join(', ')}`);
    if (inBody.length && !inTitle.length) why.push(`body covers ${inBody.slice(0, 4).map(q).join(', ')}`);
    if (sameClient) why.push('recorded on this same client');
    else if (p.clientId === null) why.push('firm-wide playbook entry');
    if (sameIndustry) why.push(`same industry (${p.industry})`);

    return {
      precedentId: p.id,
      title: p.title,
      score,
      whyMatched: why.length ? why.join('; ') : 'no meaningful overlap with the question',
      snippet: p.body.length > 220 ? `${p.body.slice(0, 217).trimEnd()}…` : p.body,
      _hits: inTitle.length + inTags.length + inBody.length,
    };
  });

  const matches = scored
    .filter((m) => m._hits > 0 && m.score >= 15)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, payload.limit))
    .map(({ _hits: _drop, ...m }) => m);

  const top = matches[0]?.score ?? 0;
  return {
    matches,
    confidence: clampConfidence(matches.length === 0 ? 80 : Math.min(top + 10, 92)),
    reasoning:
      `Scored ${payload.precedents.length} precedent(s) by weighted token overlap ` +
      `(title ×3, tags ×3, body ×1) against ${queryTokens.length} query term(s): ${queryTokens.map(q).join(', ')}. ` +
      (matches.length === 0
        ? 'Nothing overlapped meaningfully — returning no matches rather than a misleading one.'
        : `Top match scored ${top}.`),
  };
}

function q(s: string): string {
  return `"${s}"`;
}

/* ========================================================================== */
/* preflight — threshold rules over the supplied facts                        */
/* ========================================================================== */

const SWING_PCT = 40;

function doPreflight(payload: PreflightPayload): PreflightResultModel {
  const f = payload.facts;
  const checks: CheckModel[] = [];

  checks.push({
    code: 'UNCATEGORIZED',
    label: 'All transactions categorised',
    severity: 'block',
    passed: f.uncategorizedCount === 0,
    detail:
      f.uncategorizedCount === 0
        ? `All ${f.totalTransactions} transactions in ${payload.period.label} carry a category.`
        : `${f.uncategorizedCount} of ${f.totalTransactions} transactions are still uncategorised. The books are not closeable until they are.`,
  });

  const unrec = f.unreconciledAccounts;
  checks.push({
    code: 'RECONCILED',
    label: 'Every account reconciled',
    severity: 'block',
    passed: unrec.length === 0,
    detail:
      unrec.length === 0
        ? 'Every account ties to its statement.'
        : `${unrec.length} account(s) unreconciled: ${unrec
            .map((a) => `${a.name} (${money(a.varianceCents)} out)`)
            .join(', ')}.`,
  });

  const neg = f.negativeBalances;
  checks.push({
    code: 'NEGATIVE_BALANCE',
    label: 'No impossible balances',
    severity: 'warn',
    passed: neg.length === 0,
    detail:
      neg.length === 0
        ? 'No negative balances on accounts that cannot go negative.'
        : `${neg.length} account(s) sit negative: ${neg.map((a) => `${a.name} at ${money(a.balanceCents)}`).join(', ')}. Usually a missing deposit or a misposted transfer.`,
  });

  const docs = f.missingDocuments;
  const docValue = docs.reduce((n, d) => n + Math.abs(d.amountCents ?? 0), 0);
  checks.push({
    code: 'SUPPORTING_DOCS',
    label: 'Supporting documents on file',
    severity: 'warn',
    passed: docs.length === 0,
    detail:
      docs.length === 0
        ? 'Every transaction that needs a receipt has one.'
        : `${docs.length} document(s) still outstanding${docValue ? `, covering ${money(docValue)} of spend` : ''}: ${docs
            .slice(0, 5)
            .map((d) => d.label)
            .join(', ')}${docs.length > 5 ? `, +${docs.length - 5} more` : ''}.`,
  });

  checks.push({
    code: 'OPEN_QUESTIONS',
    label: 'Client questions answered',
    severity: 'warn',
    passed: f.unansweredQuestions === 0,
    detail:
      f.unansweredQuestions === 0
        ? 'No questions outstanding with the client.'
        : `${f.unansweredQuestions} question(s) are still with the client. Each one is a transaction we cannot finalise.`,
  });

  checks.push({
    code: 'OPEN_ANOMALIES',
    label: 'Flagged anomalies cleared',
    severity: 'warn',
    passed: f.openAnomalies === 0,
    detail:
      f.openAnomalies === 0
        ? 'No open anomalies on this period.'
        : `${f.openAnomalies} anomal${f.openAnomalies === 1 ? 'y' : 'ies'} flagged and not yet resolved or dismissed.`,
  });

  const swings = f.periodSwings
    .map((s) => ({ ...s, pct: pctChange(s.amountCents, s.priorAmountCents) }))
    .filter((s) => s.pct !== null && Math.abs(s.pct) >= SWING_PCT);
  checks.push({
    code: 'PERIOD_SWING',
    label: 'Period-over-period movements explained',
    severity: 'warn',
    passed: swings.length === 0,
    detail:
      swings.length === 0
        ? `No category moved more than ${SWING_PCT}% against the prior period.`
        : `${swings.length} large swing(s) to explain before review: ${swings
            .map((s) => `${s.category} ${s.pct! > 0 ? 'up' : 'down'} ${Math.abs(s.pct!)}% (${money(s.priorAmountCents)} → ${money(s.amountCents)})`)
            .join('; ')}.`,
  });

  const failedBlocks = checks.filter((c) => !c.passed && c.severity === 'block').length;
  const failedWarns = checks.filter((c) => !c.passed && c.severity === 'warn').length;

  return {
    checks,
    // Threshold arithmetic over supplied counts — high confidence by construction.
    confidence: clampConfidence(f.totalTransactions > 0 ? 95 : 60),
    reasoning:
      `Applied ${checks.length} deterministic checks to ${payload.period.label} ` +
      `(${f.totalTransactions} transactions). ${failedBlocks} blocking failure(s), ${failedWarns} warning(s). ` +
      (failedBlocks > 0
        ? 'This period must not reach a reviewer in this state.'
        : failedWarns > 0
          ? 'Reviewable, with items to explain.'
          : 'Clean — ready for human review.'),
  };
}

/* ========================================================================== */
/* reconcile                                                                  */
/* ========================================================================== */

function doReconcile(payload: ReconcilePayload): ReconcileModel {
  const variance = payload.statementBalanceCents - payload.ledgerBalanceCents;
  if (variance === 0) {
    return {
      varianceCents: 0,
      explanation: `${payload.accountName} ties exactly to the statement at ${money(payload.statementBalanceCents)}.`,
      candidateTransactionIds: [],
      confidence: 95,
      reasoning: 'Statement balance equals ledger balance; nothing to explain.',
    };
  }

  // Look for a subset of open items whose sum equals the variance exactly.
  const subset = findSubset(payload.openItems, variance);
  if (subset) {
    return {
      varianceCents: variance,
      explanation:
        `The ${money(Math.abs(variance))} variance on ${payload.accountName} equals ${subset.length} ` +
        `uncleared item${subset.length === 1 ? '' : 's'}: ` +
        subset.map((t) => `${t.postedAt} ${t.description} ${money(t.amountCents)}`).join('; ') + '.',
      candidateTransactionIds: subset.map((t) => t.id),
      confidence: 88,
      reasoning: `Exact subset match: ${subset.length} open item(s) sum to the ${money(variance)} variance.`,
    };
  }

  return {
    varianceCents: variance,
    explanation:
      `${payload.accountName} is ${money(Math.abs(variance))} ${variance > 0 ? 'higher' : 'lower'} on the statement ` +
      `than in the ledger. No combination of the ${payload.openItems.length} open items explains it exactly.`,
    candidateTransactionIds: payload.openItems
      .filter((t) => Math.abs(Math.abs(t.amountCents) - Math.abs(variance)) <= 500)
      .map((t) => t.id),
    confidence: 45,
    reasoning: `No exact subset of ${payload.openItems.length} open items sums to ${money(variance)}; returning near-miss candidates only.`,
  };
}

/** Exact subset sum over a small set of open items (capped for safety). */
function findSubset(items: readonly TransactionRef[], target: number): TransactionRef[] | null {
  const pool = items.slice(0, 16);
  const total = 1 << pool.length;
  for (let mask = 1; mask < total; mask += 1) {
    let sum = 0;
    for (let i = 0; i < pool.length; i += 1) {
      if (mask & (1 << i)) sum += pool[i]?.amountCents ?? 0;
    }
    if (sum === target) {
      return pool.filter((_, i) => mask & (1 << i));
    }
  }
  return null;
}
