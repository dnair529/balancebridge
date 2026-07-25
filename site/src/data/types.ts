export type IconName =
  | 'book' | 'calculator' | 'send' | 'scale' | 'sparkles' | 'chart'
  | 'trending' | 'compass' | 'rocket' | 'file-check' | 'shield' | 'clock'
  | 'check' | 'arrow-right' | 'phone' | 'mail' | 'map-pin' | 'chevron-down'
  | 'menu' | 'x' | 'star' | 'lock' | 'message' | 'calendar' | 'dollar' | 'users'
  | 'building' | 'utensils' | 'stethoscope' | 'cart' | 'briefcase' | 'home';

export interface QA {
  q: string;
  a: string;
}

export interface ServiceDef {
  slug: string;
  name: string; // short label for nav/cards
  title: string; // H1, keyword-led, sentence case
  metaTitle: string; // <= 60 chars, includes "Texas" or "TX" where natural
  metaDescription: string; // <= 155 chars
  icon: IconName;
  oneLiner: string; // card text, <= 120 chars, outcome-first
  heroSub: string; // 1-2 sentence subhead under H1
  symptoms: string[]; // 4-5 pains, second person
  included: string[]; // 5-7 concrete deliverables
  steps: { title: string; text: string }[]; // 3-4 steps
  priceAnchor: string; // e.g. 'Included in plans from $395/mo' or 'Custom quote'
  faqs: QA[]; // 3-4 service-specific
  related: string[]; // 2 service slugs
  industrySlugs: string[]; // 2-3 industry slugs
}

export interface IndustryDef {
  slug: string;
  name: string;
  title: string; // H1
  metaTitle: string;
  metaDescription: string;
  icon: IconName;
  oneLiner: string;
  heroSub: string;
  pains: string[]; // 4-5 industry-specific bookkeeping pains
  howWeHelp: { title: string; text: string }[]; // 4-5
  serviceSlugs: string[]; // 3-4 most relevant services
  faqs: QA[]; // 2-3
}

export interface LocationDef {
  slug: string;
  city: string; // display name
  metaTitle: string;
  metaDescription: string;
  heroSub: string;
  intro: string[]; // 2-3 paragraphs, genuinely local (economy, industries, no doorway-page fluff)
  industriesEmphasis: string[]; // industry slugs emphasized in this metro
  faqs: QA[]; // 2-3, city-specific where possible
}

export interface Testimonial {
  quote: string;
  name: string;
  role: string;
  company: string;
  industry: string;
}

export interface CaseStudy {
  title: string;
  industry: string;
  challenge: string;
  actions: string[];
  results: string[]; // concrete, plausible numbers
}

export interface PricingTier {
  name: string;
  tagline: string;
  priceFrom: number; // monthly USD
  popular?: boolean;
  bestFor: string;
  features: string[];
  notIncluded?: string[];
}
