/* Everything the first paint imports must be in the worker's shell.

   The shell is a hand-written list, and the boot graph is not: a module added
   to it is discovered by the browser at runtime, which works perfectly online
   and fails on the one visit that matters. tokens.js was added to the graph and
   not to the list, so an install that happened offline would have booted into a
   missing import.

   Rather than ask anyone to remember, this walks the static imports out of the
   entry points and checks the list covers them. Lazily imported screens are
   deliberately excluded — they are fetched on demand and cached as they arrive,
   which is the whole reason the shell is small. */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const web = path.resolve(here, '..');

const shell = (() => {
  const sw = fs.readFileSync(path.join(web, 'sw.js'), 'utf8');
  const block = /const SHELL = \[([\s\S]*?)\];/.exec(sw)?.[1] || '';
  return new Set([...block.matchAll(/'([^']+)'/g)].map(m => m[1]));
})();

/** Static `import ... from './x.js'` only — dynamic import() is the lazy path. */
function staticImports(file) {
  const src = fs.readFileSync(file, 'utf8');
  return [...src.matchAll(/^\s*import\s+(?:[\s\S]*?from\s+)?'([^']+)'/gm)]
    .map(m => m[1])
    .filter(spec => spec.startsWith('.'))
    .map(spec => path.resolve(path.dirname(file), spec));
}

const seen = new Set();
const walk = file => {
  if (seen.has(file) || !fs.existsSync(file)) return;
  seen.add(file);
  staticImports(file).forEach(walk);
};
walk(path.join(web, 'js', 'app.js'));

const missing = [...seen]
  .map(file => '/' + path.relative(web, file).split(path.sep).join('/'))
  .filter(url => !shell.has(url))
  .sort();

console.log('\nService worker shell against the boot graph\n');
console.log(`  boot graph: ${seen.size} modules`);
console.log(`  shell     : ${shell.size} entries`);

if (missing.length) {
  console.log('\n  These load on first paint but are not precached:');
  missing.forEach(m => console.log(`  FAIL ${m}`));
  console.log(`\n${missing.length} missing\n`);
  process.exit(1);
}
console.log('\n  ok   every statically imported module is in the shell\n');
