/**
 * The task catalogue. One module per task, each with typed input and output,
 * each returning a `Suggestion<T>` that a human must `.confirm(userId)` before
 * anything is persisted.
 *
 * | Task | Module | Notes |
 * |---|---|---|
 * | extract | `extractDocument.ts` | OCR text → vendor/date/amount/tax/lines |
 * | categorize | `suggestCategory.ts` | rules first, model second, question third |
 * | narrative | `draftNarrative.ts` | always `needsHuman` — client-facing |
 * | reply_draft | `draftReply.ts` | always `needsHuman` — never auto-send |
 * | anomaly | `detectAnomalies.ts` | ids validated against the input set |
 * | precedent_search | `searchPrecedents.ts` | firm memory, client-scoped |
 * | preflight | `preflightClose.ts` | arithmetic overrides the model |
 */

export { extractDocument } from './extractDocument.js';
export type { ExtractDocumentInput, ExtractedDocument, ExtractedLineItem } from './extractDocument.js';

export { suggestCategory } from './suggestCategory.js';
export type { SuggestCategoryInput, CategorySuggestion } from './suggestCategory.js';

export { draftNarrative } from './draftNarrative.js';
export type { DraftNarrativeInput, NarrativeDraft } from './draftNarrative.js';

export { draftReply } from './draftReply.js';
export type { DraftReplyInput, ReplyDraft } from './draftReply.js';

export { detectAnomalies } from './detectAnomalies.js';
export type { DetectAnomaliesInput, DetectedAnomaly } from './detectAnomalies.js';

export { searchPrecedents } from './searchPrecedents.js';
export type { SearchPrecedentsInput, PrecedentMatch, PrecedentSearchResult } from './searchPrecedents.js';

export { preflightClose } from './preflightClose.js';
export type { PreflightCloseInput, CloseCheck, PreflightResult } from './preflightClose.js';

export { matchRule } from '../rules.js';
export type { CategorizationRuleRef, RuleMatch } from '../rules.js';
