import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const names = await readdir('packages');
const graph = new Map();
async function files(dir) {
  const result = [];
  for (const item of await readdir(dir, { withFileTypes: true })) {
    if (['node_modules', 'dist', '.next'].includes(item.name)) continue;
    const p = path.join(dir, item.name);
    if (item.isDirectory()) result.push(...await files(p));
    else if (/\.[cm]?[jt]sx?$/.test(p)) result.push(p);
  }
  return result;
}
for (const name of names) {
  const manifest = JSON.parse(await readFile(`packages/${name}/package.json`, 'utf8'));
  const deps = Object.keys(manifest.dependencies ?? {});
  graph.set(name, deps.filter(d => d.startsWith('@humanize/')).map(d => d.slice(10)));
  if (name === 'review' && deps.some(d => ['@humanize/db', '@humanize/github', '@humanize/providers'].includes(d))) throw Error('Review must use ports');
  for (const file of await files(`packages/${name}/src`)) {
    const source = await readFile(file, 'utf8');
    for (const [, target] of source.matchAll(/(?:from\s*|import\s*\()\s*['"]([^'"]+)['"]/g)) {
      if (target.startsWith('@humanize/testing') && name !== 'testing') throw Error(`${file}: production testing import`);
      if (target.startsWith('@humanize/') && !deps.includes(target)) throw Error(`${file}: undeclared ${target}`);
      if (target.startsWith('../../')) throw Error(`${file}: relative package boundary escape`);
    }
  }
}
function visit(name, ancestors = []) {
  if (ancestors.includes(name)) throw Error(`Package cycle: ${[...ancestors, name].join(' -> ')}`);
  for (const next of graph.get(name) ?? []) visit(next, [...ancestors, name]);
}
for (const name of names) visit(name);
console.log(`Package boundaries verified: ${names.length} packages`);
