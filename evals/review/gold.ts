import type { ContentNode } from '@humanize/domain';

/**
 * Labelled review cases. `comment: false` cases matter more than `comment: true` ones: a
 * reviewer that misses a weak sentence is mildly less useful, while one that comments on
 * sound writing is actively annoying and gets uninstalled. The specification is explicit that
 * this corpus optimises for the precision of inline comments rather than recall.
 *
 * `legitimate` marks copy that is promotional but honest and specific. Those are the hardest
 * negatives, because they share vocabulary with the writing the product exists to flag.
 */
export interface ReviewCase {
  id: string;
  kind: ContentNode['kind'];
  text: string;
  /** Whether a reviewer should raise a finding on this content at all. */
  comment: boolean;
  /** Why this case is in the corpus, for whoever reads a failure. */
  note: string;
  legitimate?: boolean;
  /**
   * The label is a judgement call rather than an obvious one. Failures on ambiguous cases are
   * reported separately, because they may mean the label is wrong rather than the reviewer.
   */
  ambiguous?: boolean;
}

export const REVIEW_GOLD: ReviewCase[] = [
  // --- Should be flagged: generic, low-information promotional writing ---
  {
    id: 'generic-hero',
    kind: 'marketing',
    text: 'Unlock unprecedented potential with our cutting-edge platform built for modern teams everywhere.',
    comment: true,
    note: 'Stacked promotional cliches with no product-specific information.',
  },
  {
    id: 'generic-stack',
    kind: 'marketing',
    text: 'Our revolutionary, state-of-the-art solution seamlessly integrates to supercharge your workflow and take productivity to the next level.',
    comment: true,
    note: 'Four low-information phrases in one sentence.',
  },
  {
    id: 'generic-docs-opener',
    kind: 'documentation',
    text: "In today's fast-paced world, it is important to note that leveraging the power of our platform will delve into a seamless experience.",
    comment: true,
    note: 'Formulaic opener that says nothing about the product.',
  },
  {
    id: 'absolute-security-claim',
    kind: 'documentation',
    text: 'Our platform is 100% secure and your data is completely protected at all times.',
    comment: true,
    note: 'Absolute security claim that cannot be supported.',
  },
  {
    id: 'repeated-openings',
    kind: 'marketing',
    text: 'This helps teams move faster. This keeps content consistent. This reduces the time spent in review.',
    comment: true,
    note: 'Three consecutive sentences with the same opening.',
  },

  // --- Should NOT be flagged: sound, specific product writing ---
  {
    id: 'clear-instruction',
    kind: 'documentation',
    text: 'Run the database migration before starting the worker process.',
    comment: false,
    note: 'Direct, specific and correct; nothing to improve.',
  },
  {
    id: 'clear-onboarding',
    kind: 'documentation',
    text: 'Connect a repository to start reviewing pull requests.',
    comment: false,
    note: 'Plain instruction in the repository voice.',
  },
  {
    id: 'plain-hero',
    kind: 'marketing',
    text: 'Humanize reviews the content your users read, before it ships.',
    comment: false,
    note: 'Marketing copy that is concrete and specific.',
  },
  {
    id: 'technical-explanation',
    kind: 'documentation',
    text: 'Repository contents are cloned read-only and deleted after each job finishes.',
    comment: false,
    note: 'Factual technical statement with no promotional wording.',
  },
  {
    id: 'error-message',
    kind: 'error',
    text: 'We could not reach your runner. Check that it is running and try again.',
    comment: false,
    note: 'Clear, actionable error copy.',
  },

  // --- Should NOT be flagged: legitimate promotional language ---
  {
    id: 'legitimate-benefit',
    kind: 'marketing',
    text: 'Catch weak product copy in the pull request, before your customers read it.',
    comment: false,
    legitimate: true,
    note: 'Promotional but specific and verifiable; shares vocabulary with the flagged cases.',
  },
  {
    id: 'legitimate-comparison',
    kind: 'marketing',
    text: 'Reviews run on your own hardware, so your source never leaves your network.',
    comment: false,
    legitimate: true,
    note: 'A real differentiator stated plainly, not a superlative.',
  },
  {
    id: 'legitimate-speed-claim',
    kind: 'marketing',
    text: 'Most reviews finish in under a minute on a laptop.',
    comment: false,
    legitimate: true,
    note: 'A quantified claim; specific claims must not be treated as promotional noise.',
  },

  // --- Should NOT be flagged: microcopy too short to judge as prose ---
  {
    id: 'button-label',
    kind: 'button',
    text: 'Save changes',
    comment: false,
    note: 'A two-word label must never receive long-form prose review.',
  },
  {
    id: 'accessibility-label',
    kind: 'accessibility',
    text: 'Close the notification panel',
    comment: false,
    note: 'Accessibility text that is already clear and specific.',
  },
  {
    id: 'locale-string',
    kind: 'label',
    text: 'You have {{count}} unread alerts',
    comment: false,
    note: 'A correct localized string carrying a placeholder.',
  },

  // --- The ambiguous middle: mediocre human copy and edited AI-assisted copy ---
  {
    id: 'mediocre-wordy',
    kind: 'documentation',
    text: 'The dashboard provides users with the ability to view and manage all of their applications in a single place.',
    comment: true,
    ambiguous: true,
    note: 'Informative but padded; "provides users with the ability to" is "lets users".',
  },
  {
    id: 'mediocre-redundant',
    kind: 'documentation',
    text: 'In order to get started, you will first need to begin by installing the GitHub App.',
    comment: true,
    ambiguous: true,
    note: 'Three redundant openings stacked before the actual instruction.',
  },
  {
    id: 'ai-assisted-residual',
    kind: 'marketing',
    text: 'Humanize empowers teams to seamlessly streamline their content review process.',
    comment: true,
    ambiguous: true,
    note: 'Edited AI copy that still carries empowers, seamlessly and streamline.',
  },
  {
    id: 'ai-list-cadence',
    kind: 'marketing',
    text: 'Humanize reviews your content. Humanize flags weak wording. Humanize suggests better phrasing.',
    comment: true,
    ambiguous: true,
    note: 'Uniform three-clause cadence with an identical opening each time.',
  },
  {
    id: 'vague-tagline',
    kind: 'heading',
    text: 'Powerful tools for modern teams',
    comment: true,
    ambiguous: true,
    note: 'A short tagline that says nothing specific; defensible either way.',
  },
  {
    id: 'mediocre-passive',
    kind: 'documentation',
    text: 'Content is reviewed by Humanize when a pull request is opened.',
    comment: false,
    ambiguous: true,
    note: 'Passive voice, but accurate and perfectly clear; a reviewer should leave it.',
  },
  {
    id: 'edited-ai-clean',
    kind: 'marketing',
    text: 'Humanize flags generic copy in pull requests so you can fix it before release.',
    comment: false,
    ambiguous: true,
    note: 'AI-drafted then edited into something specific; the edit worked.',
  },
  {
    id: 'verbose-but-informative',
    kind: 'documentation',
    text: 'When you install the app, Humanize scans every tracked file on your default branch, classifies each one, and extracts only the text your users actually see.',
    comment: false,
    ambiguous: true,
    note: 'Long, but every clause carries information; length alone is not a problem.',
  },
  {
    id: 'hedged-claim',
    kind: 'marketing',
    text: 'Humanize can help reduce the number of content issues that reach production.',
    comment: false,
    ambiguous: true,
    note: 'Hedged rather than absolute, which is the honest way to state this.',
  },
  {
    id: 'industry-jargon',
    kind: 'documentation',
    text: 'Humanize integrates with your existing pipeline through GitHub webhooks.',
    comment: false,
    ambiguous: true,
    note: 'Jargon that is correct and expected by this audience.',
  },
];
