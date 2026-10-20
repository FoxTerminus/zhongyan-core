import { AsyncLocalStorage } from 'node:async_hooks';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, rmdir, unlink } from 'node:fs/promises';
import { dirname, join, parse, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { z } from 'zod';
import { isPlanHostId } from './types.js';

const execute = promisify(execFile);
const MAX_BYTES = 64 * 1024;
const LOCK_WAIT_MS = 1_500;
const identifier = z.string().min(1).max(512).regex(/^\S+$/);
const token = z.string().min(1).max(32_768).regex(/^\S+$/);
const hostIdSchema = z.string().refine(isPlanHostId).transform(value => value.toLowerCase());
const legacyHostIdSchema = z.string().refine(value => isPlanHostId(`urn:uuid:${value}`))
  .transform(value => `urn:uuid:${value.toLowerCase()}`);
const profileSchema = z.object({
  version: z.literal(2),
  revision: identifier,
  appName: z.string().min(1).max(64).regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/),
  hostId: hostIdSchema,
  clientId: identifier.refine(value => value !== 'dynamic_agent_client'),
  issuer: z.literal('https://auth.openai.com'),
  subject: identifier,
  accessToken: token,
  refreshToken: token,
  idToken: token,
  scopes: z.array(z.string().min(1).max(256).regex(/^\S+$/)).max(64)
    .refine(values => new Set(values).size === values.length),
  expiresAt: z.number().int().positive().safe(),
  savedAt: z.number().int().positive().safe(),
}).strict();
const legacyProfileSchema = profileSchema.extend({ version: z.literal(1), hostId: legacyHostIdSchema })
  .transform(value => ({ ...value, version: 2 as const }));
const readableProfileSchema = z.union([profileSchema, legacyProfileSchema]);
const hostSchema = z.object({ version: z.literal(2), hostId: hostIdSchema }).strict();
const legacyHostSchema = hostSchema.extend({ version: z.literal(1), hostId: legacyHostIdSchema })
  .transform(value => ({ ...value, version: 2 as const }));

export type PlanProfile = z.infer<typeof profileSchema>;
/** Validates only this application's profile format, never Codex desktop auth. */
export function parsePlanProfile(value: unknown): PlanProfile {
  const parsed = readableProfileSchema.safeParse(value);
  if (!parsed.success) throw new ProfileStoreError('迁移文件不是有效的本应用授权配置。');
  return parsed.data;
}

export type HostRegistration = z.infer<typeof hostSchema>;

/** Deliberately excludes filenames, operating-system errors and credential contents. */
export class ProfileStoreError extends Error {
  constructor(message = '无法安全访问独立登录配置，请检查专用目录和文件权限。') {
    super(message);
    this.name = 'ProfileStoreError';
  }
}

function code(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code) : undefined;
}
function safe(error: unknown): ProfileStoreError {
  return error instanceof ProfileStoreError ? error : new ProfileStoreError();
}

// A fixed script receives only a path and an operation, never a token or shell command.
// chmod does not enforce a Windows DACL. Protect and inspect the actual ACL instead.
const ACL_SCRIPT = `
$ErrorActionPreference = 'Stop'
$path = $env:PERSONAL_AGENT_ACL_PATH
$isDirectory = $env:PERSONAL_AGENT_ACL_KIND -eq 'directory'
$current = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$system = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$inheritance = [System.Security.AccessControl.InheritanceFlags]::None
if ($isDirectory) {
  $inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
}
if ($env:PERSONAL_AGENT_ACL_OPERATION -eq 'protect') {
  if ($isDirectory) { $acl = [System.Security.AccessControl.DirectorySecurity]::new() }
  else { $acl = [System.Security.AccessControl.FileSecurity]::new() }
  # New files already belong to the process owner; changing ownership unnecessarily requires extra privileges.
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($sid in @($current, $system)) {
    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, [System.Security.AccessControl.FileSystemRights]::FullControl, $inheritance, [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow)
    $acl.AddAccessRule($rule)
  }
  if ($isDirectory) { [System.IO.Directory]::SetAccessControl($path, $acl) }
  else { [System.IO.File]::SetAccessControl($path, $acl) }
}
if ($isDirectory) { $acl = [System.IO.Directory]::GetAccessControl($path) }
else { $acl = [System.IO.File]::GetAccessControl($path) }
if (!$acl.AreAccessRulesProtected -or !$acl.AreAccessRulesCanonical) { throw 'permissions' }
if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $current.Value) { throw 'owner' }
$seen = @{}
foreach ($rule in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
  $sid = $rule.IdentityReference.Value
  if ($sid -ne $current.Value -and $sid -ne $system.Value) { throw 'principal' }
  if ($rule.IsInherited -or $rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) { throw 'rule' }
  if ($rule.FileSystemRights -ne [System.Security.AccessControl.FileSystemRights]::FullControl) { throw 'rights' }
  if ($rule.InheritanceFlags -ne $inheritance -or $rule.PropagationFlags -ne [System.Security.AccessControl.PropagationFlags]::None) { throw 'inheritance' }
  $seen[$sid] = $true
}
if (!$seen.ContainsKey($current.Value) -or !$seen.ContainsKey($system.Value)) { throw 'missing principal' }
[Console]::Write('ok')
`;

