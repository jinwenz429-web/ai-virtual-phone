import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

// Deterministic persistence boundary: fail reads/writes while retaining disk data.
// The code under test is the real database module, including its error handlers.
function loadModule(file, initial = {}) {
  const databases = new Map();
  const legacy = new Map(Object.entries(initial));
  class Table {
    rows = new Map();
    failReads = false;
    failWrites = false;
    async toArray() { if (this.failReads) throw new Error('read failed'); return structuredClone([...this.rows.values()]); }
    async count() { if (this.failReads) throw new Error('read failed'); return this.rows.size; }
    async put(row) { if (this.failWrites) throw new Error('write failed'); this.rows.set(row.key ?? row.id, structuredClone(row)); }
    async bulkPut(rows) { for (const row of rows) await this.put(row); }
    async clear() { this.rows.clear(); }
    async delete(key) { this.rows.delete(key); }
  }
  class Dexie {
    constructor(name) { databases.set(name, this); }
    version() { return { stores: schema => { for (const name of Object.keys(schema)) this[name] = new Table(); } }; }
    async transaction(...args) {
      const tables = args.slice(1,-1);
      const snapshots = tables.map(table => structuredClone(table.rows));
      try { return await args.at(-1)(); }
      catch (error) { tables.forEach((table,i) => { table.rows = snapshots[i]; }); throw error; }
    }
    isOpen() { return true; }
    async open() {}
  }
  const localStorage = {
    getItem: key => legacy.get(key) ?? null,
    setItem: (key, value) => legacy.set(key, value),
    removeItem: key => legacy.delete(key),
    key: i => [...legacy.keys()][i] ?? null,
    get length() { return legacy.size; },
  };
  const exports = {};
  const context = vm.createContext({ exports, require: name => { assert.equal(name, 'dexie'); return Dexie; },
    window: { localStorage }, localStorage, console: { log() {}, warn() {}, error() {} },
    setTimeout, clearTimeout, structuredClone });
  const source = readFileSync(new URL(`../lib/${file}.ts`, import.meta.url), 'utf8');
  vm.runInContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, context);
  return { api: exports, databases, legacy };
}

