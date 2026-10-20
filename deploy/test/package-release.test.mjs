import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { link, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createReviewPackage, MANIFEST_NAME, validateAllowlist } from '../package-release.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const cacheRoot = path.join(projectRoot, '.cache');
const templates = [
  { source: 'deploy/release-content/README.md', destination: 'README.md' },
  { source: 'deploy/release-content/LICENSE', destination: 'LICENSE' },
  'apps/mobile/LICENSE',
];
async function put(root, name, text) {
  const target = path.join(root, name);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, text);
}
async function fixture(t, files = ['src/main.js', '.env.example']) {
  await mkdir(cacheRoot, { recursive: true });
  const base = await mkdtemp(path.join(cacheRoot, 'release-package-test-'));
  const root = path.join(base, 'project');
  await mkdir(root);
  t.after(async () => {
    // Recursive removal is confined to the exact, freshly created fixture directory.
    const resolved = path.resolve(base);
    assert.equal(path.dirname(resolved), path.resolve(cacheRoot));
    assert.ok(path.basename(resolved).startsWith('release-package-test-'));
    assert.equal((await lstat(resolved)).isSymbolicLink(), false);
    await rm(resolved, { recursive: true, force: true });
  });
  await put(root, 'src/main.js', 'export const answer = 42;\n');
  await put(root, '.env.example', 'AGENT_AUTH_TOKEN=\nAGENT_RUNTIME=disabled\n');
  await put(root, 'deploy/release-content/README.md', 'Generic review documentation\n');
  await put(root, 'deploy/release-content/LICENSE', 'PROPOSED MIT LICENSE\n');
  await put(root, 'apps/mobile/LICENSE', 'Original Expo license notice\n');
  const entries = [...templates, ...files];
  const setAllowlist = async next => put(root, 'deploy/release-files.json', JSON.stringify({ schemaVersion: 1, files: next }));
  await setAllowlist(entries);
  return { base, root, entries, setAllowlist, outDir: path.join(base, 'review') };
}
async function allFiles(root, prefix = '') {
  const result = [];
  for (const entry of await readdir(path.join(root, prefix), { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) result.push(...await allFiles(root, relative));
    else result.push(relative);
  }
  return result.sort();
}
const code = expected => error => error.code === expected;

test('only explicit files enter the package; personal docs, credentials, signing and unlisted source stay out', async t => {
  const f = await fixture(t);
  const omitted = ['README.md', 'AGENTS.md', 'docs/personal-agent-baseline.md', '.env', '.env.production', 'deploy/deployment.env', '.secrets/auth.json', 'work/private.txt', '.git/config', '.cache/trace.log', 'artifacts/internal.apk', 'private.jks', 'src/unreviewed.js'];
  for (const name of omitted) await put(f.root, name, 'PRIVATE_FIXTURE_MARKER');
  const result = await createReviewPackage({ sourceRoot: f.root, outDir: f.outDir });
  assert.deepEqual(await allFiles(f.outDir), ['.env.example', 'LICENSE', 'README.md', MANIFEST_NAME, 'apps/mobile/LICENSE', 'src/main.js'].sort());
  assert.equal(await readFile(path.join(f.outDir, 'README.md'), 'utf8'), 'Generic review documentation\n');
  assert.equal(await readFile(path.join(f.outDir, 'apps/mobile/LICENSE'), 'utf8'), 'Original Expo license notice\n');
  assert.equal(result.manifest.publicationApproved, false);
  assert.equal(result.manifest.modelAuthorizationEligibility, 'not-verified-by-packaging');
  assert.equal(JSON.stringify(result.manifest).includes(f.root), false);
});

test('each payload has accurate SHA-256 and size, with no recursive manifest hash', async t => {
  const f = await fixture(t);
  const first = await createReviewPackage({ sourceRoot: f.root, outDir: f.outDir });
  const manifest = JSON.parse(await readFile(path.join(f.outDir, MANIFEST_NAME), 'utf8'));
  assert.equal(manifest.files.length, 5);
  assert.equal(manifest.files.some(file => file.path === MANIFEST_NAME), false);
  for (const entry of manifest.files) {
    const bytes = await readFile(path.join(f.outDir, entry.path));
    assert.equal(entry.bytes, bytes.length);
    assert.equal(entry.sha256, createHash('sha256').update(bytes).digest('hex'));
  }
  const second = await createReviewPackage({ sourceRoot: f.root, outDir: path.join(f.base, 'second') });
  assert.deepEqual(first.manifest, second.manifest);
});

test('existing output is never overwritten, including an empty directory', async t => {
  const f = await fixture(t);
  await mkdir(f.outDir);
  await assert.rejects(createReviewPackage({ sourceRoot: f.root, outDir: f.outDir }), code('OUTPUT_EXISTS'));
  await put(f.outDir, 'keep.txt', 'keep unchanged');
  await assert.rejects(createReviewPackage({ sourceRoot: f.root, outDir: f.outDir }), code('OUTPUT_EXISTS'));
  assert.equal(await readFile(path.join(f.outDir, 'keep.txt'), 'utf8'), 'keep unchanged');
});

test('source and destination traversal, absolute paths, ADS and globs are rejected before output creation', async t => {
  const f = await fixture(t);
  for (const unsafe of ['../outside.js', '/absolute.js', 'C:/outside.js', 'src/../../escape', 'src\\main.js', 'src//main.js', 'src/./main.js', 'src/main.js:secret', 'src/*.js', 'src/CON', 'src/name.']) {
    await f.setAllowlist([...templates, { source: unsafe, destination: 'safe.js' }]);
    await assert.rejects(createReviewPackage({ sourceRoot: f.root, outDir: f.outDir }), code('INVALID_PATH'));
    await f.setAllowlist([...templates, { source: 'src/main.js', destination: unsafe }]);
    await assert.rejects(createReviewPackage({ sourceRoot: f.root, outDir: f.outDir }), code('INVALID_PATH'));
  }
  await assert.rejects(lstat(f.outDir), { code: 'ENOENT' });
});

test('forbidden content categories cannot be opted in through allowlist edits', async t => {
  const f = await fixture(t);
  for (const forbidden of ['README.md', 'LICENSE', 'docs/anything.md', 'AGENTS.md', 'apps/mobile/AGENTS.md', '.env', '.env.production', 'deploy/deployment.env', '.git', '.git/config', '.data/profile.json', 'data/snapshot.json', '.secrets/token.txt', 'work/example.txt', '.cache/log.txt', 'private.p12', 'secret.key', 'agent.sqlite', 'auth.json', 'artifacts/build.apk', 'apps/mobile/android/build.gradle']) {
    await f.setAllowlist([...templates, { source: forbidden, destination: 'otherwise-safe.txt' }]);
    await assert.rejects(createReviewPackage({ sourceRoot: f.root, outDir: f.outDir }), code('FORBIDDEN_FILE'));
  }
});

test('case collisions, parent-file conflicts and missing license are rejected', () => {
  assert.throws(() => validateAllowlist({ schemaVersion: 1, files: [...templates, 'src/one.js', { source: 'src/one.js', destination: 'SRC/ONE.JS' }] }), code('DUPLICATE_DESTINATION'));
  assert.throws(() => validateAllowlist({ schemaVersion: 1, files: [...templates, 'folder', 'folder/file.js'] }), code('DESTINATION_CONFLICT'));
  assert.throws(() => validateAllowlist({ schemaVersion: 1, files: ['src/main.js'] }), code('REQUIRED_FILE_MISSING'));
  assert.throws(() => validateAllowlist({ schemaVersion: 1, files: [...templates, { source: 'src/main.js', destination: 'README.md' }] }), code('INVALID_TEMPLATE'));
});

test('intermediate source directory symlink / Windows junction is rejected', async t => {
  const f = await fixture(t);
  const outside = path.join(f.base, 'outside');
  await mkdir(outside);
  await put(outside, 'hidden.js', 'NOT_TO_BE_READ');
  await symlink(outside, path.join(f.root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await f.setAllowlist([...templates, 'linked/hidden.js']);
  await assert.rejects(createReviewPackage({ sourceRoot: f.root, outDir: f.outDir }), code('LINK_REJECTED'));
  await assert.rejects(lstat(f.outDir), { code: 'ENOENT' });
});

test('a linked source root and output parent are rejected', async t => {
  const f = await fixture(t);
  const linked = path.join(f.base, 'root-link');
  await symlink(f.root, linked, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(createReviewPackage({ sourceRoot: linked, outDir: f.outDir }), code('LINK_REJECTED'));
  await assert.rejects(createReviewPackage({ sourceRoot: f.root, outDir: path.join(linked, 'new-output') }), code('LINK_REJECTED'));
});

test('final source-file symlinks are rejected when platform permits creating them', async t => {
  const f = await fixture(t);
  try { await symlink(path.join(f.root, 'src/main.js'), path.join(f.root, 'linked.js'), 'file'); }
  catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) { t.skip('Windows account cannot create file symlinks; directory-junction rejection is tested separately.'); return; }
    throw error;
  }
  await f.setAllowlist([...templates, 'linked.js']);
  await assert.rejects(createReviewPackage({ sourceRoot: f.root, outDir: f.outDir }), code('LINK_REJECTED'));
});

test('hard-linked source files are rejected', async t => {
  const f = await fixture(t);
  await link(path.join(f.root, 'src/main.js'), path.join(f.root, 'second.js'));
  await assert.rejects(createReviewPackage({ sourceRoot: f.root, outDir: f.outDir }), code('HARDLINK_REJECTED'));
});

test('source files must exist and be regular files; failures leave no output', async t => {
  const f = await fixture(t);
  await f.setAllowlist([...templates, 'missing.js']);
  await assert.rejects(createReviewPackage({ sourceRoot: f.root, outDir: f.outDir }), code('SOURCE_UNAVAILABLE'));
  await mkdir(path.join(f.root, 'directory'));
  await f.setAllowlist([...templates, 'directory']);
  await assert.rejects(createReviewPackage({ sourceRoot: f.root, outDir: f.outDir }), code('NOT_FILE'));
  await assert.rejects(lstat(f.outDir), { code: 'ENOENT' });
});

test('output cannot replace a source root or ancestor, and requires a real existing parent', async t => {
  const f = await fixture(t);
  await assert.rejects(createReviewPackage({ sourceRoot: f.root, outDir: f.root }), code('OUTPUT_BOUNDARY'));
  await assert.rejects(createReviewPackage({ sourceRoot: f.root, outDir: f.base }), code('OUTPUT_BOUNDARY'));
  await assert.rejects(createReviewPackage({ sourceRoot: f.root, outDir: path.join(f.base, 'missing-parent', 'review') }), code('SOURCE_UNAVAILABLE'));
});

test('malformed JSON is redacted in CLI errors, including parser excerpts', async t => {
  const f = await fixture(t);
  await put(f.root, 'deploy/package-release.mjs', await readFile(new URL('../package-release.mjs', import.meta.url)));
  await put(f.root, 'deploy/release-files.json', '{PRIVATE_FIXTURE_MARKER_DO_NOT_PRINT');
  const result = spawnSync(process.execPath, [path.join(f.root, 'deploy/package-release.mjs'), '--out', f.outDir], { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /INVALID_ALLOWLIST/);
  assert.equal(`${result.stdout}${result.stderr}`.includes('PRIVATE_FIXTURE_MARKER_DO_NOT_PRINT'), false);
  await assert.rejects(lstat(f.outDir), { code: 'ENOENT' });
});
test('server-core scope rejects clients and artwork even when renamed by the allowlist', () => {
  const coreTemplates = templates.filter(entry => entry !== 'apps/mobile/LICENSE');
  for (const outside of ['apps/mobile/src/brand.ts', 'apps/desktop/main.cjs', 'assets/dragon.png', 'brand/mascot.webp', 'app.ico', 'icon.svg']) {
    assert.throws(() => validateAllowlist({ schemaVersion: 1, scope: 'server-core', files: [...coreTemplates, { source: outside, destination: 'src/included.txt' }] }), code('OUTSIDE_SCOPE'));
    assert.throws(() => validateAllowlist({ schemaVersion: 1, scope: 'server-core', files: [...coreTemplates, { source: 'src/main.js', destination: outside }] }), code('OUTSIDE_SCOPE'));
  }
  assert.throws(() => validateAllowlist({ schemaVersion: 1, scope: 'unknown', files: coreTemplates }), code('INVALID_SCOPE'));
  assert.doesNotThrow(() => validateAllowlist({ schemaVersion: 1, scope: 'server-core', files: [...coreTemplates, 'apps/server/src/main.ts'] }));
  assert.throws(() => validateAllowlist({ schemaVersion: 1, files: [...coreTemplates, 'apps/mobile/src/main.ts'] }), code('REQUIRED_FILE_MISSING'));
});

test('core package preserves overrides and can reproduce its own byte-identical payload', async t => {
  const f = await fixture(t);
  const coreTemplates = templates.filter(entry => entry !== 'apps/mobile/LICENSE');
  const files = [...coreTemplates, 'deploy/release-content/README.md', 'deploy/release-content/LICENSE', 'deploy/release-files.json',
    { source: 'deploy/release-content/package.json', destination: 'package.json' }, 'deploy/release-content/package.json', 'src/main.js'];
  await put(f.root, 'deploy/release-content/package.json', '{"private":true,"workspaces":["apps/server","packages/contracts"]}\n');
  await put(f.root, 'deploy/release-files.json', JSON.stringify({ schemaVersion: 1, scope: 'server-core', files }));
  const first = await createReviewPackage({ sourceRoot: f.root, outDir: f.outDir });
  const second = await createReviewPackage({ sourceRoot: f.outDir, outDir: path.join(f.base, 'repacked') });
  assert.equal(first.manifest.scope, 'server-core');
  assert.equal(first.manifest.files.some(file => file.path.startsWith('apps/mobile/')), false);
  assert.deepEqual(first.manifest, second.manifest);
  assert.equal(await readFile(path.join(f.outDir, 'package.json'), 'utf8'), await readFile(path.join(f.root, 'deploy/release-content/package.json'), 'utf8'));
});

test('explicit release metadata survives a local repackage while default fixtures remain in review mode', async t => {
  const f = await fixture(t);
  const checkedIn = JSON.parse(await readFile(path.join(projectRoot, 'deploy/release-files.json'), 'utf8'));
  const files = [...templates, 'deploy/release-content/README.md', 'deploy/release-content/LICENSE', 'deploy/release-files.json', 'src/main.js'];
  await put(f.root, 'deploy/release-content/LICENSE', 'MIT License\n');
  await put(f.root, 'deploy/release-files.json', JSON.stringify({ schemaVersion: 1, files, release: checkedIn.release }));
  const first = await createReviewPackage({ sourceRoot: f.root, outDir: f.outDir });
  const second = await createReviewPackage({ sourceRoot: f.outDir, outDir: path.join(f.base, 'repacked') });
  assert.equal(first.manifest.purpose, 'local-source-release');
  assert.equal(first.manifest.publicationApproved, true);
  assert.equal(first.manifest.licenseStatus, 'MIT');
  assert.equal(first.manifest.repository, checkedIn.release.repository);
  assert.equal(first.manifest.modelAuthorizationEligibility, 'not-verified-by-packaging');
  assert.deepEqual(first.manifest, second.manifest);
  assert.equal((await allFiles(f.outDir)).some(name => name.startsWith('.github/')), false);
});

test('incomplete or invalid release metadata is rejected before creating output', async t => {
  const f = await fixture(t);
  const checkedIn = JSON.parse(await readFile(path.join(projectRoot, 'deploy/release-files.json'), 'utf8'));
  const valid = checkedIn.release;
  const invalid = [null, [], true, {}, { license: 'MIT' }, { repository: valid.repository },
    { ...valid, license: 'UNLICENSED' }, { ...valid, approved: true },
    { ...valid, repository: valid.repository.replace('https:', 'http:') },
    { ...valid, repository: valid.repository.replace('github.com', 'github.com.example.invalid') },
    { ...valid, repository: valid.repository.replace('https://', 'https://user@') },
    { ...valid, repository: `${valid.repository}?token=fixture` },
    { ...valid, repository: `${valid.repository}#fragment` },
    { ...valid, repository: `${valid.repository}/extra` }];
  for (const release of invalid) {
    await put(f.root, 'deploy/release-files.json', JSON.stringify({ schemaVersion: 1, files: f.entries, release }));
    await assert.rejects(createReviewPackage({ sourceRoot: f.root, outDir: f.outDir }), code('INVALID_RELEASE'));
    await assert.rejects(lstat(f.outDir), { code: 'ENOENT' });
  }
});

test('release payload has an active MIT license, matching templates, and only an inert CI template', async () => {
  const raw = JSON.parse(await readFile(path.join(projectRoot, 'deploy/release-files.json'), 'utf8'));
  const entries = validateAllowlist(raw);
  assert.equal(raw.release.license, 'MIT');
  assert.equal(entries.some(entry => [entry.source, entry.destination].some(name => name.startsWith('.github/workflows/'))), false);
  assert.ok(entries.some(entry => entry.source === 'deploy/release-content/ci.yml' && entry.destination === entry.source));
  await assert.rejects(lstat(path.join(projectRoot, '.github/workflows/ci.yml')), { code: 'ENOENT' });
  for (const filename of ['LICENSE', 'README.md']) {
    const root = await readFile(path.join(projectRoot, filename), 'utf8');
    assert.equal(root, await readFile(path.join(projectRoot, 'deploy/release-content', filename), 'utf8'));
    if (filename === 'LICENSE') assert.match(root, /^MIT License\r?\n/u);
    else assert.ok(root.includes(raw.release.repository));
  }
});

test('checked-in core release graph has matching lockfile, both workspaces and all repackage inputs', async () => {
  const readJson = async name => JSON.parse((await readFile(path.join(projectRoot, name), 'utf8')).replace(/^\uFEFF/u, ''));
  const raw = await readJson('deploy/release-files.json');
  assert.equal(raw.scope, 'server-core');
  const entries = validateAllowlist(raw);
  const destinations = new Set(entries.map(entry => entry.destination));
  for (const entry of entries) assert.ok(destinations.has(entry.source), `Repackage source missing: ${entry.source}`);
  const manifest = await readJson('deploy/release-content/package.json');
  const lock = await readJson('deploy/release-content/package-lock.json');
  assert.deepEqual(manifest.workspaces, ['apps/server', 'packages/contracts']);
  assert.deepEqual(lock.packages[''].workspaces, manifest.workspaces);
  assert.deepEqual(lock.packages[''].devDependencies, manifest.devDependencies);
  for (const workspace of manifest.workspaces) {
    assert.ok(destinations.has(`${workspace}/package.json`));
    const source = await readJson(`${workspace}/package.json`);
    assert.equal(lock.packages[workspace].version, source.version);
    assert.deepEqual(lock.packages[workspace].dependencies, source.dependencies);
  }
  assert.equal(Object.keys(lock.packages).some(name => /(?:apps\/(?:mobile|desktop))|(?:node_modules\/(?:expo|react-native|electron)(?:\/|$))/u.test(name)), false);
  assert.equal(entries.find(entry => entry.destination === 'package.json').source, 'deploy/release-content/package.json');
  assert.equal(entries.find(entry => entry.destination === 'package-lock.json').source, 'deploy/release-content/package-lock.json');
});

test('core allowlist covers all server and contract code without silently adding new files', async () => {
  const raw = JSON.parse((await readFile(path.join(projectRoot, 'deploy/release-files.json'), 'utf8')).replace(/^\uFEFF/u, ''));
  const destinations = new Set(validateAllowlist(raw).map(entry => entry.destination));
  for (const directory of ['apps/server/src', 'apps/server/test', 'packages/contracts/src']) {
    for (const file of await allFiles(path.join(projectRoot, directory))) {
      if (/\.(?:[cm]?[jt]s|json)$/u.test(file)) assert.ok(destinations.has(`${directory}/${file}`), `Review a new core source before adding it: ${directory}/${file}`);
    }
  }
});

test('core Docker templates retain current cloud changes while removing mobile build inputs', async () => {
  const text = async name => (await readFile(path.join(projectRoot, name), 'utf8')).replace(/^\uFEFF/u, '').replace(/\r\n/gu, '\n');
  const expectedDocker = (await text('deploy/Dockerfile'))
    .replace('COPY apps/mobile/package.json ./apps/mobile/package.json\n', '')
    .replace('# Select server workspaces, with root compiler/test dependencies. Do not install\n# the mobile application merely because it lives in the same lockfile.', '# Install only the two core workspaces and their root build dependencies.')
    .replace('# The shared mobile lockfile marks TypeScript as devOptional. Omit optional\n# packages too; the current server has no required optional runtime dependency.', '# The core runtime has no required optional dependency; keep the image minimal.');
  assert.equal(await text('deploy/release-content/Dockerfile'), expectedDocker);
  const expectedIgnore = (await text('deploy/Dockerfile.dockerignore')).replace('!apps/mobile/\n', '').replace('!apps/mobile/package.json\n', '');
  assert.equal(await text('deploy/release-content/Dockerfile.dockerignore'), expectedIgnore);
});
