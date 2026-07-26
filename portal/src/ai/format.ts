/**
 * Formatting helpers shared by the stub provider and the task modules.
 * Money is integer minor units everywhere — never a float, never a rounded
 * restatement (src/db/schema.ts: "Integers only — never floats").
 */

/** 123456 -> "$1,234.56". Negative shown as "-$1,234.56". */
export function money(cents: number): string {
  const neg = cents < 0;
  const abs = Math.abs(Math.round(cents));
  const dollars = Math.floor(abs / 100);
  const rest = String(abs % 100).padStart(2, '0');
  return `${neg ? '-' : ''}$${dollars.toLocaleString('en-US')}.${rest}`;
}

/** Percent change as a signed whole number, or null when the base is zero. */
export function pctChange(current: number, prior: number): number | null {
  if (!prior) return null;
  return Math.round(((current - prior) / Math.abs(prior)) * 100);
}

/** "up 12%" / "down 3%" / "flat". */
export function movement(current: number, prior: number): string {
  const pct = pctChange(current, prior);
  if (pct === null) return 'no prior period to compare against';
  if (pct === 0) return 'flat';
  return `${pct > 0 ? 'up' : 'down'} ${Math.abs(pct)}%`;
}

/** Clamp a score into the 0-100 integer range every suggestion must carry. */
export function clampConfidence(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/** Vendor strings from bank feeds are noisy; normalise before comparing. */
export function normalizeVendor(raw: string | null | undefined): string {
  if (!raw) return '';
  return raw
    .toUpperCase()
    // Card-processor and channel prefixes.
    .replace(/^(SQ|TST|PAYPAL|PP|IC|POS|ACH|DEBIT|CREDIT|CHECKCARD|PURCHASE)\s*[*#-]?\s*/g, '')
    // Embedded dates ("GUSTO PAYROLL 3/02", "ACH 03-16-26") — these vary per
    // charge and would otherwise split one vendor into many.
    .replace(/\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b/g, ' ')
    // Trailing store/terminal numbers and reference ids.
    .replace(/\s+#?\d{3,}\b/g, ' ')
    .replace(/[^A-Z0-9&' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Integer median of a list. Returns 0 for an empty list. */
export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0;
  return Math.round(((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2);
}

/** Whole days between two YYYY-MM-DD dates. */
export function daysBetween(a: string, b: string): number {
  const ms = Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`);
  return Math.round(ms / 86_400_000);
}