test('settings read failure cannot mark empty caches as hydrated or erase saved presets', async () => {
  const { api, databases } = loadModule('settings-db', { ai_phone_settings_idb_migrated_v1: '1' });
  const db = databases.get('AiPhoneSettingsDB');
  await db.presets.put({ id: 'saved', name: 'Keep me' });
  db.presets.failReads = true;
  await api.hydrateSettingsDb().catch(() => {});
  assert.equal(api.isSettingsHydrated(), false, 'read failure must remain distinguishable from an empty database');
  api.writePresetsCache([]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(db.presets.rows.has('saved'), true);
  db.presets.failReads = false;
  await api.hydrateSettingsDb();
  assert.equal(api.isSettingsHydrated(), true);
  assert.equal(api.readPresetsCache()[0].id, 'saved');
});

for (const raw of ['[{"id":"recoverable"}', '{"id":"recoverable"}', '[null]']) {
  test(`invalid nonempty legacy settings must remain available for recovery: ${raw}`, async () => {
    const {api,databases,legacy} = loadModule('settings-db', {ai_phone_worldbooks_v1:raw});
    const db = databases.get('AiPhoneSettingsDB');
    await db.presets.put({id:'existing'});
    await assert.rejects(api.hydrateSettingsDb());
    assert.equal(api.isSettingsHydrated(),false);
    assert.equal(legacy.get('ai_phone_worldbooks_v1'),raw);
    assert.equal(db.presets.rows.has('existing'),true);
  });
}

for (const [file, dbName, table, flag] of [
  ['settings-db', 'AiPhoneSettingsDB', 'presets', 'ai_phone_settings_idb_migrated_v1'],
  ['chat-db', 'AiPhoneChatDB', 'messages', 'ai_phone_idb_migrated_v1'],
]) {
  test(`${file}: missing migration flag and failed database check cannot become a successful empty migration`, async () => {
    const { api, databases, legacy } = loadModule(file);
    const db = databases.get(dbName);
    await db[table].put({ id: 'saved' });
    db[table].failReads = true;
    const result = await (file === 'settings-db' ? api.hydrateSettingsDb() : api.initChatDb()).then(() => 'success', () => 'failed');
    assert.equal(result, 'failed');
    assert.equal(legacy.has(flag), false, 'failed migration must not set completion flag');
    assert.equal(db[table].rows.has('saved'), true);
  });
}

test('late KV migration retains the only legacy copy until IndexedDB write succeeds', async () => {
  const { api, databases, legacy } = loadModule('kv-db');
  const db = databases.get('AiPhoneKvDB');
  await api.hydrateKvDb();
  legacy.set('saved-key', 'original');
  db.entries.failWrites = true;
  api.registerKvMigration('saved-key');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(legacy.get('saved-key'), 'original');
  db.entries.failWrites = false;
  api.registerKvMigration('saved-key');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(db.entries.rows.get('saved-key')?.value, 'original', 'retry must persist even when the cache already contains the value');
  assert.equal(legacy.has('saved-key'), false);
});

test('initial KV migration retries must commit before deleting the legacy copy', async () => {
  const { api, databases, legacy } = loadModule('kv-db', { 'saved-key': 'original' });
  const db = databases.get('AiPhoneKvDB');
  api.registerKvMigration('saved-key');
  db.entries.failWrites = true;
  await api.hydrateKvDb();
  assert.equal(api.isKvHydrated(), false);
  assert.equal(legacy.get('saved-key'), 'original');
  db.entries.failWrites = false;
  await api.hydrateKvDb();
  assert.equal(api.isKvHydrated(), true);
  assert.equal(db.entries.rows.get('saved-key')?.value, 'original');
  assert.equal(legacy.has('saved-key'), false);
});

for (const [file, dbName, first, second, key1, key2] of [
  ['settings-db','AiPhoneSettingsDB','presets','worldBooks','ai_phone_presets_v1','ai_phone_worldbooks_v1'],
  ['chat-db','AiPhoneChatDB','messages','sessions','ai_phone_chat_messages_v1','ai_phone_chat_sessions_v1'],
]) {
  test(`${file}: migration failure rolls back all stores and retry imports every legacy store`, async () => {
    const { api, databases, legacy } = loadModule(file, { [key1]: '[{"id":"one"}]', [key2]: '[{"id":"two"}]' });
    const db = databases.get(dbName);
    db[second].failWrites = true;
    const hydrate = () => file === 'settings-db' ? api.hydrateSettingsDb() : api.initChatDb();
    await assert.rejects(hydrate());
    assert.equal(db[first].rows.size,0,'no partial migration may survive a failed transaction');
    assert.equal(legacy.has(key1),true);
    assert.equal(legacy.has(key2),true);
    db[second].failWrites = false;
    await hydrate();
    assert.equal(db[first].rows.has('one'),true);
    assert.equal(db[second].rows.has('two'),true);
  });
  test(`${file}: already partial migration retains newer persisted records and recovers remaining legacy records`, async () => {
    const { api, databases } = loadModule(file, { [key1]: '[{"id":"one","name":"old"}]', [key2]: '[{"id":"two"}]' });
    const db = databases.get(dbName);
    await db[first].put({id:'one',name:'new'});
    await (file === 'settings-db' ? api.hydrateSettingsDb() : api.initChatDb());
    assert.equal(db[first].rows.get('one').name,'new');
    assert.equal(db[second].rows.has('two'),true);
  });
}

test('late KV migration cannot remove a legacy value changed during the pending write', async () => {
  const { api, databases, legacy } = loadModule('kv-db');
  const db = databases.get('AiPhoneKvDB');
  await api.hydrateKvDb();
  legacy.set('saved-key', 'original');
  const originalPut = db.entries.put.bind(db.entries);
  let release;
  db.entries.put = async row => { await new Promise(resolve => { release = resolve; }); return originalPut(row); };
  api.registerKvMigration('saved-key');
  legacy.set('saved-key', 'newer');
  release();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(legacy.get('saved-key'), 'newer');
});

for (const failure of [null, 'settings', 'chat']) {
  test(`startup gates entry until chat and settings load (${failure ?? 'healthy'})`, async () => {
    const states = [], effects = [], calls = [];
    let cursor = 0;
    let chatLoaded = false, settingsLoaded = false, releaseChat;
    const exports = {};
    const functions = {
      useState: initial => { const i = cursor++; if (i === states.length) states.push(initial); return [states[i], value => { states[i] = value; }]; },
      useEffect: fn => effects.push(fn),
      hydrateKvDb: async () => { calls.push('kv'); },
      isKvHydrated: () => true,
      hydrateSettingsDb: async () => { calls.push('settings'); if (failure === 'settings') throw new Error('read failed'); settingsLoaded = true; },
      isSettingsHydrated: () => settingsLoaded,
      hydrateChatStorage: async () => { calls.push('chat'); await new Promise(resolve => { releaseChat = resolve; }); chatLoaded = failure !== 'chat'; },
      isChatStorageHydrated: () => chatLoaded,
      readThemeProfile: () => ({}), resolveActiveIconSkins: () => ({}),
      hasPendingMcpOAuthCallback: () => false, shouldRequestPwaFullscreen: () => false,
      jsx: (type,props) => ({type,props}), jsxs: (type,props) => ({type,props}),
      ChatPluginBootstrap: function ChatPluginBootstrap(){},
    };
    const dependency = new Proxy(function(){}, { get: (_,name) => functions[name] ?? function(){} });
    const context = vm.createContext({ exports, require: () => dependency,
      navigator: {}, window: { matchMedia: () => ({matches:false}) },
      document: { addEventListener() {}, removeEventListener() {} },
      console: { warn() {} }, setTimeout, clearTimeout });
    const source = readFileSync(new URL('../components/main-app.tsx', import.meta.url), 'utf8');
    vm.runInContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText, context);
    exports.MainApp();
    effects[0]();
    assert.deepEqual(calls.sort(), ['chat','kv','settings']);
    assert.equal(states[1], false, 'entry remains blocked while chat is loading');
    releaseChat();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(states[1], failure === null, 'only complete successful loading can enable entry');
    assert.equal(states[3], failure !== null, 'failed loading must expose retry instead of the desktop');
    cursor = 0;
    const tree = exports.MainApp();
    const contains = node => !!node && (Array.isArray(node) ? node.some(contains) : typeof node === 'object' && (node.type === functions.ChatPluginBootstrap || contains(node.props?.children)));
    assert.equal(contains(tree), failure === null, 'plugin bootstrap must be mounted only after complete successful loading');
  });
}

test('root layout does not start chat plugins outside the storage gate', () => {
  const bootstrap = function ChatPluginBootstrap() {};
  const jsx = (type,props) => ({type,props});
  const exports = {};
  const dependency = new Proxy({}, {get: (_,key) => key === 'ChatPluginBootstrap' ? bootstrap : key === 'jsx' || key === 'jsxs' ? jsx : function() {} });
  const context = vm.createContext({exports,require: () => dependency});
  const source = readFileSync(new URL('../app/layout.tsx', import.meta.url),'utf8');
  vm.runInContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText,context);
  const tree = exports.default({children:null});
  const contains = node => !!node && (Array.isArray(node) ? node.some(contains) : typeof node === 'object' && (node.type === bootstrap || contains(node.props?.children)));
  assert.equal(contains(tree),false);
});
