# Balance Bridge Financial — Brand Guide v1.0

## 1. Brand idea

**"The bridge between where your books are and where your business is going."**

Balance Bridge sits at the intersection of two feelings a small-business owner rarely gets from an accountant: *calm* (your books are handled, balanced, audit-ready) and *momentum* (your numbers now tell you where to go). Every brand decision reinforces one of those two.

- Personality: confident, precise, modern, plain-spoken. A fintech product's polish with a neighbor's straight talk.
- Never: stuffy, jargon-heavy, beige-accounting-office, clip-art handshake.

## 2. Logo

**Concept — "The Ledger Bridge."** One continuous emerald arc (a bridge span — and a growth curve) rests on two pillars over a solid baseline (the ledger line — books that balance). Three strokes, instantly readable at 16px, meaningful at any size.

| Asset | File | Use |
|---|---|---|
| Mark | `logo-mark.svg` | Favicons, avatars, app icon |
| Mark reversed | `logo-mark-reversed.svg` | On navy/dark backgrounds |
| Horizontal lockup | rendered in site header (`Logo.astro`) | Primary usage |

**Wordmark:** "Balance Bridge" set in Space Grotesk SemiBold, tight tracking; "FINANCIAL" in Inter Medium, +18% letterspacing, slate. In the lockup the mark sits left of the wordmark at cap height.

Clear space: keep ≥ the height of the mark's baseline stroke on all sides. Minimum sizes: mark 16px, lockup 120px wide. Don't: rotate, recolor outside the palette, add drop shadows, place the emerald arc on emerald backgrounds.

## 3. Color

| Token | Hex | Role |
|---|---|---|
| Navy 950 `ink` | `#071522` | Darkest backgrounds, footer |
| Navy 900 `navy` | `#0B1F33` | Primary brand dark; hero backgrounds, headings on light |
| Navy 800 | `#122C47` | Cards on dark, hover states |
| Slate 600 | `#526175` | Secondary text on light |
| Slate 400 | `#8B99AB` | Muted text on dark, captions |
| Mist 100 | `#EEF2F6` | Light section backgrounds |
| Paper | `#F8FAFC` | Page background |
| White | `#FFFFFF` | Cards, text on dark |
| Emerald 500 `accent` | `#10B981` | Primary CTAs, links, the arc |
| Emerald 400 | `#34D399` | Accent on dark backgrounds, hovers |
| Teal 400 | `#2DD4BF` | Gradient partner only — never solo |

Ratios: ~60% white/paper, ~30% navy, ~10% emerald. Emerald is earned — CTAs, key data, the arc. If everything is emerald, nothing is.

Accessibility: body text pairs must meet WCAG AA. Approved pairs: navy-900 on paper (14.9:1), slate-600 on white (7.0:1), white on navy-900 (14.9:1), slate-400 on navy-950 (7.0:1), navy-950 on emerald-500 (for CTA text, 7.9:1). Never emerald-500 text on white below 24px bold.

## 4. Typography

| Role | Font | Weights | Notes |
|---|---|---|---|
| Display / headings | **Space Grotesk** | 500, 600, 700 | Tight leading (1.05–1.15), tracking -0.02em on display sizes |
| Body / UI | **Inter** | 400, 500, 600 | Line-height 1.6–1.7 body; 1.4 UI |
| Numerals in tables | Inter, `font-variant-numeric: tabular-nums` | | Money always aligns |

Type scale (desktop → mobile): display 64→40, h1 48→34, h2 36→28, h3 24→20, body-lg 18, body 16, small 14. Sentence case everywhere — headlines are statements, not Title Case Announcements.

## 5. Voice

- Lead with the owner's outcome, not our process: "Know your numbers by the 10th" not "We deliver monthly financial packages."
- Plain English, short sentences. Explain any term a non-accountant wouldn't use at dinner.
- Specific > superlative: "reconciled to the penny, delivered by the 10th business day" beats "world-class service."
- Texas warmth without costume: friendly and direct; no howdy, no cowboy clichés.
- We coordinate tax prep with your CPA — we never imply we file returns or are a CPA firm.

## 6. Imagery & graphics

No stock handshakes, no towers of paper, no calculators. Use: abstract data-driven graphics (the arc motif, subtle grid lines, soft emerald glows on navy), real product UI (report mockups, dashboard tiles), and — when real photos exist — candid workspace/owner photography, warm-neutral grade. Iconography: Lucide icons, 1.5px stroke, rounded, in slate or emerald.

## 7. Motion

Subtle and purposeful; the site should feel *smooth*, never animated for its own sake.

- Reveal-on-scroll: 500ms fade + 16px rise, ease-out, staggered ≤ 80ms between siblings.
- Hovers: 150–200ms; buttons lift 1px with shadow deepen; cards border-glow emerald.
- Numbers count up once on first view (stats bar).
- Respect `prefers-reduced-motion`: all reveals collapse to opacity-only or none.

## 8. The arc motif

The logo's arc recurs as a background element: a thin emerald curve spanning sections, section dividers that rise gently, and the radial "glow" behind hero content. It's the one decorative element — used sparingly, it ties every page back to the mark.
