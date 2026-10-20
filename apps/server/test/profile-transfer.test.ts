import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importPlanProfile, readTransferredProfile } from '../src/auth/profile-transfer.js';
import { PLAN_SCOPES } from '../src/auth/types.js';
import type { PlanProfile } from '../src/auth/profile-store.js';

function fixture(): PlanProfile {
  return { version: 2, revision: 'fixture-revision', appName: 'personal_agent',
    hostId: 'urn:uuid:11111111-1111-4111-8111-111111111111', clientId: 'fixture-issued-client',
    issuer: 'https://auth.openai.com', subject: 'fixture-subject', accessToken: 'fixture-access',
    refreshToken: 'fixture-refresh', idToken: 'fixture-id', scopes: [...PLAN_SCOPES],
    expiresAt: 123456789, savedAt: 123456000 };
}
function store(hostId='urn:uuid:22222222-2222-4222-8222-222222222222', existing: PlanProfile | null=null) {
  let locked=false; let saved=existing; let hostCalls=0;
  return { get saved() { return saved; }, get hostCalls() { return hostCalls; },
    async withLock<T>(callback: () => Promise<T>) { locked=true; try { return await callback(); } finally { locked=false; } },
    async hostId() { assert.equal(locked,true); hostCalls++; return hostId; },
    async read() { return saved; }, async write(value:PlanProfile) { assert.equal(locked,true); saved=value; } };
}
test('VM import retains target host, credentials and registration without refreshing',async()=>{
  const source=fixture(); const target=store();
  await importPlanProfile(source,target,'personal_agent');
  assert.notEqual(target.saved!.hostId,source.hostId);
  assert.equal(target.saved!.hostId,'urn:uuid:22222222-2222-4222-8222-222222222222');
  assert.equal(target.saved!.accessToken,source.accessToken);
  assert.equal(target.saved!.refreshToken,source.refreshToken);
  assert.equal(target.saved!.clientId,source.clientId);
  assert.equal(target.saved!.expiresAt,source.expiresAt);
  assert.notEqual(target.saved!.revision,source.revision);
  assert.equal(source.hostId,'urn:uuid:11111111-1111-4111-8111-111111111111');
});
test('import refuses wrong app, non-app credentials, missing scope and copied host identity',async()=>{
  for (const value of [{...fixture(), appName:'another_app'}, {...fixture(), scopes:['openid']}, {tokens:{access_token:'fixture'}}]) {
    const target=store(); await assert.rejects(importPlanProfile(value,target,'personal_agent'));
    assert.equal(target.saved,null); assert.equal(target.hostCalls,0);
  }
  const target=store(fixture().hostId);
  await assert.rejects(importPlanProfile(fixture(),target,'personal_agent'),/host.json/);
  assert.equal(target.saved,null);
});
test('import never overwrites an existing target session',async()=>{
  const previous=fixture(); const target=store(undefined,previous);
  await assert.rejects(importPlanProfile(fixture(),target,'personal_agent'),/已经有授权/);
  assert.equal(target.saved,previous); assert.equal(target.hostCalls,0);
});
test('legacy imports normalize UUID metadata before comparing identities or binding a new VM host', async () => {
  const source = { ...fixture(), hostId: 'urn:uuid:abcdef12-abcd-4abc-8abc-abcdef123456' };
  const legacy = { ...source, version: 1, hostId: source.hostId.slice('urn:uuid:'.length).toUpperCase() };
  const sameHost = store(source.hostId);
  await assert.rejects(importPlanProfile(legacy, sameHost, 'personal_agent'), /host.json/);
  assert.equal(sameHost.saved, null);
  const target = store();
  await importPlanProfile(legacy, target, 'personal_agent');
  assert.equal(target.saved!.version, 2);
  assert.equal(target.saved!.hostId, 'urn:uuid:22222222-2222-4222-8222-222222222222');
  assert.equal(target.saved!.clientId, source.clientId);
  assert.equal(target.saved!.accessToken, source.accessToken);
  assert.equal(target.saved!.refreshToken, source.refreshToken);
  assert.equal(legacy.hostId, source.hostId.slice('urn:uuid:'.length).toUpperCase());
});
test('transfer input supports split chunks and rejects oversized or malformed payloads',async()=>{
  async function* chunks(values: Array<string|Buffer>) { yield* values; }
  const data=JSON.stringify(fixture());
  assert.deepEqual(await readTransferredProfile(chunks([data.slice(0,29), Buffer.from(data.slice(29))])),fixture());
  await assert.rejects(readTransferredProfile(chunks(['{'])),/格式无效/);
  await assert.rejects(readTransferredProfile(chunks(['x'.repeat(65537)])),/大小限制/);
});
