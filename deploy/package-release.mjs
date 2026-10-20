#!/usr/bin/env node
/**
 * Creates a local source package from explicit file entries only.
 * Defaults to review metadata; release metadata must be explicitly configured.
 * No Git discovery, glob expansion, source-tree traversal, network, or publishing.
 * Run against a quiescent checkout owned by the caller; filesystem checks do not
 * replace an OS security boundary against a hostile concurrent directory writer.
 */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const MANIFEST_NAME = 'REVIEW-MANIFEST.json';
const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const forbiddenDirectories = new Set(['.git', '.secrets', 'secrets', '.data', 'data', 'logs', '.cache', 'cache', '.gradle', 'coverage', '.toolchains', 'work', 'docs', 'artifacts', 'outputs', 'node_modules', 'dist', 'dist-web', 'dist-android', 'dist-ios', '.expo']);

export class ReviewPackageError extends Error {
  constructor(code, message) { super(message); this.name = 'ReviewPackageError'; this.code = code; }
}
function refuse(code, message) { throw new ReviewPackageError(code, message); }
function comparable(value) { return process.platform === 'win32' ? value.toLowerCase() : value; }
function inside(root, target) {
  const relative = path.relative(root, target);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
function portablePath(value) {
  if (typeof value !== 'string' || !value || value.length > 512 || /[\\\x00-\x1f\x7f<>:"|?*]/u.test(value) || path.posix.isAbsolute(value)) {
    refuse('INVALID_PATH', '清单路径必须是可移植的相对文件路径。');
  }
  const segments = value.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..' || /[. ]$/u.test(segment) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(segment))) {
    refuse('INVALID_PATH', '清单包含越界、空片段或保留名称。');
  }
  return segments;
}
function permittedPath(value, kind) {
  const segments = portablePath(value);
  const lower = segments.map(segment => segment.toLowerCase());
  const basename = lower.at(-1);
  if (lower.some(segment => forbiddenDirectories.has(segment)) || basename === 'agents.md' || basename === MANIFEST_NAME.toLowerCase()) {
    refuse('FORBIDDEN_FILE', '清单包含禁止打包的目录或管理文件。');
  }
  if ((basename.startsWith('.env') || /(?:^|\.)env(?:\.|$)/u.test(basename)) && !basename.endsWith('.example')) {
    refuse('FORBIDDEN_FILE', '仅允许环境配置示例文件进入审阅包。');
  }
  if (/\.(apk|aab|jks|keystore|p12|pfx|pem|key|sqlite|sqlite3|db|log)$/u.test(basename) || /^(auth|credentials|tokens?|signing)\.json$/u.test(basename)) {
    refuse('FORBIDDEN_FILE', '清单包含凭据、签名材料、运行数据或构建产物。');
  }
  if (kind === 'source' && lower.length === 1 && ['readme.md', 'license'].includes(basename)) {
    refuse('FORBIDDEN_FILE', '包根说明与许可证必须使用通用审阅模板。');
  }
  if (lower.length >= 3 && lower[0] === 'apps' && lower[1] === 'mobile' && ['android', 'ios'].includes(lower[2])) {
    refuse('FORBIDDEN_FILE', '生成的原生工程不进入源代码审阅包。');
  }
  return segments;
}
export function validateAllowlist(raw) {
  if (!raw || typeof raw !== 'object' || raw.schemaVersion !== 1 || !Array.isArray(raw.files) || !raw.files.length || raw.files.length > 5000) {
    refuse('INVALID_ALLOWLIST', '不支持的白名单格式或文件数量。');
  }
  if (raw.scope !== undefined && raw.scope !== 'server-core') refuse('INVALID_SCOPE', '不支持的审阅包范围。');
  if (raw.release !== undefined && (!raw.release || typeof raw.release !== 'object' || Array.isArray(raw.release)
    || Object.keys(raw.release).some(key => !['license', 'repository'].includes(key))
    || raw.release.license !== 'MIT' || typeof raw.release.repository !== 'string'
    || !/^https:\/\/github\.com\/[a-z0-9-]+\/[a-z0-9._-]+$/iu.test(raw.release.repository))) {
    refuse('INVALID_RELEASE', '发布元数据必须明确包含 MIT 许可与有效的 GitHub 仓库地址。');
  }
  const destinations = new Set();
  const entries = raw.files.map(item => {
    const entry = typeof item === 'string' ? { source: item, destination: item } : item;
    if (!entry || typeof entry !== 'object' || Object.keys(entry).some(key => !['source', 'destination'].includes(key))) {
      refuse('INVALID_ALLOWLIST', '白名单条目只能包含 source 和 destination。');
    }
    permittedPath(entry.source, 'source');
    permittedPath(entry.destination, 'destination');
    if (raw.scope === 'server-core' && [entry.source, entry.destination].some(value => /^(?:apps\/(?:mobile|desktop)(?:\/|$))|\.(?:png|jpe?g|webp|gif|svg|ico|icns|mp[34]|wav|woff2?|ttf|otf)$/iu.test(value))) {
      refuse('OUTSIDE_SCOPE', '服务端核心审阅包不收录客户端或美术媒体资源。');
    }
    if (['readme.md', 'license'].includes(entry.destination.toLowerCase()) && entry.source !== `deploy/release-content/${entry.destination.toLowerCase() === 'readme.md' ? 'README.md' : 'LICENSE'}`) {
      refuse('INVALID_TEMPLATE', '包根 README/LICENSE 必须来自指定的通用模板。');
    }
    const key = entry.destination.normalize('NFC').toLowerCase();
    if (destinations.has(key)) refuse('DUPLICATE_DESTINATION', '白名单目标路径重复或大小写冲突。');
    destinations.add(key);
    return { source: entry.source, destination: entry.destination };
  });
  // A file must never double as the parent directory of another destination.
  for (const key of destinations) {
    const parts = key.split('/');
    for (let index = 1; index < parts.length; index++) {
      if (destinations.has(parts.slice(0, index).join('/'))) refuse('DESTINATION_CONFLICT', '白名单存在文件与目录冲突。');
    }
  }
  const required = [
    ['README.md', 'deploy/release-content/README.md'],
    ['LICENSE', 'deploy/release-content/LICENSE'],
  ];
  if (entries.some(entry => [entry.source, entry.destination].some(value => value.startsWith('apps/mobile/')))) {
    required.push(['apps/mobile/LICENSE', 'apps/mobile/LICENSE']);
  }
  for (const [destination, source] of required) {
    if (!entries.some(entry => entry.destination === destination && entry.source === source)) {
      refuse('REQUIRED_FILE_MISSING', '必须保留通用根说明、许可证及所收录客户端的原许可证。');
    }
  }
  return entries.sort((left, right) => left.destination < right.destination ? -1 : left.destination > right.destination ? 1 : 0);
}
async function safeLstat(filename) {
  try { return await lstat(filename); }
  catch { refuse('SOURCE_UNAVAILABLE', '所需路径不存在或无法安全检查；没有输出文件内容。'); }
}
async function assertDirectoryChain(directory) {
  const absolute = path.resolve(directory);
  const volume = path.parse(absolute).root;
  let cursor = volume;
  const parts = absolute.slice(volume.length).split(path.sep).filter(Boolean);
  for (const segment of ['', ...parts]) {
    if (segment) cursor = path.join(cursor, segment);
    const stat = await safeLstat(cursor);
    if (stat.isSymbolicLink()) refuse('LINK_REJECTED', '拒绝符号链接或目录联接。');
    if (!stat.isDirectory()) refuse('NOT_DIRECTORY', '路径的中间层不是普通目录。');
  }
  return absolute;
}
async function plainSource(root, relative) {
  const segments = portablePath(relative);
  const absolute = path.resolve(root, ...segments);
  if (!inside(root, absolute)) refuse('PATH_ESCAPE', '源路径超出项目边界。');
  await assertDirectoryChain(path.dirname(absolute));
  const stat = await safeLstat(absolute);
  if (stat.isSymbolicLink()) refuse('LINK_REJECTED', '拒绝符号链接或目录联接。');
  if (!stat.isFile()) refuse('NOT_FILE', '白名单源必须是普通文件。');
  if (stat.nlink > 1) refuse('HARDLINK_REJECTED', '拒绝具有多个硬链接的源文件。');
  const resolved = await realpath(absolute);
  if (comparable(resolved) !== comparable(absolute)) refuse('PATH_ESCAPE', '源文件解析路径不匹配。');
  return { absolute, stat };
}
async function readStableSource(root, relative) {
  const before = await plainSource(root, relative);
  if (before.stat.size > MAX_FILE_BYTES) refuse('FILE_TOO_LARGE', '单个文件超过审阅包大小限制。');
  let handle;
  try {
    // O_NOFOLLOW also prevents a final-component swap on supporting platforms.
    handle = await open(before.absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    const checked = await plainSource(root, relative);
    if (!opened.isFile() || opened.ino !== before.stat.ino || opened.dev !== before.stat.dev || opened.ino !== checked.stat.ino || opened.dev !== checked.stat.dev) {
      refuse('SOURCE_CHANGED', '检查期间源文件发生变化，请停写后重试。');
    }
    const data = await handle.readFile();
    const after = await handle.stat();
    await plainSource(root, relative);
    if (data.length > MAX_FILE_BYTES || opened.size !== after.size || opened.mtimeMs !== after.mtimeMs || data.length !== after.size) {
      refuse('SOURCE_CHANGED', '读取期间源文件发生变化，请停写后重试。');
    }
    return data;
  } catch (error) {
    if (error instanceof ReviewPackageError) throw error;
    refuse('SOURCE_UNAVAILABLE', '源文件无法安全读取；没有输出文件内容。');
  } finally { await handle?.close(); }
}
async function assertNewOutput(root, output) {
  const absolute = path.resolve(output);
  if (comparable(absolute) === comparable(root) || inside(absolute, root)) refuse('OUTPUT_BOUNDARY', '输出不能是项目根或其祖先。');
  await assertDirectoryChain(path.dirname(absolute));
  try { await lstat(absolute); }
  catch (error) {
    if (error.code === 'ENOENT') return absolute;
    refuse('OUTPUT_UNAVAILABLE', '无法安全检查输出目录。');
  }
  refuse('OUTPUT_EXISTS', '输出目录已存在；为保留已有文件，请选择一个新目录。');
}
async function destinationParent(output, relative) {
  const parts = portablePath(relative);
  let parent = output;
  for (const segment of parts.slice(0, -1)) {
    parent = path.join(parent, segment);
    try { await mkdir(parent); }
    catch (error) { if (error.code !== 'EEXIST') refuse('WRITE_FAILED', '无法创建审阅包目录。'); }
    await assertDirectoryChain(parent);
  }
  await assertDirectoryChain(parent);
  const target = path.join(parent, parts.at(-1));
  if (!inside(output, target)) refuse('PATH_ESCAPE', '输出路径超出新目录边界。');
  return target;
}
export async function createReviewPackage({ sourceRoot = DEFAULT_ROOT, outDir, allowlist = 'deploy/release-files.json' } = {}) {
  if (typeof outDir !== 'string' || !outDir.trim()) refuse('OUTPUT_REQUIRED', '必须通过 --out 指定全新的输出目录。');
  const root = await assertDirectoryChain(sourceRoot);
  const output = await assertNewOutput(root, outDir);
  permittedPath(allowlist, 'source');
  let raw;
  try { raw = JSON.parse((await readStableSource(root, allowlist)).toString('utf8').replace(/^\uFEFF/u, '')); }
  catch (error) {
    if (error instanceof ReviewPackageError) throw error;
    refuse('INVALID_ALLOWLIST', '白名单不是有效 JSON；没有输出解析内容。');
  }
  const entries = validateAllowlist(raw);
  const payload = [];
  let totalBytes = 0;
  // Finish validation and snapshot the selected bytes before creating output.
  for (const entry of entries) {
    const data = await readStableSource(root, entry.source);
    totalBytes += data.length;
    if (totalBytes > MAX_TOTAL_BYTES) refuse('PACKAGE_TOO_LARGE', '审阅包超过总大小限制。');
    payload.push({ ...entry, data, sha256: createHash('sha256').update(data).digest('hex') });
  }
  await assertNewOutput(root, output);
  try { await mkdir(output); }
  catch { refuse('OUTPUT_EXISTS', '无法独占创建输出目录；已有内容不会被覆盖。'); }
  try {
    for (const entry of payload) {
      const target = await destinationParent(output, entry.destination);
      await writeFile(target, entry.data, { flag: 'wx', mode: 0o644 });
    }
    const manifest = {
      schemaVersion: 1,
      purpose: raw.release ? 'local-source-release' : 'local-source-review-only',
      scope: raw.scope ?? 'explicit-source-allowlist',
      publicationApproved: Boolean(raw.release),
      licenseStatus: raw.release?.license ?? 'proposed-mit-pending-owner-approval',
      ...(raw.release ? { repository: raw.release.repository } : {}),
      modelAuthorizationEligibility: 'not-verified-by-packaging',
      coverage: 'payload files only; this manifest does not hash itself',
      files: payload.map(entry => ({ path: entry.destination, bytes: entry.data.length, sha256: entry.sha256 })),
    };
    await writeFile(await destinationParent(output, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o644 });
    return { output, fileCount: payload.length, totalBytes, manifest };
  } catch (error) {
    if (error instanceof ReviewPackageError) throw error;
    refuse('WRITE_FAILED', '写入失败；可能留下未完成目录。未覆盖已有文件，请保留现场并改用新目录。');
  }
}
export async function runCli(argv) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) {
    console.log('本地源码打包（不会上传或推送）\n用法：node deploy/package-release.mjs --out <全新目录>\n输出父目录必须已存在。运行时请保持源码停止修改。');
    return;
  }
  if (argv.length !== 2 || argv[0] !== '--out' || !argv[1]) refuse('ARGUMENTS', '用法：node deploy/package-release.mjs --out <全新目录>');
  const result = await createReviewPackage({ outDir: argv[1] });
  console.log(`已生成本地源码包：${result.fileCount} 个文件，${result.totalBytes} 字节。\n目录：${result.output}\n${result.manifest.publicationApproved ? '已记录清单中的 MIT 发布设置；未上传或推送，也不证明模型授权资格。' : '审阅状态；不代表获准发布、许可证已生效或模型授权资格已满足。'}`);
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  runCli(process.argv.slice(2)).catch(error => {
    console.error(error instanceof ReviewPackageError ? `[${error.code}] ${error.message}` : '打包失败；未输出文件内容或凭据。');
    process.exitCode = 1;
  });
}