import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../supabase/functions/push-bridge/index.ts', import.meta.url), 'utf8');
const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });

async function bridge({ listStatus = 200, llmStatus = 200, outboxStatus = 201, checkpointStatus = 200, shortcut = false, deliveryStatus = 200 } = {}) {
  let handler, llmCalls = 0, broadcasts = 0, shortcutCreates = 0, shortcutDeliveries = 0;
  const objects = new Map([['bridge-inbox/library-123.json', JSON.stringify({ type: 'android_library_arrived', payload: 'arrived at library', createdAt: '2026-10-04T20:00:00Z' })]]);
  const job = { id: 'j1', user_id: 'owner', kind: 'bridge_scan', trigger_key: 'bridge:scan:owner', status: 'pending' };
  const rule = { id: 'r1', name: 'library', matchType: 'android_library_arrived', process: { mode: 'raw' }, cooldownMinutes: 180,
    chat: { characterId: 'c1', sessionId: 's1', role: 'user', requestReply: true, characterName: 'Role' } };
  const config = { rules: [rule], rule_runs: {}, daily_count: {}, shortcut_actions: [] };
  if (shortcut) config.shortcut_actions.push({ name: '查询', actionId: 'a1', shortcutName: '查询', resultMode: 'text', deliveryMode: 'push' });
  const outbox = new Map(), work = [];
  let snapshot;
  const env = { SUPABASE_URL: 'https://project.example', SUPABASE_SERVICE_ROLE_KEY: 'service-test' };
  const context = vm.createContext({
    Request, Response, URL, TextEncoder, TextDecoder, Uint8Array, DataView, crypto, atob, btoa, console, AbortController,
    setTimeout, clearTimeout,
    Deno: { env: { get: key => env[key] }, serve: fn => { handler = fn; } },
    EdgeRuntime: { waitUntil: promise => work.push(promise) },
    fetch: async (input, init = {}) => {
      const url = new URL(String(input)), path = url.pathname;
      const body = typeof init.body === 'string' ? JSON.parse(init.body) : null;
      if (path === '/rest/v1/push_server_config') return json([{ cron_secret: 'cron', payload_key: 'payload', site_origin: 'https://float.example', vapid_public_key: 'unused-for-shell', vapid_private_key: 'unused-for-shell' }]);
      if (path === '/rest/v1/push_jobs') {
        if (init.method !== 'PATCH') return json([job]);
        if (body.payload && checkpointStatus !== 200) return new Response('checkpoint unavailable', { status: checkpointStatus });
        if (url.searchParams.get('status') === 'eq.pending' && job.status !== 'pending') return json([]);
        Object.assign(job, body);
        return json([{ ...job }]);
      }
      if (path === '/rest/v1/push_bridge_config') {
        if (init.method === 'PATCH') { Object.assign(config, body); return json([config]); }
        return json([config]);
      }
      if (path.startsWith('/storage/v1/object/list/')) {
        if (listStatus !== 200) return new Response('Unauthorized', { status: listStatus });
        return json([...objects.keys()].filter(key => key.startsWith(body.prefix)).map(key => ({ name: key.slice(body.prefix.length) })));
      }
      if (path === '/storage/v1/object/move') {
        if (!objects.has(body.sourceKey)) return new Response('Object not found', { status: 404 });
        if (objects.has(body.destinationKey)) return new Response('already exists', { status: 409 });
        objects.set(body.destinationKey, objects.get(body.sourceKey)); objects.delete(body.sourceKey);
        return json({});
      }
      if (path.startsWith('/storage/v1/object/ai-phone-backup/')) {
        const key = decodeURIComponent(path.slice('/storage/v1/object/ai-phone-backup/'.length));
        if (!objects.has(key)) return new Response('Object not found', { status: 404 });
        if (init.method === 'DELETE') { objects.delete(key); return json({}); }
        return new Response(objects.get(key));
      }
      if (path === '/rest/v1/push_subscriptions') return json([{ endpoint: 'shell:owner', p256dh: 'shell', auth: 'shell' }]);
      if (path === '/rest/v1/push_bridge_snapshots') return json([{ rule_id: 'r1', payload: snapshot }]);
      if (path === '/functions/v1/ai-phone-push') {
        if (url.searchParams.get('action') === 'shortcut-create') { shortcutCreates++; return json({ ok: true, command: { id: 'command-1' }, resultUrl: 'https://result.example' }); }
        if (url.searchParams.get('action') === 'shortcut-deliver') { shortcutDeliveries++; return deliveryStatus === 200 ? json({ ok: true, delivered: true }) : new Response('failed', { status: 500 }); }
      }
      if (url.hostname === 'llm.example') {
        llmCalls += 1;
        return llmStatus === 200 ? json({ choices: [{ message: { content: shortcut ? 'Good luck studying【快捷动作：查询】' : 'Good luck studying' } }] }) : new Response('upstream unavailable', { status: llmStatus });
      }
      if (path === '/rest/v1/push_outbox') {
        if (init.method !== 'POST') {
          const id = url.searchParams.get('id')?.replace(/^eq\./, '');
          return json(id && outbox.has(id) ? [outbox.get(id)] : []);
        }
        if ((typeof outboxStatus === "function" ? outboxStatus(body) : outboxStatus) !== 201) return new Response('outbox unavailable', { status: 500 });
        for (const row of body) if (!outbox.has(row.id)) outbox.set(row.id, row);
        return json(body);
      }
      if (path === '/realtime/v1/api/broadcast') { broadcasts += 1; return json({}); }
      throw new Error(`Unexpected request ${url}`);
    },
  });
  vm.runInContext(stripTypeScriptTypes(source), context);
  config.cloud_config = await context.encryptJobPayload(JSON.stringify({ url: 'https://storage.example', key: 'cloud-test' }), 'payload');
  job.payload = await context.encryptJobPayload(JSON.stringify({ kind: 'bridge_scan' }), 'payload');
  snapshot = await context.encryptJobPayload(JSON.stringify({ replyRequest: { url: 'https://llm.example', headers: {}, body: { messages: [{ role: 'user', content: '\uE000BRIDGE_EVENT_TEXT\uE000' }] }, providerKind: 'openai-compatible' }, reply: {}, ...(shortcut ? { shortcutContinuation: { request: { url: 'https://llm.example', headers: {}, body: {}, providerKind: 'openai-compatible' }, replyMarker: 'REPLY', resultMarker: 'RESULT' } } : {}) }), 'payload');
  return {
    job, config, objects, outbox,
    async run(options = {}) {
      if ('llmStatus' in options) llmStatus = options.llmStatus;
      if ('outboxStatus' in options) outboxStatus = options.outboxStatus;
      if ('deliveryStatus' in options) deliveryStatus = options.deliveryStatus;
      const response = await handler(new Request('https://project.example/functions/v1/push-bridge', { method: 'POST', body: JSON.stringify({ jobId: 'j1', token: 'cron' }) }));
      await Promise.all(work.splice(0));
      return { status: response.status, llmCalls, broadcasts, shortcutCreates, shortcutDeliveries, pending: JSON.parse(await context.decryptPayload(job.payload, 'payload')) };
    },
  };
}

