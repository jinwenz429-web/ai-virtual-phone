import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { resolve } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(process.env.GATEWAY_SOURCE || resolve('supabase/functions/ai-phone-push/index.ts'), 'utf8');
function gateway({ broadcastStatus = 202, anonKey = 'public-test-key', jobStatus = 'running' } = {}) {
  let handler;
  const broadcasts = [];
  const writes = [];
  const env = { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'private-test-key', SUPABASE_ANON_KEY: anonKey };
  const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
  const context = {
    Request, Response, URL, TextEncoder, Uint8Array, DataView, crypto, atob, btoa, console,
    setTimeout: callback => queueMicrotask(callback),
    Deno: { env: { get: key => env[key] }, serve: fn => { handler = fn; } },
    fetch: async (input, init = {}) => {
      const url = String(input);
      if (url.includes('/rest/v1/push_bridge_config')) return json([{ user_id: 'owner' }]);
      if (url.includes('/rest/v1/push_jobs')) { if (init.method === 'DELETE') throw new Error('active job was deleted'); return json([{ id: 'job-existing', status: jobStatus, payload: { retained: true } }]); }
      if (url.includes('/storage/v1/')) { writes.push({ url, headers: init.headers, body: init.body }); return new Response('stored', { status: 200 }); }
      if (url.includes('/auth/v1/admin/users')) {
        assert.equal(init.headers.Authorization, undefined);
        return init.headers.apikey === 'sb_secret_valid_test' ? json([]) : new Response(null, { status: 401 });
      }
      if (url.endsWith('/realtime/v1/api/broadcast')) {
        broadcasts.push(JSON.parse(init.body));
        return new Response(null, { status: broadcastStatus });
      }
      if (url.includes('/rest/v1/push_server_config')) return json([{ vapid_public_key: 'unused-for-shell', vapid_private_key: 'unused-for-shell', cron_secret: 'cron', payload_key: 'payload', site_origin: 'https://float.example' }]);
      if (url.includes('/rest/v1/push_subscriptions')) {
        if (init.method === 'POST') writes.push(JSON.parse(init.body));
        return json([{ endpoint: 'shell:owner', user_id: 'owner', p256dh: 'shell', auth: 'shell' }]);
      }
      throw new Error(`Unexpected outbound request: ${url}`);
    },
  };
  vm.runInNewContext(stripTypeScriptTypes(source), context);
  return { broadcasts, writes, request: (action, init = {}, authenticated = true) => handler(new Request(`https://example.supabase.co/functions/v1/ai-phone-push?action=${action}`, {
    ...init,
    headers: { ...(authenticated ? { 'x-ai-phone-service-key': 'private-test-key' } : {}), 'x-ai-phone-origin': 'https://float.example', ...init.headers },
  })) };
}

test('shell configuration requires project admin authorization', async () => {
  const response = await gateway().request('shell-config', {}, false);
  assert.equal(response.status, 401);
});
test('authorized shell receives public connection parameters without the service key', async () => {
  const response = await gateway().request('shell-config');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, supabaseUrl: 'https://example.supabase.co', anonKey: 'public-test-key', userId: 'owner' });
});
test('missing public key produces a clear failure', async () => {
  assert.equal((await gateway({ anonKey: '' }).request('shell-config')).status, 503);
});
test('shell subscription is stored for the personal owner', async () => {
  const app = gateway();
  const response = await app.request('subscribe', { method: 'POST', body: JSON.stringify({ endpoint: 'shell:owner', keys: { p256dh: 'shell', auth: 'shell' } }), headers: { 'Content-Type': 'application/json' } });
  assert.equal(response.status, 200);
  assert.equal(app.writes[0][0].endpoint, 'shell:owner');
  assert.equal(app.writes[0][0].user_id, 'owner');
});
test('test notification reaches the native shell broadcast channel', async () => {
  const app = gateway();
  const response = await app.request('test', { method: 'POST' });
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  assert.equal(result.sent, 1);
  assert.equal(app.broadcasts.length, 1);
  const message = app.broadcasts[0].messages[0];
  assert.equal(message.topic, 'shellpush:owner');
  assert.equal(message.event, 'notify');
  assert.equal(message.payload.title, '小手机');
  assert.equal(message.payload.body, '个人 Supabase 离线推送已连通。');
});
test('broadcast rejection is reported as a failed test notification', async () => {
  const response = await gateway({ broadcastStatus: 503 }).request('test', { method: 'POST' });
  assert.equal(response.status, 500);
  assert.match((await response.json()).error, /503/);
});

test('repeated bridge wake preserves a running job and its checkpoint', async () => {
  const response = await gateway().request('bridge-wake&token=bridge-token', {}, false);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);
});
test('new-key storage proxy forwards only backup storage within this project', async () => {
  const app = gateway();
  const response = await app.request('storage&path=' + encodeURIComponent('/storage/v1/object/ai-phone-backup/bridge-state/battery.json'));
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'stored');
  assert.equal(app.writes[0].url, 'https://example.supabase.co/storage/v1/object/ai-phone-backup/bridge-state/battery.json');
  assert.equal((await app.request('storage&path=' + encodeURIComponent('/rest/v1/push_server_config'))).status, 400);
  assert.equal((await app.request('storage&path=' + encodeURIComponent('/storage/v1/object/ai-phone-backup/../../other/private'))).status, 400);
});

test('new secret keys authenticate against this project admin API and forward without Bearer', async () => {
  const app = gateway();
  const response = await app.request('storage&path=' + encodeURIComponent('/storage/v1/object/ai-phone-backup/bridge-state/battery.json'), { headers: { 'x-ai-phone-service-key': 'sb_secret_valid_test' } });
  assert.equal(response.status, 200);
  assert.equal(app.writes[0].headers.apikey, 'sb_secret_valid_test');
  assert.equal(app.writes[0].headers.Authorization, undefined);
});
