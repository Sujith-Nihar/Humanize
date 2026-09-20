/**
 * Labelled extraction fixtures. Each case states the user-visible strings a reviewer must
 * find and the strings it must never mistake for prose. Recall is measured against `visible`,
 * precision against anything extracted that is not in `visible`, and range accuracy against
 * whether each extracted node's offsets select its own text from the original source.
 *
 * The thresholds these feed are release gates, so a case is only added here when a human has
 * decided what the correct answer is.
 */
export interface GoldCase {
  parser: string;
  filePath: string;
  source: string;
  /** Strings a reviewer must extract. */
  visible: string[];
  /** Strings present in the file that must never be extracted as prose. */
  ignored: string[];
  /** Placeholders each visible string must carry, keyed by the string. */
  placeholders?: Record<string, string[]>;
  /** Visible strings that must NOT be offered as a one-click replacement. */
  unsafe?: string[];
}

export const GOLD: GoldCase[] = [
  {
    parser: 'babel',
    filePath: 'landing.tsx',
    source: `const endpoint = '/api/users';
const status = 'active';
export const Hero = () => (
  <section>
    <h1>Manage your applications</h1>
    <p>Review every change before it ships.</p>
    <input placeholder="Work email" name="email_address" />
    <img src="/hero.png" alt="Dashboard overview" />
  </section>
);
`,
    visible: ['Manage your applications', 'Review every change before it ships.', 'Work email', 'Dashboard overview'],
    ignored: ['/api/users', 'active', 'email_address', '/hero.png'],
  },
  {
    parser: 'markdown',
    filePath: 'docs/guide.md',
    source: `# Getting started

Run the migration before starting the worker.

\`\`\`bash
pnpm install --frozen-lockfile
\`\`\`

See the [configuration reference](./config.md) for details.
`,
    visible: ['Getting started', 'Run the migration before starting the worker.', 'See the configuration reference for details.'],
    ignored: ['pnpm install --frozen-lockfile', './config.md'],
  },
  {
    parser: 'html',
    filePath: 'index.html',
    source: `<!doctype html>
<html lang="en">
  <head><title>Humanize</title></head>
  <body>
    <h1>Content review for product teams</h1>
    <a href="https://example.com/pricing" title="See pricing">Pricing</a>
    <img src="/assets/hero-v2.png" alt="Review summary" class="hero large" />
    <script>const secret = "this is code";</script>
    <style>.hero::after { content: "decorative"; }</style>
  </body>
</html>
`,
    visible: ['Content review for product teams', 'Pricing', 'See pricing', 'Review summary', 'Humanize'],
    ignored: ['https://example.com/pricing', '/assets/hero-v2.png', 'hero large', 'this is code', 'en'],
  },
  {
    parser: 'json-locale',
    filePath: 'locales/en.json',
    source: `{
  "hero.title": "Review the content your users read",
  "button.save": "Save changes",
  "docs.url": "https://example.com/docs",
  "asset.path": "/images/hero.png",
  "theme.color": "#ff0000"
}
`,
    visible: ['Review the content your users read', 'Save changes'],
    ignored: ['https://example.com/docs', '/images/hero.png', '#ff0000', 'hero.title'],
  },
  {
    parser: 'vue',
    filePath: 'Hero.vue',
    source: `<template>
  <section>
    <h1>Ship better product copy</h1>
    <img src="hero.png" alt="Review summary" />
  </section>
</template>

<script setup>
const internalStatus = 'active';
</script>

<style>
.hero { color: red; }
</style>
`,
    visible: ['Ship better product copy', 'Review summary'],
    ignored: ['active', 'hero.png', 'color: red;'],
  },
  {
    parser: 'svelte',
    filePath: 'Page.svelte',
    source: `<script>
  const endpoint = '/api/reviews';
</script>

<h1>Manage your applications</h1>
<button>Save changes</button>
<img src="hero.png" alt="Dashboard overview" />

<style>
  h1 { font-size: 2rem; }
</style>
`,
    visible: ['Manage your applications', 'Save changes', 'Dashboard overview'],
    ignored: ['/api/reviews', 'hero.png', 'font-size: 2rem;'],
  },
  {
    parser: 'css',
    filePath: 'styles.css',
    source: `.badge::after { content: "New feature"; }
.icon::before { content: ""; }
.counter::before { content: counter(step); }
.label::after { content: attr(data-label); }
`,
    visible: ['New feature'],
    ignored: ['counter(step)', 'attr(data-label)'],
  },
  {
    parser: 'babel',
    filePath: 'messages.tsx',
    source: `import { toast } from './ui';
const LOG_PREFIX = '[humanize:worker]';
export function notify(count: number, name: string) {
  toast(\`You have \${count} new alerts\`);
  console.log(LOG_PREFIX, 'dispatched');
  return <p title="Signed in as {name}">Welcome back, friend</p>;
}
`,
    visible: ['Welcome back, friend', 'Signed in as {name}'],
    ignored: ['[humanize:worker]', 'dispatched', './ui'],
    placeholders: { 'Signed in as {name}': ['{name}'] },
  },
  {
    parser: 'babel',
    filePath: 'deep.tsx',
    source: `export const Nested = () => (
  <div><div><div><div><div><div><div><div>
    <span>Deeply nested but still visible</span>
  </div></div></div></div></div></div></div></div>
);
`,
    visible: ['Deeply nested but still visible'],
    ignored: [],
  },
  {
    parser: 'markdown',
    filePath: 'docs/api.md',
    source: `## Rate limits

Each installation may send \`5000\` requests per hour.

| Plan | Requests |
| --- | --- |
| Free | 1000 |

> Requests above the limit receive a 429 response.
`,
    visible: ['Rate limits', 'Each installation may send 5000 requests per hour.', 'Requests above the limit receive a 429 response.'],
    ignored: ['| Plan | Requests |'],
    unsafe: ['Each installation may send 5000 requests per hour.'],
  },
  {
    parser: 'markdown',
    filePath: 'docs/mixed.md',
    source: `Read the **getting started** guide and the [API reference](./api.md) before you begin.
`,
    visible: ['Read the getting started guide and the API reference before you begin.'],
    ignored: ['./api.md'],
    unsafe: ['Read the getting started guide and the API reference before you begin.'],
  },
  {
    parser: 'html',
    filePath: 'entities.html',
    source: `<p>Terms &amp; conditions apply</p>
<img src="a.png" alt="Caf&eacute; view" />
<p>Plain sentence with no entities</p>
`,
    visible: ['Terms & conditions apply', 'Café view', 'Plain sentence with no entities'],
    ignored: ['a.png'],
    unsafe: ['Terms & conditions apply', 'Café view'],
  },
  {
    parser: 'html',
    filePath: 'broken.html',
    source: `<div><p>Unclosed paragraph
<span>Nested without closing
<h2>Still extracted</h2>
`,
    visible: ['Unclosed paragraph', 'Nested without closing', 'Still extracted'],
    ignored: [],
  },
  {
    parser: 'json-locale',
    filePath: 'locales/fr.json',
    source: `{
  "alerts.count": "Vous avez {{count}} alertes",
  "welcome": "Bonjour %s, vous avez %d messages",
  "escaped": "Elle a dit \\"bonjour\\"",
  "build.sha": "a1b2c3d4e5f6",
  "empty": ""
}
`,
    visible: ['Vous avez {{count}} alertes', 'Bonjour %s, vous avez %d messages', 'Elle a dit "bonjour"'],
    ignored: ['a1b2c3d4e5f6', ''],
    placeholders: { 'Vous avez {{count}} alertes': ['{{count}}'], 'Bonjour %s, vous avez %d messages': ['%s', '%d'] },
    unsafe: ['Elle a dit "bonjour"'],
  },
  {
    parser: 'vue',
    filePath: 'Dynamic.vue',
    source: `<template>
  <div>
    <h1>{{ product.title }}</h1>
    <p>Static paragraph that must be reviewed</p>
    <img :alt="computedAlt" src="a.png" />
    <input placeholder="Search documentation" />
  </div>
</template>
`,
    visible: ['Static paragraph that must be reviewed', 'Search documentation'],
    ignored: ['product.title', 'computedAlt', 'a.png'],
  },
  {
    parser: 'svelte',
    filePath: 'Dynamic.svelte',
    source: `<h1>{title}</h1>
<p>Static Svelte paragraph</p>
<img alt={dynamicAlt} src="a.png" />
<input placeholder="Filter results" />
`,
    visible: ['Static Svelte paragraph', 'Filter results'],
    ignored: ['dynamicAlt', 'title', 'a.png'],
  },
  {
    parser: 'css',
    filePath: 'pseudo.css',
    source: `.required::after { content: " (required)"; }
.tooltip::before { content: "More information"; }
.spacer::after { content: " "; }
.dynamic::after { content: var(--label); }
.nested { .inner::after { content: "Nested rule text"; } }
`,
    visible: [' (required)', 'More information', 'Nested rule text'],
    ignored: ['var(--label)'],
  },
];