test('reality bridge delivers a stored reply to the Android shell channel', async () => {
  const app = await bridge();
  const result = await app.run();
  assert.equal(app.job.status, 'done', app.job.result_note);
  assert.equal([...app.outbox.values()][0].raw_text, 'Good luck studying');
  assert.equal(result.broadcasts, 1);
  assert.equal(app.job.status, 'done');
  assert.equal(app.objects.size, 0);
});

test('a denied inbox read is recorded as a failure rather than an empty inbox', async () => {
  const app = await bridge({ listStatus: 403 });
  await app.run();
  assert.notEqual(app.job.status, 'done');
  assert.match(app.job.result_note, /403/);
  assert.equal(app.objects.size, 1);
});

test('a model failure preserves the event and does not start the rule cooldown', async () => {
  const app = await bridge({ llmStatus: 500 });
  const result = await app.run();
  assert.equal(app.job.status, 'pending');
  assert.deepEqual(app.config.rule_runs, {});
  assert.equal(app.objects.size, 1);
  assert.equal(result.pending.items.length, 1);
  await app.run({ llmStatus: 200 });
  assert.equal(app.job.status, 'done');
  assert.equal(app.objects.size, 0);
});

test('a failed outbox write retains the generated reply for retry without another model call', async () => {
  const app = await bridge({ outboxStatus: 500 });
  const first = await app.run();
  assert.equal(app.job.status, 'pending');
  assert.equal(app.objects.size, 1);
  assert.equal(first.pending.items.length, 1);
  const second = await app.run({ outboxStatus: 201 });
  assert.equal(second.llmCalls, 1);
  assert.equal(app.outbox.size, 1);
  assert.equal(app.objects.size, 0);
  assert.equal(app.job.status, 'done');
});

