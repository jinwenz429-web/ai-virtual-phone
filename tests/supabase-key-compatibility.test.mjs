import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
const context = vm.createContext({ Headers, URL });
vm.runInContext(stripTypeScriptTypes(readFileSync(new URL('../lib/supabase-auth.ts', import.meta.url), 'utf8')).replace(/export /g, ''), context);
test('opaque API keys are not JWT bearer tokens, legacy keys keep both headers', () => {
  assert.equal(context.supabaseAuthHeaders('sb_secret_test').Authorization, undefined);
  assert.equal(context.supabaseAuthHeaders('sb_publishable_test').Authorization, undefined);
  assert.equal(context.supabaseAuthHeaders('legacy-jwt').Authorization, 'Bearer legacy-jwt');
});
test('secret Storage requests use authenticated personal gateway without putting the key in the URL', () => {
  const original = 'https://project.supabase.co/storage/v1/object/ai-phone-backup/bridge-state/battery.json';
  const request = context.personalStorageRequest(original, { method: 'POST', body: 'payload', headers: { ...context.supabaseAuthHeaders('sb_secret_test'), 'x-upsert': 'true', 'Content-Type': 'application/json' } });
  const url = new URL(request.url);
  assert.equal(url.pathname, '/functions/v1/ai-phone-push');
  assert.equal(url.searchParams.get('path'), new URL(original).pathname);
  assert.equal(request.url.includes('sb_secret'), false);
  assert.equal(request.init.headers.get('x-ai-phone-service-key'), 'sb_secret_test');
  assert.equal(request.init.headers.get('x-upsert'), 'true');
  assert.equal(request.init.headers.get('Authorization'), null);
  assert.equal(request.init.body, 'payload');
});
test('legacy Storage keeps the existing direct request', () => {
  const url = 'https://project.supabase.co/storage/v1/bucket';
  assert.equal(context.personalStorageRequest(url, { headers: context.supabaseAuthHeaders('legacy') }).url, url);
});
