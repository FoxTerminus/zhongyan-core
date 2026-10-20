import { open } from 'node:fs/promises';

/** Read a bounded Compose file secret; never echo its contents or source path. */
export async function loadSecret(environment, name) {
  const fileName = `${name}_FILE`;
  const path = environment[fileName];
  if (!path) return;
  if (environment[name]) throw new Error('Conflicting secret sources.');
  const file = await open(path, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 4096) throw new Error('Invalid secret file.');
    const buffer = Buffer.alloc(4097);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const token = buffer.subarray(0, offset).toString('utf8').trim();
    if (offset > 4096 || token.length < 32 || /\s/u.test(token)) throw new Error('Invalid secret.');
    environment[name] = token;
    delete environment[fileName];
  } finally { await file.close(); }
}