async function permissions(path: string, directory: boolean, protect = false): Promise<void> {
  if (process.platform === 'win32') {
    const executable = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const result = await execute(executable, [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(ACL_SCRIPT, 'utf16le').toString('base64'),
    ], {
      windowsHide: true,
      timeout: 10_000,
      maxBuffer: 16_384,
      env: {
        ...Object.fromEntries(Object.entries(process.env).filter(([name]) => [
          'SYSTEMROOT', 'WINDIR', 'PATH', 'COMSPEC', 'PATHEXT', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP',
        ].includes(name.toUpperCase()))),
        PERSONAL_AGENT_ACL_PATH: path,
        PERSONAL_AGENT_ACL_KIND: directory ? 'directory' : 'file',
        PERSONAL_AGENT_ACL_OPERATION: protect ? 'protect' : 'verify',
      },
    });
    if (result.stdout !== 'ok') throw new ProfileStoreError();
  } else {
    if (protect) await chmod(path, directory ? 0o700 : 0o600);
    const stat = await lstat(path);
    if (stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== (directory ? 0o700 : 0o600)) {
      throw new ProfileStoreError();
    }
  }
}

/** Every component is checked so a junction/symlink cannot redirect the secret store. */
async function directories(path: string, create: boolean): Promise<boolean> {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  let current = root;
  for (const component of absolute.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, component);
    let stat;
    try { stat = await lstat(current); }
    catch (error) {
      if (code(error) !== 'ENOENT') throw error;
      if (!create) return false;
      try {
        await mkdir(current, { mode: 0o700 });
        await permissions(current, true, true);
      } catch (creationError) {
        if (code(creationError) !== 'EEXIST') throw creationError;
      }
      stat = await lstat(current);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new ProfileStoreError();
  }
  await permissions(absolute, true);
  return true;
}

type LockContext = { active: boolean };

/** One dedicated directory per application registration; never discovers desktop credentials. */
export class FilePlanProfileStore {
  readonly directory: string;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly context = new AsyncLocalStorage<LockContext>();

  constructor(directory: string) {
    this.directory = resolve(directory);
    if (this.directory === parse(this.directory).root) throw new ProfileStoreError();
  }

  async read(): Promise<PlanProfile | null> {
    try {
      if (!(await directories(this.directory, false))) return null;
      const value = await this.readJson('profile.json');
      if (value === null) return null;
      // Status reads may normalize legacy metadata in memory but must never write or refresh.
      const result = readableProfileSchema.safeParse(value);
      if (!result.success) throw new ProfileStoreError('独立登录配置格式无效，需要重新授权。');
      return result.data;
    } catch (error) { throw safe(error); }
  }

