import { FilePlanProfileStore } from '../../src/auth/profile-store.js';
const directory = process.argv[2];
if (!directory || !process.send) process.exit(2);
const store = new FilePlanProfileStore(directory);
try {
  await store.withLock(async () => {
    process.send!({ type: 'locked' });
    await new Promise<void>(resolve => process.once('message', () => resolve()));
  });
  process.send({ type: 'released' });
  process.disconnect();
} catch {
  process.send({ type: 'failed' });
  process.disconnect(); process.exitCode = 1;
}
