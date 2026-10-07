// One-time, source-only extraction. Never run against an existing destination tree.
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, lstatSync } from 'node:fs';
import { resolve, dirname, relative, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(process.argv[2] ?? '');
if (!process.argv[2] || !existsSync(join(source, 'account-service/go.mod'))) throw new Error('Pass the KissOpen product source directory');
if (existsSync(join(root, 'packages'))) throw new Error('Extraction already exists; refusing to overwrite');
const manifest = [];
function copy(from, to) {
  const stat = lstatSync(from);
  if (stat.isSymbolicLink()) throw new Error(`Symlink refused: ${relative(source, from)}`);
  if (stat.isDirectory()) {
    for (const name of readdirSync(from).sort()) {
      if (['node_modules', 'dist', '.git', 'data', '.local'].includes(name)) continue;
      copy(join(from, name), join(to, name));
    }
    return;
  }
  if (!stat.isFile()) throw new Error('Only regular source files are allowed');
  if (/\.(pem|key|p8|p12|db|sqlite|log)$/.test(from) || /\/\.env(?:\.|$)/.test(from)) throw new Error('Runtime file refused');
  const bytes = readFileSync(from);
  mkdirSync(dirname(to), { recursive: true });
  writeFileSync(to, bytes, { flag: 'wx' });
  manifest.push({ source: relative(source, from), destination: relative(root, to), sha256: createHash('sha256').update(bytes).digest('hex') });
}
for (const [pkg, files] of Object.entries({
  'kissopen-server': ['sources', 'prisma', 'package.json', 'tsconfig.json', 'tsconfig.build.json', 'vitest.config.ts'],
  'kissopen-wire': ['src', 'package.json', 'tsconfig.json', 'vitest.config.ts'],
  'kissopen-server-self-host': ['bin', 'index.cjs', 'package.json', 'scripts/build-runtime.cjs', 'scripts/postinstall.cjs'],
})) {
  for (const file of files) copy(join(source, 'kissopen/packages', pkg, file), join(root, 'packages', pkg, file));
}
copy(join(source, 'kissopen/LICENSE'), join(root, 'LICENSE'));
for (const file of ['apiTypes.ts', 'profile.ts', 'friendTypes.ts', 'feedTypes.ts', 'sessionAvatarTypes.ts']) {
  copy(join(source, 'kissopen/packages/kissopen-sync/sources', file), join(root, 'packages/kissopen-server/sources/test-contract', file));
}
for (const file of ['go.mod', 'go.sum']) copy(join(source, 'account-service', file), join(root, 'accounts', file));
// Sanitise package metadata and keep the local candidate unpublishable by accident.
for (const pkg of ['kissopen-server', 'kissopen-wire', 'kissopen-server-self-host']) {
  const path = join(root, 'packages', pkg, 'package.json');
  const value = JSON.parse(readFileSync(path));
  value.private = true;
  value.homepage = 'https://kissopen.com';
  delete value.repository; delete value.bugs; delete value.publishConfig;
  delete value.scripts.prepublishOnly; delete value.scripts.release;
  if (pkg === 'kissopen-server') {
    value.scripts = {
      typecheck: 'tsc --noEmit', build: 'tsc --noEmit -p tsconfig.build.json',
      start: 'tsx ./sources/main.ts', standalone: 'tsx ./sources/standalone.ts',
      migrate: 'tsx ./sources/standalone.ts migrate', serve: 'tsx ./sources/standalone.ts serve',
      test: 'vitest run', generate: 'prisma generate --schema=prisma/schema.prisma',
      postinstall: 'prisma generate --schema=prisma/schema.prisma',
    };
  }
  if (pkg === 'kissopen-wire') {
    delete value.devDependencies['release-it'];
    value.scripts.test = 'vitest run';
  }
  if (pkg === 'kissopen-server-self-host') {
    delete value.scripts['bundle:webapp'];
    value.scripts.build = 'pnpm --filter kissopen-server build && node scripts/build-runtime.cjs';
    value.description = 'Standalone KissOpen encrypted relay runtime';
  }
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
}
const spec = join(root, 'packages/kissopen-server/sources/app/api/routes/machinesRoutes.spec.ts');
writeFileSync(spec, readFileSync(spec, 'utf8').replace('../../../../../kissopen-sync/sources/apiTypes', '../../../test-contract/apiTypes'));
const mod = join(root, 'accounts/go.mod');
writeFileSync(mod, readFileSync(mod, 'utf8').replace('module github.com/nodeloc/kissopen', 'module kissopen.local/accounts'));
writeFileSync(join(root, 'EXTRACTION.json'), JSON.stringify({
  projectName: 'kissopen-server', sourceProject: 'kissopen', historyIncluded: false,
  published: false, releaseReady: false, sourceSnapshot: manifest,
  excluded: ['runtime secrets and data', 'commercial Git history', 'cloud Agent execution', 'billing and payments', 'boards', 'cloud scheduling'],
}, null, 2) + '\n');
console.log(`Extracted ${manifest.length} source files. Account handlers are selected separately; no runtime data copied.`);