  /** Reentrant within this callback, serialized locally and exclusive across processes. */
  async withLock<T>(callback: () => Promise<T>): Promise<T> {
    if (this.context.getStore()?.active) return callback();
    const run = this.queue.then(async () => {
      let locked = false;
      let callbackFailed = false;
      const path = join(this.directory, '.profile-lock');
      try {
        await directories(this.directory, true);
        const started = Date.now();
        for (;;) {
          try {
            await mkdir(path, { mode: 0o700 });
            locked = true;
            await permissions(path, true, true);
            break;
          } catch (error) {
            if (code(error) !== 'EEXIST') throw error;
            const stat = await lstat(path);
            if (stat.isSymbolicLink() || !stat.isDirectory()) throw new ProfileStoreError();
            if (Date.now() - started >= LOCK_WAIT_MS) {
              throw new ProfileStoreError('独立登录配置正在使用中，或上次操作留下了锁；请停止其他授权进程后检查。');
            }
            await delay(50);
          }
        }
        const state = { active: true };
        try { return await this.context.run(state, callback); }
        catch (error) { callbackFailed = true; throw error; }
        finally { state.active = false; }
      } catch (error) { if (callbackFailed) throw error; throw safe(error); }
      finally {
        // Only a directory created by this invocation is removed. Unknown old locks stay intact.
        if (locked) {
          try { await rmdir(path); }
          catch { throw new ProfileStoreError('独立登录操作已结束，但未能释放配置锁，请检查专用目录。'); }
        }
      }
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  async write(profile: PlanProfile): Promise<void> {
    const parsed = profileSchema.safeParse(profile);
    if (!parsed.success) throw new ProfileStoreError('独立登录配置格式无效，需要重新授权。');
    try { await this.withLock(() => this.atomicJson('profile.json', parsed.data)); }
    catch (error) { throw safe(error); }
  }

  async hostId(): Promise<string> {
    return this.withLock(async () => {
      const existing = await this.readJson('host.json');
      if (existing !== null) {
        const parsed = hostSchema.safeParse(existing);
        if (parsed.success) return parsed.data.hostId;
        const migrated = legacyHostSchema.safeParse(existing);
        if (!migrated.success) throw new ProfileStoreError('独立登录主机信息格式无效。');
        // Prefix the existing UUID; retain its identity, and commit under this owned lock.
        await this.atomicJson('host.json', migrated.data);
        return migrated.data.hostId;
      }
      const registration: HostRegistration = { version: 2, hostId: `urn:uuid:${randomUUID()}` };
      await this.atomicJson('host.json', registration);
      return registration.hostId;
    }).catch(error => { throw safe(error); });
  }

  async prepareRuntimeHome(): Promise<string> {
    return this.withLock(async () => {
      const home = join(this.directory, 'codex-home');
      await directories(home, true);
      // This directory is intentionally created locally. No ambient CODEX_HOME is read or copied.
      return home;
    }).catch(error => { throw safe(error); });
  }

  private async readJson(name: string): Promise<unknown | null> {
    const path = join(this.directory, name);
    let stat;
    try { stat = await lstat(path); }
    catch (error) { if (code(error) === 'ENOENT') return null; throw error; }
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || stat.size > MAX_BYTES) {
      throw new ProfileStoreError();
    }
    await permissions(path, false);
    const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = await file.stat();
      if (opened.dev !== stat.dev || opened.ino !== stat.ino || !opened.isFile()) throw new ProfileStoreError();
      const buffer = Buffer.alloc(MAX_BYTES + 1);
      let count = 0;
      while (count < buffer.length) {
        const result = await file.read(buffer, count, buffer.length - count, count);
        if (result.bytesRead === 0) break;
        count += result.bytesRead;
      }
      if (count > MAX_BYTES) throw new ProfileStoreError();
      return JSON.parse(buffer.subarray(0, count).toString('utf8'));
    } finally { await file.close(); }
  }

  private async atomicJson(name: string, value: unknown): Promise<void> {
    const data = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
    if (data.length > MAX_BYTES) throw new ProfileStoreError('独立登录配置过大，未保存。');
    const target = join(this.directory, name);
    // Validate an existing target before replacement rather than silently taking it over.
    await this.readJson(name);
    const temporary = join(this.directory, `.${name}.${randomUUID()}.tmp`);
    const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    let closed = false;
    let renamed = false;
    try {
      await permissions(temporary, false, true);
      await file.writeFile(data);
      await file.sync();
      await file.close();
      closed = true;
      await rename(temporary, target);
      renamed = true;
      // POSIX requires a directory fsync for the rename to survive a power failure.
      if (process.platform !== 'win32') {
        const directory = await open(dirname(target), constants.O_RDONLY);
        try { await directory.sync(); } finally { await directory.close(); }
      }
    } finally {
      if (!closed) await file.close().catch(() => undefined);
      if (!renamed) await unlink(temporary).catch(() => undefined);
    }
  }
}
