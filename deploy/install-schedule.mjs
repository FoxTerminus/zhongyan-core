import { writeFile, mkdir, lstat, chmod, readFile } from 'node:fs/promises';
import { join, posix, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { requireLinuxRoot, realDirectory, privateDirectory, ordinaryFile, recipient, OperationsError } from './operations.mjs';

// Keep service arguments and systemd specifier expansion unambiguous, even with configurable paths.
export function unitPath(value) {
  if (typeof value !== 'string' || !/^\/[A-Za-z0-9_./-]+$/.test(value) || posix.resolve(value) !== value) throw new OperationsError('systemd 路径只支持规范的绝对路径和英文字母、数字、点、下划线、横线。');
  return value;
}
export function units(config, configFile, node) {
  for (const path of [config.root, config.stateDirectory, config.backupDirectory, configFile, node]) unitPath(path);
  const service = mode => `[Unit]\nDescription=Zhongyan ${mode === 'backup' ? 'encrypted backup' : 'health and certificate inspection'}\nAfter=docker.service network-online.target\nWants=network-online.target\n\n[Service]\nType=oneshot\nUser=root\nGroup=root\nUMask=0077\nExecStart=${node} ${config.root}/deploy/scheduled-operations.mjs --config ${configFile} --mode ${mode}\nTimeoutStartSec=${mode === 'backup' ? '90min' : '4min'}\nTimeoutStopSec=${mode === 'backup' ? '12min' : '30s'}\nKillMode=mixed\nPrivateTmp=true\nPrivateDevices=true\nProtectHome=true\nProtectSystem=strict\nReadWritePaths=${config.stateDirectory} ${config.backupDirectory} ${config.root}/deploy\nNoNewPrivileges=true\nMemoryMax=384M\nStandardOutput=journal\nStandardError=journal\n`;
  return {
    'zhongyan-backup.service': service('backup'),
    'zhongyan-health.service': service('health'),
    'zhongyan-backup.timer': '[Unit]\nDescription=Check Zhongyan daily backup due time and retry when idle\n\n[Timer]\nOnCalendar=*-*-* *:00/15:00 UTC\nPersistent=true\nRandomizedDelaySec=30\nAccuracySec=1s\nUnit=zhongyan-backup.service\n\n[Install]\nWantedBy=timers.target\n',
    'zhongyan-health.timer': '[Unit]\nDescription=Inspect Zhongyan health every five minutes\n\n[Timer]\nOnCalendar=*-*-* *:00/5:00 UTC\nOnBootSec=90s\nPersistent=true\nRandomizedDelaySec=10\nAccuracySec=1s\nUnit=zhongyan-health.service\n\n[Install]\nWantedBy=timers.target\n',
  };
}
export async function ensureDirectory(path, mode) {
  try { await mkdir(path, { mode }); await chmod(path, mode); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  await realDirectory(path);
  const stat = await lstat(path);
  if (stat.uid !== 0 || (stat.mode & 0o777) !== mode) throw new OperationsError('已有运维目录的属主或权限不符合要求；未自动改变。');
}
async function managedFile(path, content, mode) {
  try {
    await ordinaryFile(path, 64 * 1024);
    // Installation is repeatable only when byte-identical; never silently replace local customizations.
    if (await readFile(path, 'utf8') !== content) throw new OperationsError('配置已存在且内容不同，需审阅后更新。');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await writeFile(path, content, { mode, flag: 'wx' }); await chmod(path, mode);
  }
}
async function main() {
  const { values } = parseArgs({ options: { root: { type: 'string' }, state: { type: 'string' }, backups: { type: 'string' }, recipient: { type: 'string' }, node: { type: 'string' }, config: { type: 'string' }, hour: { type: 'string' }, minute: { type: 'string' }, help: { type: 'boolean' } } });
  if (values.help || !values.root || !values.state || !values.backups || !values.recipient || !values.node || !values.config) {
    console.log('sudo node deploy/install-schedule.mjs --root /opt/zhongyan/app --state /opt/zhongyan/operations --backups /opt/zhongyan/backups --recipient /opt/zhongyan/backup-recipient.txt --node /usr/local/bin/node --config /etc/zhongyan/operations.json [--hour 20 --minute 30]\n只安装配置和4个systemd单元，不启用或启动服务。时刻为UTC（默认20:30=北京时间次日04:30）。');
    if (!values.help) process.exitCode = 1; return;
  }
  requireLinuxRoot(); process.umask(0o077);
  const config = { schemaVersion: 1, root: unitPath(values.root), stateDirectory: unitPath(values.state), backupDirectory: unitPath(values.backups), recipient: unitPath(values.recipient), hourUtc: Number(values.hour ?? 20), minuteUtc: Number(values.minute ?? 30) };
  if (!Number.isInteger(config.hourUtc) || config.hourUtc < 0 || config.hourUtc > 23 || !Number.isInteger(config.minuteUtc) || config.minuteUtc < 0 || config.minuteUtc > 59) throw new OperationsError('备份时刻无效。');
  await realDirectory(config.root); await recipient(config.recipient);
  await ensureDirectory(config.stateDirectory, 0o755); await ensureDirectory(config.backupDirectory, 0o700);
  const configFile = unitPath(values.config); await ensureDirectory(dirname(configFile), 0o700);
  await privateDirectory(dirname(configFile));
  await managedFile(configFile, JSON.stringify(config, null, 2) + '\n', 0o600);
  for (const [name, content] of Object.entries(units(config, configFile, values.node))) await managedFile(join('/etc/systemd/system', name), content, 0o644);
  console.log('已安装配置及systemd单元，尚未启用。先验证只读运维挂载和空闲闸门，再执行 systemctl daemon-reload；systemctl enable --now zhongyan-health.timer zhongyan-backup.timer。');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(() => { console.error('调度安装未完成；检查路径、目录权限或已有配置差异，未覆盖已有不同内容。'); process.exitCode = 1; });
