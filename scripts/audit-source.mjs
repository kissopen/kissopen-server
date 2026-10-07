// Source hygiene check; report file paths/rule names only, never matching secrets.
import { readdirSync, lstatSync, readFileSync } from 'node:fs';
import { join, resolve, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const skip = new Set(['node_modules', '.git', '.local', 'dist', 'data', 'plugin-catalog']);
const findings = []; let files = 0;
const rules = [
 ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
 ['github-token', /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/],
 ['google-secret', /\bGOCSPX-[A-Za-z0-9_-]{20,}\b/],
 ['commercial-host', /114\.55\.128\.20|api\.firstcache\.cc/],
 ['operator-home-path', /\/Users\/junle\//],
];
function visit(path) {
 for (const name of readdirSync(path)) {
  if (skip.has(name)) continue;
  const full=join(path,name), rel=relative(root,full), stat=lstatSync(full);
  if (stat.isSymbolicLink()) { findings.push([rel,'symlink']); continue; }
  if (stat.isDirectory()) { visit(full); continue; }
  if (/^\.env(?:\.|$)/.test(name) && !name.endsWith('.example')) findings.push([rel,'private-environment']);
  if (/\.(?:p12|p8|key|pem|sqlite|db|log)$/.test(name)) findings.push([rel,'runtime-or-credential-file']);
  if (!stat.isFile()) { findings.push([rel,'non-source-file']); continue; }
  const text=readFileSync(full,'utf8'); files++;
  // This checker contains the signatures it detects, not deployed values.
  if (rel==='scripts/audit-source.mjs') continue;
  for (const [rule,pattern] of rules) if (pattern.test(text)) findings.push([rel,rule]);
  if (rel.startsWith('accounts/internal/app/')) {
   for (const pattern of [/func .*\b(?:payRoutes|agentRoutes|cloudEnsure|RunWorker|schedulingRoutes|homeDemo)\b/, /"\/api\/(?:pay|billing|agent\/v1|schedules)(?:\/|\")/]) {
    if (pattern.test(text) && !name.endsWith('_test.go')) findings.push([rel,'commercial-handler']);
   }
  }
 }
}
visit(root);
if (findings.length) { for(const [file,rule] of findings) console.error(`${rule}: ${file}`); process.exitCode=1; }
else console.log(`Source hygiene passed (${files} files). Human security/license review is still required.`);