test('checkpoint failure leaves the original inbox file untouched', async () => {
  const app = await bridge({ checkpointStatus: 500 });
  await app.run();
  assert.equal(app.objects.has('bridge-inbox/library-123.json'), true);
  assert.equal(app.outbox.size, 0);
  assert.notEqual(app.job.status, 'done');
});

test('retrying a later rule reuses earlier replies and does not repeat their notifications', async () => {
  const app = await bridge({ outboxStatus: rows => rows[0].meta.ruleId === 'r2' ? 500 : 201 });
  app.config.rules.push({ ...app.config.rules[0], id: 'r2' });
  const first = await app.run();
  assert.equal(first.broadcasts, 1);
  assert.equal(app.job.status, 'pending');
  const second = await app.run({ outboxStatus: 201 });
  assert.equal(second.llmCalls, 2);
  assert.equal(second.broadcasts, 2);
  assert.equal(app.outbox.size, 2);
  assert.equal(app.job.status, 'done');
});
test('cooldown and unmatched archives are persisted idempotently across write failures', async () => {
  for (const matched of [false, true]) {
    const app = await bridge({ outboxStatus: 500 });
    if (matched) app.config.rule_runs.r1 = new Date().toISOString();
    else app.config.rules = [];
    await app.run();
    assert.equal(app.job.status, 'pending');
    const done = await app.run({ outboxStatus: 201 });
    assert.equal(app.outbox.size, 1);
    assert.equal(done.llmCalls, 0);
    assert.equal(app.objects.size, 0);
  }
});

test('a deferred shortcut survives an outbox failure without recreating the command', async () => {
  const app = await bridge({ shortcut: true, outboxStatus: 500 });
  await app.run();
  const done = await app.run({ outboxStatus: 201 });
  assert.equal(done.shortcutCreates, 1);
  assert.equal(done.shortcutDeliveries, 1);
  assert.equal(done.llmCalls, 1);
  assert.equal(app.job.status, 'done');
});
test('a failed shortcut delivery stays pending and retries the same command', async () => {
  const app = await bridge({ shortcut: true, deliveryStatus: 500 });
  const first = await app.run();
  assert.equal(app.job.status, 'pending');
  assert.ok(first.pending.items[0].rows.r1.meta.pendingShortcutDelivery);
  const done = await app.run({ deliveryStatus: 200 });
  assert.equal(done.shortcutCreates, 1);
  assert.equal(done.shortcutDeliveries, 2);
  assert.equal(done.llmCalls, 1);
  assert.equal(done.broadcasts, 1);
  assert.equal(app.job.status, 'done');
});
test('repeated authorization failures stop automatic retries without consuming the inbox', async () => {
  const app = await bridge({ listStatus: 403 });
  await app.run(); await app.run(); await app.run();
  assert.equal(app.job.status, 'failed');
  assert.equal(app.objects.size, 1);
  assert.match(app.job.result_note, /403/);
});
