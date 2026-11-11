'use strict';
// Runs background.js and popup.js in a Node vm with mocked browser and WebDAV APIs.
// Run with: node --test
const { test } = require('node:test');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const repo = path.join(__dirname, '..');
const backgroundSrc = fs.readFileSync(path.join(repo, 'background.js'), 'utf8');
const popupSrc = fs.readFileSync(path.join(repo, 'popup.js'), 'utf8');

// chrome.i18n with the English messages, so tests read the texts users see
const EN = JSON.parse(fs.readFileSync(path.join(repo, '_locales', 'en', 'messages.json'), 'utf8'));
const i18n = {
    getMessage: (key, subs = []) => (EN[key] ? EN[key].message.replace(/\$(\d)/g, (m, n) => (subs[n - 1] !== undefined ? subs[n - 1] : '')) : ''),
    getUILanguage: () => 'en',
};
const FR = JSON.parse(fs.readFileSync(path.join(repo, '_locales', 'fr', 'messages.json'), 'utf8'));
const i18nFr = {
    getMessage: (key, subs = []) => (FR[key] ? FR[key].message.replace(/\$(\d)/g, (m, n) => (subs[n - 1] !== undefined ? subs[n - 1] : '')) : ''),
    getUILanguage: () => 'fr',
};

const STORAGE = { serverUrl: 'https://cloud.example/dav', username: 'u', password: 'p', extensionId: 'chrome11111111', autoSyncEnabled: true };
const LOCK_URL = 'https://cloud.example/dav/bookmarks_sync.lock';
const JSON_URL = 'https://cloud.example/dav/bookmarks_sync.json';

function makeBookmarks(runtime) {
    let nextId = 100;
    const nodes = new Map();
    const add = (n) => { nodes.set(n.id, n); return n; };
    add({ id: '0', title: 'root', children: [] });
    add({ id: '1', parentId: '0', title: 'bar', children: [] });
    nodes.get('0').children.push('1');
    const view = (n) => ({ id: n.id, parentId: n.parentId, title: n.title, url: n.url, index: n.parentId ? nodes.get(n.parentId).children.indexOf(n.id) : 0 });
    const fail = (cb, message) => { runtime.lastError = { message }; cb(undefined); runtime.lastError = undefined; };
    const moves = [];
    const api = {
        moves,
        nodes,
        search: ({ title }, cb) => setImmediate(() => cb([...nodes.values()].filter(n => n.title === title).map(view))),
        get: (id, cb) => setImmediate(() => (nodes.has(id) ? cb([view(nodes.get(id))]) : fail(cb, "Can't find bookmark for id."))),
        getChildren: (id, cb) => setImmediate(() => cb(nodes.get(id).children.map(c => view(nodes.get(c))))),
        getSubTree: (id, cb) => setImmediate(() => {
            const build = (n) => ({ ...view(n), children: n.children ? n.children.map(c => build(nodes.get(c))) : undefined });
            cb([build(nodes.get(id))]);
        }),
        // Simulates the browser refusing an entry: an invalid URL, or a folder named BADFOLDER
        create: (d, cb) => setImmediate(() => {
            if ((d.url && d.url.startsWith('chrome://')) || d.title === 'BADFOLDER') return fail(cb, 'refused');
            if (d.parentId && !nodes.has(d.parentId)) return fail(cb, 'Invalid parent');
            const parentId = d.parentId || '1';
            const n = add({ id: String(nextId++), parentId, title: d.title, url: d.url, children: d.url ? undefined : [] });
            nodes.get(parentId).children.push(n.id);
            cb(view(n));
        }),
        move: (id, d, cb) => setImmediate(() => {
            const n = nodes.get(id);
            const target = d.parentId || n.parentId;
            const old = nodes.get(n.parentId).children;
            old.splice(old.indexOf(id), 1);
            const kids = nodes.get(target).children;
            if (d.index !== undefined && d.index > kids.length) { old.push(id); return fail(cb, 'Index out of bounds.'); }
            n.parentId = target;
            if (d.index === undefined) kids.push(id); else kids.splice(d.index, 0, id);
            moves.push({ title: n.title, index: d.index });
            cb(view(n));
        }),
        update: (id, changes, cb) => setImmediate(() => { Object.assign(nodes.get(id), changes); cb(view(nodes.get(id))); }),
        removeTree: () => {},
        // The extension's listeners, so tests can fire browser events
        events: {},
        onCreated: { addListener(f) { api.events.created = f; } },
        onRemoved: { addListener(f) { api.events.removed = f; } },
        onChanged: { addListener(f) { api.events.changed = f; } },
        onMoved: { addListener(f) { api.events.moved = f; } },
    };
    return api;
}

function loadBackground(server, { locale = i18n } = {}) {
    const runtime = { lastError: undefined, onMessage: { addListener() {} }, onInstalled: { addListener(f) { runtime.installed = f; } } };
    const bookmarks = makeBookmarks(runtime);
    const timers = [];
    const log = [];
    const store = { ...STORAGE };
    const control = { gate: null };
    const fetchStub = async (url, opts = {}) => {
        if (control.gate) await control.gate;
        log.push(`${opts.method} ${url.split('/').pop()}`);
        const res = server(url, opts);
        // { network: true } simulates fetch() rejecting (DNS, certificate, offline)
        if (res.network) throw new TypeError('Failed to fetch');
        return {
            status: res.status, ok: res.status >= 200 && res.status < 300, json: async () => res.body,
            text: async () => (typeof res.body === 'string' ? res.body : JSON.stringify(res.body)),
            headers: { get: (h) => (h === 'ETag' ? res.etag || null : null) },
        };
    };
    const badge = { text: '', color: null };
    const storageListeners = [];
    const access = { granted: true };
    const alarms = {};
    const sandbox = {
        chrome: {
            runtime, bookmarks, i18n: locale,
            storage: {
                local: {
                    get: (k, cb) => setImmediate(() => cb({ ...store })),
                    set: (o, cb) => { Object.assign(store, o); setImmediate(() => cb && cb()); },
                    remove: (k) => { delete store[k]; },
                },
                // Tests call storageChanged() to simulate a settings change from the popup
                onChanged: { addListener(f) { storageListeners.push(f); } },
            },
            permissions: { contains: (p, cb) => setImmediate(() => cb(access.granted)) },
            alarms: {
                create: (name, info) => { alarms[name] = info; },
                clear: (name) => { delete alarms[name]; },
                onAlarm: { addListener(f) { alarms.fire = (name) => f({ name }); } },
            },
            action: {
                setBadgeText: ({ text }) => { badge.text = text; },
                setBadgeBackgroundColor: ({ color }) => { badge.color = color; },
            },
        },
        fetch: fetchStub, console: { log() {}, warn() {}, error() {} },
        // Timers are recorded, not run: each test fires them by hand
        setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
        clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].fn = () => {}; },
        TextEncoder, btoa: (s) => Buffer.from(s, 'binary').toString('base64'), Date, URL, Set, Promise, JSON,
    };
    vm.createContext(sandbox);
    vm.runInContext(backgroundSrc, sandbox);
    const seed = async () => {
        const folder = await new Promise(r => bookmarks.create({ parentId: '1', title: '🔄 Bookmark Sync' }, r));
        return folder.id;
    };
    const addLocal = (parentId, title, url) => new Promise(r => bookmarks.create({ parentId, title, url }, r));
    const titlesIn = (id) => bookmarks.nodes.get(id).children.map(c => bookmarks.nodes.get(c).title);
    const flush = () => new Promise(r => setTimeout(r, 30));
    const call = (name) => new Promise((resolve) => sandbox[name](resolve));
    // Runs the onInstalled listener and waits for its async work
    const installed = async (details) => { runtime.installed(details); await flush(); };
    const storageChanged = (changes) => storageListeners.forEach(f => f(changes, 'local'));
    return { sandbox, log, timers, bookmarks, seed, addLocal, titlesIn, flush, call, control, store, installed, badge, access, storageChanged, alarms };
}

// No lock and no remote file yet
const noLock = (url, opts) => {
    if ((url === LOCK_URL || url === JSON_URL) && opts.method === 'GET') return { status: 404 };
    return { status: 201 };
};

const lockedBy = (owner) => (url, opts) => url === LOCK_URL && opts.method === 'GET'
    ? { status: 200, body: { owner, timestamp: Date.now() } } : { status: 201 };

// WebDAV file with an ETag that changes on every write, honouring If-Match / If-None-Match
function davServer(state) {
    state.version = state.version || 1;
    const etag = () => `"v${state.version}"`;
    return (url, opts) => {
        const headers = opts.headers || {};
        if (url === LOCK_URL && opts.method === 'GET') return { status: 404 };
        if (url === JSON_URL && opts.method === 'GET') {
            // decorate simulates a compression proxy rewriting the ETag of the GET response
            const sent = state.decorate ? state.decorate(etag()) : etag();
            return state.remote ? { status: 200, body: state.remote, etag: sent } : { status: 404 };
        }
        if (url === JSON_URL && opts.method === 'PUT') {
            state.puts = (state.puts || 0) + 1;
            state.headers = headers;
            if (headers['If-Match'] && (state.brokenIfMatch || !state.remote || headers['If-Match'] !== etag())) return { status: 412 };
            if (headers['If-None-Match'] === '*' && state.remote) return { status: 412 };
            state.remote = JSON.parse(opts.body);
            state.version++;
            return { status: 201, etag: etag() };
        }
        return { status: 201 };
    };
}

// ------------------------------------------------------------------
// Push
// ------------------------------------------------------------------

test('push: checks the lock, takes it, writes, then releases it', async () => {
    const b = loadBackground(noLock);
    await b.seed();
    const res = await b.call('pushBookmarksToServer');
    await b.flush();
    assert.strictEqual(res.status, 'success');
    assert.deepStrictEqual(b.log, ['GET bookmarks_sync.lock', 'PUT bookmarks_sync.lock', 'GET bookmarks_sync.json', 'PUT bookmarks_sync.json', 'DELETE bookmarks_sync.lock']);
});

test('push: backs off without writing when another device holds the lock', async () => {
    const b = loadBackground(lockedBy('firefox22222222'));
    await b.seed();
    const res = await b.call('pushBookmarksToServer');
    await b.flush();
    assert.strictEqual(res.status, 'locked');
    assert.deepStrictEqual(b.log, ['GET bookmarks_sync.lock']);
});

test("push: Nextcloud's own file lock (423) reads as busy, so the automatic export retries", async () => {
    const b = loadBackground((url, opts) => url === LOCK_URL && opts.method === 'GET' ? { status: 423 } : noLock(url, opts));
    await b.seed();
    const res = await b.call('pushBookmarksToServer');
    assert.strictEqual(res.status, 'locked');
    assert.deepStrictEqual(b.log, ['GET bookmarks_sync.lock']);
});

test('lock removal is retried while Nextcloud answers 423', async () => {
    let deletes = 0;
    const b = loadBackground((url, opts) => {
        if (url === LOCK_URL && opts.method === 'DELETE') return { status: ++deletes < 3 ? 423 : 204 };
        return noLock(url, opts);
    });
    await b.seed();
    assert.strictEqual((await b.call('pushBookmarksToServer')).status, 'success');
    for (const ms of [500, 1000]) {
        await b.flush();
        const wait = b.timers.find(t => t.ms === ms);
        assert.ok(wait, `no retry after ${ms} ms`);
        wait.fn();
    }
    await b.flush();
    assert.strictEqual(deletes, 3);
});

test('push: releases the lock even when the upload fails', async () => {
    const b = loadBackground((url, opts) => {
        if (url === LOCK_URL && opts.method === 'GET') return { status: 404 };
        if (url === JSON_URL) return { status: 500 };
        return { status: 201 };
    });
    await b.seed();
    const res = await b.call('pushBookmarksToServer');
    await b.flush();
    assert.strictEqual(res.status, 'error');
    assert.strictEqual(b.log[b.log.length - 1], 'DELETE bookmarks_sync.lock');
});

test('push: a refused push does not block the next one', async () => {
    let locked = true;
    const b = loadBackground((url, opts) => {
        if (url === LOCK_URL && opts.method === 'GET') return locked ? { status: 200, body: { owner: 'firefox2', timestamp: Date.now() } } : { status: 404 };
        return noLock(url, opts);
    });
    await b.seed();
    assert.strictEqual((await b.call('pushBookmarksToServer')).status, 'locked');
    await b.flush();
    locked = false;
    assert.strictEqual((await b.call('pushBookmarksToServer')).status, 'success');
});

test('auto-push: retries while locked, then exports once', async () => {
    let locked = true;
    const b = loadBackground((url, opts) => {
        if (url === LOCK_URL && opts.method === 'GET') return locked ? { status: 200, body: { owner: 'firefox2', timestamp: Date.now() } } : { status: 404 };
        return noLock(url, opts);
    });
    await b.seed();
    b.sandbox.scheduleAutomaticPush();
    await b.flush();
    assert.strictEqual(b.timers.length, 1);
    b.timers[0].fn();
    await b.flush();
    assert.strictEqual(b.timers.length, 2, 'no retry scheduled');
    assert.ok(!b.log.includes('PUT bookmarks_sync.json'));
    locked = false;
    b.timers[1].fn();
    await b.flush();
    assert.ok(b.log.includes('PUT bookmarks_sync.json'));
    assert.strictEqual(b.timers.length, 2, 'extra retry scheduled after success');
});

test('auto-push: an export fired during a local import is retried, not dropped', async () => {
    const state = { remote: { children: [] } };
    const b = loadBackground(davServer(state));
    const id = await b.seed();
    await b.addLocal(id, 'L', 'https://l.example/');
    // Synced before with an empty server: L is a local addition, kept by the import
    b.store.syncBase = { fileUrl: JSON_URL, children: [] };
    b.sandbox.scheduleAutomaticPush();
    await b.flush();
    assert.strictEqual(b.timers.length, 1);
    let open;
    b.control.gate = new Promise(r => { open = r; });
    const pulling = b.call('pullBookmarksFromServer');
    await b.flush();
    b.timers[0].fn();
    await b.flush();
    assert.strictEqual(b.timers.length, 2, 'export dropped during the import');
    b.control.gate = null;
    open();
    await pulling;
    await b.flush();
    // The import kept L and scheduled its own export, superseding the retry
    b.timers[b.timers.length - 1].fn();
    await b.flush();
    assert.ok(b.log.includes('PUT bookmarks_sync.json'));
});

test('auto-push: an export scheduled before auto-sync was turned off does not run', async () => {
    const b = loadBackground(noLock);
    await b.seed();
    b.sandbox.scheduleAutomaticPush();
    await b.flush();
    assert.strictEqual(b.timers.length, 1);
    b.store.autoSyncEnabled = false;
    await b.timers[0].fn();
    await b.flush();
    assert.deepStrictEqual(b.log, []);
});

test('auto-push: bookmark events during an import schedule nothing', async () => {
    const state = { remote: { children: [] } };
    const b = loadBackground(davServer(state));
    await b.seed();
    let open;
    b.control.gate = new Promise(r => { open = r; });
    const pulling = b.call('pullBookmarksFromServer');
    await b.flush();
    b.sandbox.scheduleAutomaticPush();
    await b.flush();
    assert.strictEqual(b.timers.filter(t => t.ms === 5000).length, 0);
    b.control.gate = null;
    open();
    await pulling;
});

// ------------------------------------------------------------------
// Pull
// ------------------------------------------------------------------

test('pull: refused entries are skipped and counted, positions stay contiguous', async () => {
    const remote = { children: [
        { title: 'A', url: 'https://a.example/' },
        { title: 'Bad', url: 'chrome://extensions/' },
        { title: 'BADFOLDER', children: [{ title: 'X', url: 'https://x.example/' }] },
        { title: 'B', url: 'https://b.example/' },
    ] };
    const b = loadBackground((url, opts) => {
        if (url === LOCK_URL && opts.method === 'GET') return { status: 404 };
        if (url === JSON_URL) return { status: 200, body: remote };
        return { status: 201 };
    });
    const id = await b.seed();
    const res = await b.call('pullBookmarksFromServer');
    await b.flush();
    assert.strictEqual(res.status, 'success', res.message);
    assert.strictEqual(res.message, '2 added, 2 skipped.');
    const titles = b.bookmarks.nodes.get(id).children.map(c => b.bookmarks.nodes.get(c).title);
    assert.deepStrictEqual(titles, ['A', 'B']);
    assert.deepStrictEqual(b.bookmarks.moves.map(m => m.index), [0, 1]);
});

test('pull: plain message when nothing is skipped, lock released at the end', async () => {
    const b = loadBackground((url, opts) => {
        if (url === LOCK_URL && opts.method === 'GET') return { status: 404 };
        if (url === JSON_URL) return { status: 200, body: { children: [{ title: 'A', url: 'https://a.example/' }] } };
        return { status: 201 };
    });
    await b.seed();
    const res = await b.call('pullBookmarksFromServer');
    await b.flush();
    assert.strictEqual(res.message, '1 added.');
    assert.strictEqual(b.log[b.log.length - 1], 'DELETE bookmarks_sync.lock');
    assert.ok(!b.timers.some(t => t.ms === 2000), 'delayed lock removal still scheduled');
});

test('pull: backs off when another device holds the lock', async () => {
    const b = loadBackground(lockedBy('firefox2'));
    await b.seed();
    const res = await b.call('pullBookmarksFromServer');
    assert.strictEqual(res.status, 'locked');
    assert.deepStrictEqual(b.log, ['GET bookmarks_sync.lock']);
});

test('pull: the sync ends only once its lock is released, so the next sync keeps its own', async () => {
    const state = { remote: { children: [] } };
    const b = loadBackground(davServer(state));
    const id = await b.seed();
    await b.call('pullBookmarksFromServer');
    await b.flush();
    await b.addLocal(id, 'L', 'https://l.example/');
    assert.strictEqual((await b.call('pushBookmarksToServer')).status, 'success');
    await b.flush();
    // Each sync removed its own lock once, in order
    const lockOps = b.log.filter(l => l.endsWith('bookmarks_sync.lock') && !l.startsWith('GET'));
    assert.deepStrictEqual(lockOps, ['PUT bookmarks_sync.lock', 'DELETE bookmarks_sync.lock', 'PUT bookmarks_sync.lock', 'DELETE bookmarks_sync.lock']);
});

test('pull: a lock file with a non-string owner is ignored', async () => {
    const state = { remote: { children: [] } };
    const server = davServer(state);
    const b = loadBackground((url, opts) => (url === LOCK_URL && opts.method === 'GET')
        ? { status: 200, body: { owner: 123, timestamp: Date.now() } } : server(url, opts));
    await b.seed();
    const res = await Promise.race([b.call('pullBookmarksFromServer'), new Promise(r => setTimeout(() => r({ status: 'HANG' }), 200))]);
    assert.strictEqual(res.status, 'success');
});

// ------------------------------------------------------------------
// Three-way merge
// ------------------------------------------------------------------

const bm = (title, url) => ({ title, url: url || `https://${title.toLowerCase()}.example/` });
const dir = (title, children) => ({ title, children });
const merge = (base, local, remote) => JSON.parse(JSON.stringify(loadBackground(noLock).sandbox.mergeChildren(base, local, remote)));
const titles = (nodes) => [...nodes].map(n => n.title); // Copies arrays from the vm realm

test('merge: additions on both sides are kept, each before its next sibling', () => {
    const r = merge([bm('A'), bm('B')], [bm('A'), bm('L'), bm('B')], [bm('A'), bm('B'), bm('R')]);
    assert.deepStrictEqual(titles(r), ['A', 'L', 'B', 'R']);
});

test('merge: a deletion on either side is applied', () => {
    const r = merge([bm('A'), bm('B'), bm('C')], [bm('A'), bm('C')], [bm('A'), bm('B')]);
    assert.deepStrictEqual(titles(r), ['A']);
});

test('merge: without a base nothing is deleted (union)', () => {
    const r = merge(null, [bm('A'), bm('L')], [bm('A'), bm('R')]);
    // Both were appended: the local one goes after the remote order
    assert.deepStrictEqual(titles(r), ['A', 'R', 'L']);
});

test('merge: a renamed bookmark takes the side that changed it', () => {
    const base = [bm('A', 'https://a/'), bm('B', 'https://b/')];
    const r = merge(base, [bm('A2', 'https://a/'), bm('B', 'https://b/')], [bm('A', 'https://a/'), bm('B2', 'https://b/')]);
    assert.deepStrictEqual(titles(r), ['A2', 'B2']);
});

test('merge: folders merge recursively', () => {
    const base = [dir('F', [bm('A')])];
    const r = merge(base, [dir('F', [bm('A'), bm('L')])], [dir('F', [bm('A'), bm('R')])]);
    assert.deepStrictEqual(r, [dir('F', [bm('A'), bm('L'), bm('R')])]);
});

test('merge: a folder deleted on one side keeps only what the other side added', () => {
    const base = [dir('F', [bm('A')])];
    assert.deepStrictEqual(merge(base, [], [dir('F', [bm('A'), bm('R')])]), [dir('F', [bm('R')])]);
    assert.deepStrictEqual(merge(base, [], [dir('F', [bm('A')])]), []);
});

test('merge: duplicate URLs are matched one to one', () => {
    // Two in the base, one deleted remotely, one added locally: two remain
    assert.deepStrictEqual(titles(merge([bm('A'), bm('A')], [bm('A'), bm('A'), bm('A')], [bm('A')])), ['A', 'A']);
    assert.deepStrictEqual(titles(merge([bm('A'), bm('A')], [bm('A'), bm('A')], [bm('A')])), ['A']);
    assert.deepStrictEqual(titles(merge([bm('A')], [bm('A'), bm('A')], [bm('A')])), ['A', 'A']);
});

// ------------------------------------------------------------------
// Two devices
// ------------------------------------------------------------------

async function deviceWith(state, base, localItems) {
    const b = loadBackground(davServer(state));
    const id = await b.seed();
    for (const item of localItems) await b.addLocal(id, item.title, item.url);
    if (base) b.store.syncBase = { fileUrl: JSON_URL, children: base };
    return { b, id };
}

test("push: merges another device's export instead of overwriting it", async () => {
    // This device last synced [A], then added L; meanwhile the other device exported [A, R]
    const state = { remote: { title: 'root', children: [bm('A'), bm('R')] } };
    const { b, id } = await deviceWith(state, [bm('A')], [bm('A'), bm('L')]);
    const res = await b.call('pushBookmarksToServer');
    await b.flush();
    assert.strictEqual(res.status, 'success', res.message);
    assert.strictEqual(res.message, '1 added · changes sent');
    assert.deepStrictEqual(titles(state.remote.children), ['A', 'L', 'R']);
    assert.deepStrictEqual(b.titlesIn(id), ['A', 'L', 'R']);
    assert.strictEqual(state.headers['If-Match'], '"v1"');
    assert.deepStrictEqual(titles(b.store.syncBase.children), ['A', 'L', 'R']);
});

test('push: applies a deletion made on the other device, via the archive', async () => {
    const state = { remote: { title: 'root', children: [bm('A')] } };
    const { b, id } = await deviceWith(state, [bm('A'), bm('B')], [bm('A'), bm('B')]);
    await b.call('pushBookmarksToServer');
    await b.flush();
    assert.deepStrictEqual(b.titlesIn(id), ['A']);
    assert.deepStrictEqual(titles(state.remote.children), ['A']);
});

test('push: uploads local as is when the remote is unchanged since the last sync', async () => {
    const state = { remote: { title: 'root', children: [bm('A'), bm('B')] } };
    const { b } = await deviceWith(state, [bm('A'), bm('B')], [bm('A')]);
    const res = await b.call('pushBookmarksToServer');
    assert.strictEqual(res.message, 'Changes sent.');
    assert.deepStrictEqual(titles(state.remote.children), ['A']);
});

test('push: a write between our read and our upload is refused (412), nothing overwritten', async () => {
    const state = { remote: { title: 'root', children: [bm('A')] } };
    const server = davServer(state);
    const b = loadBackground((url, opts) => {
        // The other device writes right after our GET
        if (url === JSON_URL && opts.method === 'PUT' && !state.raced) {
            state.raced = true;
            state.remote = { title: 'root', children: [bm('A'), bm('R')] };
            state.version++;
        }
        return server(url, opts);
    });
    const id = await b.seed();
    await b.addLocal(id, 'A', bm('A').url);
    await b.addLocal(id, 'L', bm('L').url);
    b.store.syncBase = { fileUrl: JSON_URL, children: [bm('A')] };
    const res = await b.call('pushBookmarksToServer');
    await b.flush();
    assert.strictEqual(res.status, 'locked');
    assert.deepStrictEqual(titles(state.remote.children), ['A', 'R']);
    assert.deepStrictEqual(titles(b.store.syncBase.children), ['A'], 'base advanced on a failed push');
    assert.strictEqual(b.log[b.log.length - 1], 'DELETE bookmarks_sync.lock');
});

test('push: first export creates the file with If-None-Match', async () => {
    const state = { remote: null };
    const { b } = await deviceWith(state, null, [bm('A')]);
    const res = await b.call('pushBookmarksToServer');
    assert.strictEqual(res.status, 'success', res.message);
    assert.strictEqual(state.headers['If-None-Match'], '*');
    assert.deepStrictEqual(titles(state.remote.children), ['A']);
});

test('push: a base saved for another server is ignored', async () => {
    // With that base, Z would read as deleted locally and be removed from this server
    const state = { remote: { title: 'root', children: [bm('A'), bm('Z')] } };
    const { b, id } = await deviceWith(state, null, [bm('A')]);
    b.store.syncBase = { fileUrl: 'https://old.example/bookmarks_sync.json', children: [bm('A'), bm('Z')] };
    await b.call('pushBookmarksToServer');
    await b.flush();
    assert.deepStrictEqual(titles(state.remote.children), ['A', 'Z']);
    assert.deepStrictEqual(b.titlesIn(id), ['A', 'Z']);
});

test('push: without a base both sides are kept (fresh install exporting its bookmarks)', async () => {
    const state = { remote: { title: 'root', children: [bm('A'), bm('R')] } };
    const { b, id } = await deviceWith(state, null, [bm('A'), bm('X')]);
    const res = await b.call('pushBookmarksToServer');
    await b.flush();
    assert.strictEqual(res.status, 'success', res.message);
    assert.deepStrictEqual(b.titlesIn(id), ['A', 'R', 'X']);
    assert.deepStrictEqual(titles(state.remote.children), ['A', 'R', 'X']);
});

test('lock: an unreadable lock file is ignored instead of blocking every device', async () => {
    const state = { remote: null };
    const server = davServer(state);
    const b = loadBackground((url, opts) => (url === LOCK_URL && opts.method === 'GET') ? { status: 200, body: undefined } : server(url, opts));
    const id = await b.seed();
    await b.addLocal(id, 'A', bm('A').url);
    // response.json() rejects, as on an empty or truncated file
    b.sandbox.fetch = ((orig) => async (u, o) => {
        const r = await orig(u, o);
        if (u === LOCK_URL && (o.method || 'GET') === 'GET') r.json = async () => { throw new SyntaxError('Unexpected end of JSON input'); };
        return r;
    })(b.sandbox.fetch);
    const res = await b.call('pushBookmarksToServer');
    assert.strictEqual(res.status, 'success', res.message);
});

test("lock: Nextcloud's 423 when creating the lock reads as busy, so the export retries", async () => {
    const b = loadBackground((url, opts) => (url === LOCK_URL && opts.method === 'PUT') ? { status: 423 } : noLock(url, opts));
    await b.seed();
    const res = await b.call('pushBookmarksToServer');
    assert.strictEqual(res.status, 'locked');
    assert.ok(!b.log.includes('PUT bookmarks_sync.json'));
});

test('auto-push: a bookmark event during a sync is ignored before the async settings read', async () => {
    const b = loadBackground(noLock);
    await b.seed();
    vm.runInContext('isSyncing = true', b.sandbox);
    // The sync ends before the storage callback would have run
    b.sandbox.scheduleAutomaticPush();
    vm.runInContext('isSyncing = false', b.sandbox);
    await b.flush();
    assert.strictEqual(b.timers.filter(t => t.ms === 5000).length, 0);
});

test('update: the current folder becomes the base, so a deletion right after is kept', async () => {
    const state = { remote: { title: 'root', children: [bm('A'), bm('X')] } };
    const { b, id } = await deviceWith(state, null, [bm('A'), bm('X')]);
    await b.installed({ reason: 'update' });
    assert.deepStrictEqual(titles(b.store.syncBase.children), ['A', 'X']);
    // The user deletes X, then the automatic export runs
    const x = b.bookmarks.nodes.get(id).children.find(c => b.bookmarks.nodes.get(c).title === 'X');
    b.bookmarks.nodes.get(id).children.splice(b.bookmarks.nodes.get(id).children.indexOf(x), 1);
    await b.call('pushBookmarksToServer');
    await b.flush();
    assert.deepStrictEqual(titles(state.remote.children), ['A']);
    assert.deepStrictEqual(b.titlesIn(id), ['A']);
});

test('update: an existing base or a fresh install is left alone', async () => {
    const state = { remote: null };
    const { b } = await deviceWith(state, [bm('Q')], [bm('A')]);
    await b.installed({ reason: 'update' });
    assert.deepStrictEqual(titles(b.store.syncBase.children), ['Q']);
    const fresh = await deviceWith(state, null, [bm('A')]);
    await fresh.b.installed({ reason: 'install' });
    assert.strictEqual(fresh.b.store.syncBase, undefined);
});

test('sync: an entry this browser refuses is never deleted from the server', async () => {
    const bad = bm('Bad', 'chrome://extensions/');
    const state = { remote: { title: 'root', children: [bm('A'), bad] } };
    const { b, id } = await deviceWith(state, [bm('A')], [bm('A')]);
    for (let i = 0; i < 2; i++) {
        await b.call('pullBookmarksFromServer');
        await b.flush();
        assert.ok(!b.timers.some(t => t.ms === 5000), `pull ${i + 1} scheduled an export`);
    }
    await b.addLocal(id, 'L', bm('L').url);
    for (let i = 0; i < 2; i++) {
        assert.strictEqual((await b.call('pushBookmarksToServer')).status, 'success');
        await b.flush();
    }
    assert.deepStrictEqual(titles(state.remote.children).sort(), ['A', 'Bad', 'L']);
    assert.ok(!titles(b.store.syncBase.children).includes('Bad'));
});

test('push: a failed upload after a merge leaves the remote we read as the base', async () => {
    const state = { remote: { title: 'root', children: [bm('A'), bm('R')] } };
    const server = davServer(state);
    const b = loadBackground((url, opts) => (url === JSON_URL && opts.method === 'PUT') ? { status: 503 } : server(url, opts));
    const id = await b.seed();
    await b.addLocal(id, 'A', bm('A').url);
    await b.addLocal(id, 'L', bm('L').url);
    b.store.syncBase = { fileUrl: JSON_URL, children: [bm('A')] };
    assert.strictEqual((await b.call('pushBookmarksToServer')).status, 'error');
    assert.deepStrictEqual(b.titlesIn(id).sort(), ['A', 'L', 'R']);
    assert.deepStrictEqual(titles(b.store.syncBase.children), ['A', 'R']);
});

test('pull: keeps local changes not exported yet, then schedules an export', async () => {
    const state = { remote: { title: 'root', children: [bm('A'), bm('R')] } };
    const { b, id } = await deviceWith(state, [bm('A')], [bm('A'), bm('L')]);
    const res = await b.call('pullBookmarksFromServer');
    await b.flush();
    assert.strictEqual(res.status, 'success', res.message);
    assert.deepStrictEqual(b.titlesIn(id), ['A', 'L', 'R']);
    assert.deepStrictEqual(titles(b.store.syncBase.children), ['A', 'R']);
    assert.ok(b.timers.some(t => t.ms === 5000), 'export not scheduled');
});

test('pull: archives what the other device deleted, applies its renames', async () => {
    const state = { remote: { title: 'root', children: [bm('A2', 'https://a.example/')] } };
    const { b, id } = await deviceWith(state, [bm('A'), bm('B')], [bm('A'), bm('B')]);
    const res = await b.call('pullBookmarksFromServer');
    assert.strictEqual(res.message, '1 archived, 1 renamed.');
    await b.flush();
    assert.deepStrictEqual(b.titlesIn(id), ['A2']);
    assert.ok(!b.timers.some(t => t.ms === 5000), 'useless export scheduled');
});

test('push: an ETag rewritten by a compression proxy still matches (weak, -gzip)', async () => {
    for (const decorate of [(e) => `W/${e}`, (e) => e.replace(/"$/, '-gzip"')]) {
        const state = { remote: { title: 'root', children: [bm('A')] }, decorate };
        const { b } = await deviceWith(state, [bm('A')], [bm('A'), bm('B')]);
        const res = await b.call('pushBookmarksToServer');
        assert.strictEqual(res.status, 'success', res.message);
        assert.strictEqual(state.headers['If-Match'], '"v1"');
        assert.deepStrictEqual(titles(state.remote.children), ['A', 'B']);
    }
});

test('push: falls back to an unconditional upload when the server never matches the ETag', async () => {
    const state = { remote: { title: 'root', children: [bm('A')] }, brokenIfMatch: true };
    const { b } = await deviceWith(state, [bm('A')], [bm('A'), bm('B')]);
    const res = await b.call('pushBookmarksToServer');
    assert.strictEqual(res.status, 'success', res.message);
    assert.strictEqual(state.puts, 2);
    assert.deepStrictEqual(titles(state.remote.children), ['A', 'B']);
});

test('push: replaces an invalid remote file instead of failing', async () => {
    for (const broken of ['not json', null, { children: 'oops' }]) {
        const state = { remote: broken };
        const server = davServer(state);
        const b = loadBackground((url, opts) => {
            if (url === JSON_URL && opts.method === 'GET') return { status: 200, body: broken, etag: '"v1"' };
            return server(url, opts);
        });
        const id = await b.seed();
        await b.addLocal(id, 'A', bm('A').url);
        // A non-JSON body makes response.json() throw
        if (broken === 'not json') b.sandbox.fetch = ((orig) => async (u, o) => {
            const r = await orig(u, o);
            if (u === JSON_URL && o.method === 'GET') r.json = async () => { throw new SyntaxError('bad'); };
            return r;
        })(b.sandbox.fetch);
        const res = await b.call('pushBookmarksToServer');
        assert.strictEqual(res.status, 'success', `${JSON.stringify(broken)}: ${res.message}`);
        assert.deepStrictEqual(titles(state.remote.children), ['A']);
    }
});

test('pull: an invalid remote file is reported, nothing changes locally', async () => {
    const b = loadBackground((url, opts) => {
        if (url === LOCK_URL && opts.method === 'GET') return { status: 404 };
        if (url === JSON_URL && opts.method === 'GET') return { status: 200, body: { children: 'oops' } };
        return { status: 201 };
    });
    const id = await b.seed();
    await b.addLocal(id, 'A', bm('A').url);
    const res = await b.call('pullBookmarksFromServer');
    assert.strictEqual(res.message, 'The bookmarks file on the server is invalid. Sync now to replace it.');
    assert.deepStrictEqual(b.titlesIn(id), ['A']);
});

test('pull: without a base both sides are kept, nothing is archived', async () => {
    const state = { remote: { title: 'root', children: [bm('A'), bm('R')] } };
    const { b, id } = await deviceWith(state, null, [bm('A'), bm('X')]);
    const res = await b.call('pullBookmarksFromServer');
    await b.flush();
    assert.strictEqual(res.message, '1 added.');
    assert.deepStrictEqual(b.titlesIn(id), ['A', 'R', 'X']);
    assert.ok(b.timers.some(t => t.ms === 5000), 'X not scheduled for export');
});

test('pull: a local reorder survives when the remote order is unchanged', async () => {
    const state = { remote: { title: 'root', children: [bm('A'), bm('B'), bm('R')] } };
    const { b, id } = await deviceWith(state, [bm('A'), bm('B')], [bm('B'), bm('A')]);
    await b.call('pullBookmarksFromServer');
    await b.flush();
    assert.deepStrictEqual(b.titlesIn(id), ['B', 'A', 'R']);
    assert.ok(b.timers.some(t => t.ms === 5000), 'reorder not exported');
});

test('merge: the remote order wins when both sides reordered', () => {
    const r = merge([bm('A'), bm('B'), bm('C')], [bm('B'), bm('A'), bm('C')], [bm('C'), bm('A'), bm('B')]);
    assert.deepStrictEqual(titles(r), ['C', 'A', 'B']);
});

test('push: after a 412 the remote read becomes the base, so a third-device deletion still applies', async () => {
    // Base [A]; remote [A, R] (R added elsewhere); our PUT races with a third device deleting R
    const state = { remote: { title: 'root', children: [bm('A'), bm('R')] } };
    const server = davServer(state);
    const b = loadBackground((url, opts) => {
        if (url === JSON_URL && opts.method === 'PUT' && !state.raced) {
            state.raced = true;
            state.remote = { title: 'root', children: [bm('A')] };
            state.version++;
        }
        return server(url, opts);
    });
    const id = await b.seed();
    await b.addLocal(id, 'A', bm('A').url);
    await b.addLocal(id, 'L', bm('L').url);
    b.store.syncBase = { fileUrl: JSON_URL, children: [bm('A')] };
    assert.strictEqual((await b.call('pushBookmarksToServer')).status, 'locked');
    await b.flush();
    assert.deepStrictEqual(b.titlesIn(id).sort(), ['A', 'L', 'R'], 'merge applied locally');
    assert.strictEqual((await b.call('pushBookmarksToServer')).status, 'success');
    await b.flush();
    assert.deepStrictEqual(titles(state.remote.children), ['A', 'L'], 'R resurrected');
    assert.deepStrictEqual(b.titlesIn(id), ['A', 'L']);
});

// ------------------------------------------------------------------
// Error messages, sync status, connection test
// ------------------------------------------------------------------

const lockGet = (status) => (url, opts) => (url === LOCK_URL && opts.method === 'GET') ? status : noLock(url, opts);

test('errors: each server failure says what to fix', async () => {
    const cases = [
        [lockGet({ status: 401 }), 'Wrong username or app password.'],
        [lockGet({ status: 404 }), null], // 404 on the lock only means "no lock"
        [(url, opts) => (url === LOCK_URL && opts.method === 'PUT') ? { status: 409 } : noLock(url, opts), 'Folder not found. Create it in Nextcloud Files first.'],
        [(url, opts) => (url === LOCK_URL && opts.method === 'PUT') ? { status: 405 } : noLock(url, opts), /^Not a WebDAV folder URL\. Use https:\/\//],
        [(url, opts) => (url === JSON_URL && opts.method === 'PUT') ? { status: 507 } : noLock(url, opts), 'Not enough storage space on the server.'],
        [(url, opts) => (url === JSON_URL && opts.method === 'GET') ? { status: 503 } : noLock(url, opts), 'Nextcloud server error (HTTP 503).'],
        [lockGet({ network: true }), 'Server unreachable. Check the URL and your connection.'],
        [(url, opts) => (url === JSON_URL && opts.method === 'PUT') ? { network: true } : noLock(url, opts), 'Server unreachable. Check the URL and your connection.'],
    ];
    for (const [server, expected] of cases) {
        const b = loadBackground(server);
        await b.seed();
        const res = await b.call('pushBookmarksToServer');
        if (expected === null) {
            assert.strictEqual(res.status, 'success', res.message);
        } else {
            assert.strictEqual(res.status, 'error');
            if (expected instanceof RegExp) assert.match(res.message, expected); else assert.strictEqual(res.message, expected);
        }
    }
});

test('errors: an import against a missing file explains what to do', async () => {
    const b = loadBackground(noLock);
    await b.seed();
    const res = await b.call('pullBookmarksFromServer');
    assert.strictEqual(res.message, 'No bookmarks file on the server yet: sync from a device first.');
});

test('errors: syncing before setup points to the settings', async () => {
    const b = loadBackground(noLock);
    delete b.store.serverUrl;
    const res = await b.call('pushBookmarksToServer');
    assert.strictEqual(res.message, 'Not set up yet: open Settings (⚙️).');
});

test('status: a failed sync is recorded and flagged on the icon, a success clears it', async () => {
    let fail = true;
    const b = loadBackground((url, opts) => (fail && url === LOCK_URL && opts.method === 'GET') ? { status: 401 } : noLock(url, opts));
    await b.seed();
    await b.call('pushBookmarksToServer');
    await b.flush();
    assert.strictEqual(b.store.lastSync.kind, 'sync');
    assert.strictEqual(b.store.lastSync.ok, false);
    assert.strictEqual(b.store.lastSync.message, 'Wrong username or app password.');
    assert.strictEqual(b.badge.text, '!');
    fail = false;
    await b.call('pushBookmarksToServer');
    await b.flush();
    assert.strictEqual(b.store.lastSync.ok, true);
    assert.strictEqual(b.badge.text, '');
});

test('status: a busy server (locked) is not recorded as a failure', async () => {
    const b = loadBackground(lockedBy('firefox2'));
    await b.seed();
    await b.call('pushBookmarksToServer');
    await b.flush();
    assert.strictEqual(b.store.lastSync, undefined);
    assert.strictEqual(b.badge.text, '');
});

const propfind = (status, body = '') => (url, opts) => (opts.method === 'PROPFIND' ? { status, body } : { status: 404 });
const FOLDER = '<d:multistatus><d:response><d:href>/dav/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>';
const testConnection = (server, settings = { serverUrl: 'https://cloud.example/dav', username: 'u', password: 'p' }) =>
    loadBackground(server).sandbox.testConnection(settings);

test('connection test: a reachable folder, with or without the bookmarks file', async () => {
    let r = await testConnection(propfind(207, FOLDER + '<d:response><d:href>/dav/bookmarks_sync.json</d:href></d:response></d:multistatus>'));
    assert.deepStrictEqual([r.status, r.message], ['success', 'Connected. Bookmarks file found on the server.']);
    r = await testConnection(propfind(207, FOLDER + '</d:multistatus>'));
    assert.deepStrictEqual([r.status, r.message], ['success', 'Connected. No bookmarks file yet: Sync now creates it.']);
});

test('connection test: each problem gets its own message', async () => {
    const cases = [
        [propfind(401), 'Wrong username or app password.'],
        [propfind(404), 'Folder not found. Create it in Nextcloud Files first.'],
        [propfind(200, '<html>Nextcloud login</html>'), /^Not a WebDAV folder URL\./],
        [propfind(405), /^Not a WebDAV folder URL\./],
        [propfind(207, '<d:multistatus><d:response><d:resourcetype/></d:response></d:multistatus>'), 'This URL points to a file. Use the URL of a folder.'],
        [() => ({ network: true }), 'Server unreachable. Check the URL and your connection.'],
    ];
    for (const [server, expected] of cases) {
        const r = await testConnection(server);
        assert.strictEqual(r.status, 'error');
        if (expected instanceof RegExp) assert.match(r.message, expected); else assert.strictEqual(r.message, expected);
    }
    const r = await testConnection(propfind(207, FOLDER), { serverUrl: 'https://c.example/dav', username: '', password: '' });
    assert.strictEqual(r.message, 'Fill in the folder URL, username and app password.');
});

test('connection test: PROPFIND on the folder with the typed credentials', async () => {
    const seen = [];
    await testConnection((url, opts) => { seen.push({ url, method: opts.method, auth: opts.headers.Authorization, depth: opts.headers.Depth }); return { status: 207, body: FOLDER }; },
        { serverUrl: 'https://cloud.example/dav', username: 'alice', password: 'pä' });
    assert.deepStrictEqual(seen, [{ url: 'https://cloud.example/dav/', method: 'PROPFIND', auth: 'Basic ' + Buffer.from('alice:pä').toString('base64'), depth: '1' }]);
});


test("errors: Nextcloud's 423 on the bookmarks file is busy (retried), not a failure", async () => {
    for (const method of ['GET', 'PUT']) {
        const b = loadBackground((url, opts) => (url === JSON_URL && opts.method === method) ? { status: 423 } : noLock(url, opts));
        await b.seed();
        const res = await b.call('pushBookmarksToServer');
        await b.flush();
        assert.deepStrictEqual([res.status, res.message], ['locked', 'Another device is syncing.'], method);
        assert.strictEqual(b.store.lastSync, undefined);
        assert.strictEqual(b.badge.text, '');
    }
});

test('errors: a missing host permission is reported as such, without contacting the server', async () => {
    const b = loadBackground(noLock);
    b.access.granted = false;
    await b.seed();
    const res = await b.call('pushBookmarksToServer');
    assert.match(res.message, /^No access to your Nextcloud server yet/);
    assert.deepStrictEqual(b.log, []);
});

test('errors: a non-network bug is not reported as "server unreachable"', () => {
    const b = loadBackground(noLock);
    const res = b.sandbox.failureResponse(new TypeError("Cannot read properties of undefined (reading 'parentId')"), 'Export failed.');
    assert.strictEqual(res.message, 'Export failed.');
});

test("errors: Nextcloud's brute-force protection (429) gets its own message", async () => {
    const b = loadBackground(lockGet({ status: 429 }));
    await b.seed();
    const res = await b.call('pushBookmarksToServer');
    assert.strictEqual(res.message, 'Too many failed logins. Wait a moment, then check the app password.');
});

test('status: "not set up" and "no file yet" are shown but not flagged on the icon', async () => {
    let b = loadBackground(noLock);
    delete b.store.serverUrl;
    await b.call('pushBookmarksToServer');
    await b.flush();
    assert.strictEqual(b.badge.text, '');
    b = loadBackground(noLock);
    await b.seed();
    const res = await b.call('pullBookmarksFromServer');
    await b.flush();
    assert.strictEqual(res.status, 'error');
    assert.strictEqual(b.store.lastSync, undefined);
    assert.strictEqual(b.badge.text, '');
});

test('status: changing the server settings clears a recorded failure and the badge', async () => {
    const b = loadBackground(lockGet({ status: 401 }));
    await b.seed();
    await b.call('pushBookmarksToServer');
    await b.flush();
    assert.strictEqual(b.badge.text, '!');
    b.storageChanged({ autoSyncEnabled: { newValue: false } });
    assert.strictEqual(b.badge.text, '!', 'unrelated setting cleared it');
    b.storageChanged({ password: { newValue: 'fixed' } });
    assert.strictEqual(b.store.lastSync, undefined);
    assert.strictEqual(b.badge.text, '');
});

test('connection test: other files with a similar name are not the bookmarks file', async () => {
    const body = FOLDER + '<d:response><d:href>/dav/old_bookmarks_sync.json</d:href></d:response>'
        + '<d:response><d:href>/dav/bookmarks_sync.json.bak</d:href></d:response></d:multistatus>';
    const r = await testConnection(propfind(207, body));
    assert.strictEqual(r.message, 'Connected. No bookmarks file yet: Sync now creates it.');
});



// ------------------------------------------------------------------
// Fewer exports, service worker robustness, old-version devices
// ------------------------------------------------------------------

test('push: nothing new for the server means no upload', async () => {
    const state = { remote: { title: 'root', children: [bm('A')] } };
    const { b } = await deviceWith(state, [bm('A')], [bm('A')]);
    const res = await b.call('pushBookmarksToServer');
    await b.flush();
    assert.deepStrictEqual([res.status, res.message], ['success', 'Up to date.']);
    assert.strictEqual(state.puts, undefined);
    assert.strictEqual(b.log[b.log.length - 1], 'DELETE bookmarks_sync.lock');
});

test('push: remote changes applied locally with nothing to send back skip the upload too', async () => {
    const state = { remote: { title: 'root', children: [bm('A'), bm('R')] } };
    const { b, id } = await deviceWith(state, [bm('A')], [bm('A')]);
    const res = await b.call('pushBookmarksToServer');
    await b.flush();
    assert.strictEqual(res.message, '1 added.');
    assert.strictEqual(state.puts, undefined);
    assert.deepStrictEqual(b.titlesIn(id), ['A', 'R']);
    assert.deepStrictEqual(titles(b.store.syncBase.children), ['A', 'R']);
});

test('auto-push: only changes inside the sync folder schedule an export', async () => {
    const b = loadBackground(noLock);
    const syncId = await b.seed();
    const sub = await b.addLocal(syncId, 'Sub');
    const outside = await b.addLocal('1', 'Elsewhere', 'https://elsewhere.example/');
    const exports = () => b.timers.filter(t => t.ms === 5000).length;
    const ev = b.bookmarks.events;

    ev.created(outside.id, { parentId: '1' });
    ev.changed(outside.id);
    ev.removed('999', { parentId: '1' });
    ev.moved(outside.id, { parentId: '1', oldParentId: '1' });
    await b.flush();
    assert.strictEqual(exports(), 0, 'export for a change outside the folder');

    ev.created('x', { parentId: sub.id }); // nested inside the sync folder
    await b.flush();
    assert.strictEqual(exports(), 1);
    ev.moved(outside.id, { parentId: '1', oldParentId: syncId }); // moved out of it
    await b.flush();
    assert.strictEqual(exports(), 2);
});

test('auto-push: a change made during a sync is exported once the sync ends', async () => {
    const b = loadBackground(noLock);
    const syncId = await b.seed();
    vm.runInContext('isSyncing = true', b.sandbox);
    b.bookmarks.events.created('x', { parentId: syncId });
    await b.flush();
    assert.strictEqual(b.timers.filter(t => t.ms === 5000).length, 0, 'export during the sync');
    b.sandbox.endSync();
    await b.flush();
    assert.strictEqual(b.timers.filter(t => t.ms === 5000).length, 1, 'change dropped');
});

test('auto-push: a sync without changes ends without scheduling an export', async () => {
    const b = loadBackground(noLock);
    await b.seed();
    vm.runInContext('isSyncing = true', b.sandbox);
    b.sandbox.endSync();
    await b.flush();
    assert.strictEqual(b.timers.length, 0);
});

test('auto-push: a backup alarm is set with the timer, cleared once the export ran', async () => {
    const state = { remote: null };
    const b = loadBackground(davServer(state));
    const id = await b.seed();
    await b.addLocal(id, 'L', 'https://l.example/');
    b.sandbox.scheduleAutomaticPush();
    await b.flush();
    assert.deepStrictEqual(JSON.parse(JSON.stringify(b.alarms.pendingExport)), { delayInMinutes: 1 });
    b.timers[0].fn();
    await b.flush();
    assert.strictEqual(b.alarms.pendingExport, undefined);
    assert.deepStrictEqual(titles(state.remote.children), ['L']);
});

test('auto-push: the backup alarm exports if the service worker lost the timer', async () => {
    const state = { remote: null };
    const b = loadBackground(davServer(state));
    const id = await b.seed();
    await b.addLocal(id, 'L', 'https://l.example/');
    b.alarms.fire('pendingExport'); // as after a service worker restart: no timer any more
    await b.flush();
    assert.deepStrictEqual(titles(state.remote.children), ['L']);
});

test('auto-push: turning auto-sync off clears the backup alarm', async () => {
    const b = loadBackground(noLock);
    await b.seed();
    b.sandbox.scheduleAutomaticPush();
    await b.flush();
    assert.ok(b.alarms.pendingExport);
    b.store.autoSyncEnabled = false;
    vm.runInContext('syncTimeout = null', b.sandbox); // the timer was lost with the worker
    b.alarms.fire('pendingExport');
    await b.flush();
    assert.strictEqual(b.alarms.pendingExport, undefined);
    assert.deepStrictEqual(b.log, []);
});

test('old version: a raw file replacing a new-format one is noted, a 1.6.0+ file is not', async () => {
    const raw = { id: '42', title: '🔄 Bookmark Sync', dateAdded: 1, children: [{ id: '43', title: 'A', url: bm('A').url, dateAdded: 1 }] };
    let b = loadBackground((url, opts) => (url === JSON_URL && opts.method === 'GET') ? { status: 200, body: raw } : noLock(url, opts));
    await b.seed();
    b.store.newFormatSeen = true;
    await b.call('pullBookmarksFromServer');
    await b.flush();
    assert.ok(Date.now() - b.store.legacySeenAt < 1000);

    b = loadBackground((url, opts) => (url === JSON_URL && opts.method === 'GET') ? { status: 200, body: { title: 'root', children: [bm('A')] } } : noLock(url, opts));
    await b.seed();
    await b.call('pullBookmarksFromServer');
    await b.flush();
    assert.strictEqual(b.store.legacySeenAt, undefined);
    assert.strictEqual(b.store.newFormatSeen, true);
});

test("old version: this device's own pre-update file is not reported, and is rewritten", async () => {
    const raw = { id: '42', title: 'root', dateAdded: 1, children: [{ id: '43', title: 'A', url: bm('A').url }] };
    const b = loadBackground((url, opts) => (url === JSON_URL && opts.method === 'GET') ? { status: 200, body: raw } : noLock(url, opts));
    const id = await b.seed();
    await b.addLocal(id, 'A', bm('A').url);
    b.store.syncBase = { fileUrl: JSON_URL, children: [bm('A')] };
    await b.call('pullBookmarksFromServer');
    await b.flush();
    assert.strictEqual(b.store.legacySeenAt, undefined);
    assert.ok(b.timers.some(t => t.ms === 5000), 'old-format file not scheduled for rewrite');
});

test('old version: a raw file is rewritten in the new format even when nothing changed', async () => {
    const raw = { id: '42', title: 'root', dateAdded: 1, children: [{ id: '43', title: 'A', url: bm('A').url }] };
    const state = { remote: raw };
    const { b } = await deviceWith(state, [bm('A')], [bm('A')]);
    const res = await b.call('pushBookmarksToServer');
    assert.strictEqual(res.status, 'success', res.message);
    assert.strictEqual(state.puts, 1);
    assert.strictEqual(state.remote.id, undefined);
});

const permissions = (folder, file) => FOLDER.replace('</d:prop>', `<oc:permissions>${folder}</oc:permissions></d:prop>`)
    + (file === undefined ? '' : `<d:response><d:href>/dav/bookmarks_sync.json</d:href><d:propstat><d:prop><oc:permissions>${file}</oc:permissions></d:prop></d:propstat></d:response>`)
    + '</d:multistatus>';

test('connection test: a read-only folder or file is reported', async () => {
    const noCreate = "Connected, but you can't create files in this folder (read-only share?): the extension needs to.";
    const fileReadOnly = 'Connected, but the bookmarks file in this folder is read-only for you.';
    assert.strictEqual((await testConnection(propfind(207, permissions('SG')))).message, noCreate);
    // The file is writable but the lock file can't be created next to it
    assert.strictEqual((await testConnection(propfind(207, permissions('SG', 'RGDNVW')))).message, noCreate);
    assert.strictEqual((await testConnection(propfind(207, permissions('RGDNVCK', 'SG')))).message, fileReadOnly);
    assert.strictEqual((await testConnection(propfind(207, permissions('RGDNVCK')))).status, 'success');
    assert.strictEqual((await testConnection(propfind(207, permissions('RGDNVCK', 'RGDNVW')))).status, 'success');
    // No oc:permissions (another WebDAV server): nothing to check
    assert.strictEqual((await testConnection(propfind(207, FOLDER + '</d:multistatus>'))).status, 'success');
});

test('connection test: asks for the permissions in the PROPFIND body', async () => {
    let sent;
    await testConnection((url, opts) => { sent = opts; return { status: 207, body: FOLDER + '</d:multistatus>' }; });
    assert.match(sent.body, /<oc:permissions\/>/);
    assert.strictEqual(sent.headers['Content-Type'], 'application/xml');
});


// ------------------------------------------------------------------
// Messages, folder choice, archive folder, translations
// ------------------------------------------------------------------

test('messages: the sync says what changed on each side', async () => {
    const summary = (counts, sent) => loadBackground(noLock).sandbox.syncSummary({ added: 0, archived: 0, renamed: 0, skipped: 0, ...counts }, sent);
    assert.strictEqual(summary({}, false), 'Up to date.');
    assert.strictEqual(summary({}, true), 'Changes sent.');
    assert.strictEqual(summary({ added: 2, archived: 1 }, true), '2 added, 1 archived · changes sent');
    assert.strictEqual(summary({ renamed: 1, skipped: 3 }, false), '1 renamed, 3 skipped.');
});

test('messages: shown in French in a French browser', async () => {
    const b = loadBackground(lockGet({ status: 401 }), { locale: i18nFr });
    await b.seed();
    const res = await b.call('pushBookmarksToServer');
    assert.strictEqual(res.message, "Identifiant ou mot de passe d'application incorrect.");
    assert.strictEqual(b.sandbox.syncSummary({ added: 2, archived: 0, renamed: 0, skipped: 0 }, true), 'Ajoutés : 2 · modifications envoyées');
});

test('translations: English and French have the same keys and placeholders', () => {
    assert.deepStrictEqual(Object.keys(FR).sort(), Object.keys(EN).sort());
    for (const key of Object.keys(EN)) {
        const holes = (m) => (m.match(/\$\d/g) || []).sort().join();
        assert.strictEqual(holes(FR[key].message), holes(EN[key].message), key);
    }
});

test('folder: a chosen folder is synced instead of the default one', async () => {
    const state = { remote: null };
    const b = loadBackground(davServer(state));
    await b.seed(); // the default folder exists but isn't chosen
    const work = await b.addLocal('1', 'Work');
    await b.addLocal(work.id, 'W', 'https://w.example/');
    b.store.syncFolderId = work.id;
    const res = await b.call('pushBookmarksToServer');
    assert.strictEqual(res.status, 'success', res.message);
    assert.deepStrictEqual(titles(state.remote.children), ['W']);
});

test('folder: a newly chosen folder keeps its bookmarks and gets the server ones', async () => {
    const state = { remote: { title: 'root', children: [bm('A'), bm('B')] } };
    const b = loadBackground(davServer(state));
    const syncId = await b.seed();
    b.store.syncBase = { fileUrl: JSON_URL, children: [bm('A'), bm('B')], folderId: syncId };
    const work = await b.addLocal('1', 'Work');
    await b.addLocal(work.id, 'W', 'https://w.example/');
    b.store.syncFolderId = work.id;
    // With the old folder's base, W would be "added" and A, B... fine, but a base
    // from another folder must never read as deletions: the union is expected
    const res = await b.call('pullBookmarksFromServer');
    await b.flush();
    assert.strictEqual(res.status, 'success', res.message);
    assert.deepStrictEqual(b.titlesIn(work.id).sort(), ['A', 'B', 'W']);
    assert.ok(!b.bookmarks.nodes.get('1').children.some(id => b.bookmarks.nodes.get(id).title === '🗑️ Bookmark Archives'), 'something was archived');
});

test('folder: a base saved for the default folder is not used for a chosen one', async () => {
    const b = loadBackground(noLock);
    const syncId = await b.seed();
    b.store.syncBase = { fileUrl: JSON_URL, children: [bm('A')], folderId: syncId };
    assert.strictEqual(await b.sandbox.loadSyncBase(JSON_URL, 'other-folder'), null);
    assert.ok(await b.sandbox.loadSyncBase(JSON_URL, syncId));
    // A base saved by 1.6.0 (no folderId) belongs to whatever folder is synced
    b.store.syncBase = { fileUrl: JSON_URL, children: [bm('A')] };
    assert.ok(await b.sandbox.loadSyncBase(JSON_URL, syncId));
});

test('folder: a chosen folder that was deleted falls back to the default one', async () => {
    const b = loadBackground(noLock);
    b.store.syncFolderId = 'gone';
    const folder = await b.sandbox.getOrCreateSyncFolder();
    assert.strictEqual(b.bookmarks.nodes.get(folder.id).title, '🔄 Bookmark Sync');
    assert.strictEqual(b.store.syncFolderId, undefined);
});

test('archive: the archive folder inside a synced folder is never synced or archived', async () => {
    const state = { remote: { title: 'root', children: [bm('A')] } };
    const b = loadBackground(davServer(state));
    // The bookmarks bar itself is synced, and holds the archive folder
    const archive = await b.addLocal('1', '🗑️ Bookmark Archives');
    await b.addLocal(archive.id, 'Old', 'https://old.example/');
    await b.addLocal('1', 'A', bm('A').url);
    await b.addLocal('1', 'L', bm('L').url);
    b.store.syncFolderId = '1';
    b.store.syncBase = { fileUrl: JSON_URL, children: [bm('A')], folderId: '1' };
    const res = await b.call('pushBookmarksToServer');
    await b.flush();
    assert.strictEqual(res.status, 'success', res.message);
    assert.deepStrictEqual(titles(state.remote.children), ['A', 'L']);
    assert.ok(b.bookmarks.nodes.get('1').children.includes(archive.id), 'archive folder moved or archived');
});

test('archive: a top-level synced folder still gets an archive (browser default place)', async () => {
    const state = { remote: { title: 'root', children: [] } };
    const b = loadBackground(davServer(state));
    await b.addLocal('1', 'X', 'https://x.example/');
    b.store.syncFolderId = '1';
    b.store.syncBase = { fileUrl: JSON_URL, children: [bm('X', 'https://x.example/')], folderId: '1' };
    const res = await b.call('pullBookmarksFromServer');
    await b.flush();
    assert.strictEqual(res.status, 'success', res.message);
    assert.strictEqual(res.message, '1 archived.');
});

// ------------------------------------------------------------------
// Popup
// ------------------------------------------------------------------

// Loads popup.js against a fake DOM, fills the fields, clicks a button.
// response is what the background script answers.
async function popup(serverUrl, { button = 'syncBtn', fields = {}, response = { status: 'success', message: 'ok' }, stored = {}, tree = null, click = true } = {}) {
    const writes = [];
    const removed = [];
    const els = new Map();
    const el = (id) => {
        if (!els.has(id)) {
            const listeners = {};
            els.set(id, new Proxy({ id, value: '', textContent: '', className: '', style: {}, listeners,
                classList: { toggle() {}, add() {}, remove() {} },
                addEventListener: (t, f) => { listeners[t] = f; } }, {
                get: (o, k) => (k in o ? o[k] : (typeof k === 'string' ? () => undefined : undefined)),
                set: (o, k, v) => { o[k] = v; return true; },
            }));
        }
        return els.get(id);
    };
    let ready;
    const requests = [];
    const sent = [];
    const messages = [];
    const sandbox = {
        document: { getElementById: el, documentElement: {}, createElement: () => ({}), addEventListener: (t, f) => { if (t === 'DOMContentLoaded') ready = f; }, querySelectorAll: () => [], querySelector: () => el('q') },
        window: { addEventListener() {} }, navigator: { userAgent: 'test', brave: undefined },
        console: { log() {}, warn() {}, error() {} }, setTimeout: () => 0, clearTimeout() {}, URL, Math, parseInt, Promise, Date, Boolean, Intl, Number, String,
        chrome: {
            i18n,
            storage: {
                local: {
                    get: (k, cb) => cb({ ...stored }),
                    set: (o, cb) => { writes.push(o); if (cb) cb(); },
                    remove: (k, cb) => { removed.push(k); if (cb) cb(); },
                },
                onChanged: { addListener() {} },
            },
            bookmarks: tree ? { getTree: (cb) => cb(tree) } : undefined,
            permissions: { request: (p, cb) => { requests.push(p.origins[0]); cb(true); } },
            runtime: {
                sendMessage: (m, cb) => { sent.push(m.action); messages.push(m); if (cb) cb(response); },
                getManifest: () => ({ version: '9.8.7' }),
            },
        },
    };
    vm.createContext(sandbox);
    vm.runInContext(popupSrc, sandbox);
    await ready();
    await new Promise(r => setTimeout(r, 20));
    el('serverUrl').value = serverUrl;
    for (const [id, value] of Object.entries(fields)) el(id).value = value;
    if (click) await el(button).listeners.click();
    return {
        requests, sent, messages,
        status: el('status').textContent,
        testResult: el('testResult').textContent,
        setupHidden: el('setupCard').hidden,
        lastSync: el('lastSync').textContent,
        legacyHidden: el('legacyWarning').hidden,
        writes, removed, sandbox,
        version: el('version').textContent,
        el,
    };
}

test('popup: the port is dropped from the permission pattern', async () => {
    const r = await popup('https://cloud.example:8443/remote.php/dav/');
    assert.deepStrictEqual(r.requests, ['https://cloud.example/*']);
    assert.deepStrictEqual(r.sent, ['sync_now']);
});

test('popup: http is refused with a clear message, without a permission request', async () => {
    const r = await popup('http://cloud.example/dav');
    assert.deepStrictEqual(r.requests, []);
    assert.strictEqual(r.status, 'Server URL must use https.');
});

test('popup: an invalid URL is reported', async () => {
    const r = await popup('not a url');
    assert.deepStrictEqual(r.requests, []);
    assert.strictEqual(r.status, 'Invalid server URL.');
});

test('popup: syncing with no URL points to the settings', async () => {
    const r = await popup('');
    assert.deepStrictEqual(r.sent, []);
    assert.strictEqual(r.status, 'Not set up yet: open Settings (⚙️).');
});

test('popup: the setup card shows until the URL, username and password are saved', async () => {
    assert.strictEqual((await popup('')).setupHidden, false);
    const configured = await popup('', { stored: { serverUrl: 'https://c.example/dav/', username: 'u', password: 'p' } });
    assert.strictEqual(configured.setupHidden, true);
});

test('popup: the last sync result is shown, failures with their reason', async () => {
    const failed = await popup('', { stored: { lastSync: { kind: 'sync', ok: false, message: 'Wrong username or app password.', time: Date.now() } } });
    assert.strictEqual(failed.lastSync, 'Last sync failed (just now): Wrong username or app password.');
    const ok = await popup('', { stored: { lastSync: { kind: 'sync', ok: true, message: 'Up to date.', time: Date.now() - 5 * 60000 } } });
    assert.strictEqual(ok.lastSync, '✓ Synced 5 minutes ago');
    const imported = await popup('', { stored: { lastSync: { kind: 'import', ok: true, message: '1 added.', time: Date.now() - 2 * 3600000 } } });
    assert.strictEqual(imported.lastSync, '✓ Imported 2 hours ago');
});

test('popup: test connection sends the typed values, not the saved ones', async () => {
    const r = await popup('https://cloud.example/dav/f/', {
        button: 'testConnectionBtn',
        fields: { username: ' alice ', password: 'secret' },
        response: { status: 'success', message: 'Connected. No bookmarks file yet: Sync now creates it.' },
    });
    assert.deepStrictEqual(r.requests, ['https://cloud.example/*']);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(r.messages[0])),
        { action: 'test_connection', serverUrl: 'https://cloud.example/dav/f/', username: 'alice', password: 'secret' });
    assert.strictEqual(r.testResult, 'Connected. No bookmarks file yet: Sync now creates it.');
});

test('popup: test connection reports a bad URL without contacting the server', async () => {
    const r = await popup('http://cloud.example/dav/', { button: 'testConnectionBtn' });
    assert.deepStrictEqual(r.sent, []);
    assert.strictEqual(r.testResult, 'Server URL must use https.');
});

test('popup: editing a field clears an earlier connection test result', async () => {
    const r = await popup('https://cloud.example/dav/f/', { button: 'testConnectionBtn', fields: { username: 'u', password: 'p' }, response: { status: 'success', message: 'Connected. Bookmarks file found on the server.' } });
    assert.strictEqual(r.testResult, 'Connected. Bookmarks file found on the server.');
    r.el('password').listeners.input();
    assert.strictEqual(r.el('testResult').textContent, '');
});

test('popup: the installed version is shown on the main screen', async () => {
    assert.strictEqual((await popup('')).version, 'v9.8.7');
});

test('popup: the old-version warning shows for a week after such a file was seen', async () => {
    assert.strictEqual((await popup('')).legacyHidden, true);
    assert.strictEqual((await popup('', { stored: { legacySeenAt: Date.now() - 60000 } })).legacyHidden, false);
    assert.strictEqual((await popup('', { stored: { legacySeenAt: Date.now() - 8 * 86400000 } })).legacyHidden, true);
});

// ------------------------------------------------------------------
// Sync folder deleted or renamed
// ------------------------------------------------------------------

test('folder: a deleted or renamed sync folder is restored from the server, not wiped from it', async () => {
    for (const action of ['pullBookmarksFromServer', 'pushBookmarksToServer']) {
        const state = { remote: { title: 'root', children: [bm('A'), bm('B')] } };
        const b = loadBackground(davServer(state));
        // Synced before, then the user deleted (or renamed) the folder: no seed()
        b.store.syncBase = { fileUrl: JSON_URL, children: [bm('A'), bm('B')] };
        const res = await b.call(action);
        await b.flush();
        assert.strictEqual(res.status, 'success', `${action}: ${res.message}`);
        assert.deepStrictEqual(titles(state.remote.children), ['A', 'B'], `${action} wiped the server`);
        const folder = [...b.bookmarks.nodes.values()].find(n => n.title === '🔄 Bookmark Sync');
        assert.deepStrictEqual(b.titlesIn(folder.id), ['A', 'B'], `${action} did not restore the folder`);
        assert.ok(!b.timers.some(t => t.ms === 5000) || action === 'pushBookmarksToServer', 'export scheduled to empty the server');
    }
});

test('connection test: the folder is found by its href, whatever the order of the responses', async () => {
    const body = '<d:multistatus>'
        + '<d:response><d:href>/dav/bookmarks_sync.json</d:href><d:propstat><d:prop><d:resourcetype/></d:prop></d:propstat></d:response>'
        + '<d:response><d:href>/dav/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>'
        + '</d:multistatus>';
    const r = await testConnection(propfind(207, body));
    assert.deepStrictEqual([r.status, r.message], ['success', 'Connected. Bookmarks file found on the server.']);
});

test('auto-push: the sync folder id is cached between bookmark events', async () => {
    const b = loadBackground(noLock);
    const syncId = await b.seed();
    let searches = 0;
    const search = b.bookmarks.search;
    b.bookmarks.search = (q, cb) => { searches++; search(q, cb); };
    for (let i = 0; i < 5; i++) b.bookmarks.events.created('x' + i, { parentId: syncId });
    await b.flush();
    assert.ok(searches <= 2, `${searches} full searches for 5 events`);
});

test('folder: created in the bookmarks bar in Chrome and in Firefox', async () => {
    // Chrome-like tree: the bar is '1'
    let b = loadBackground(noLock);
    let folder = await b.sandbox.getOrCreateSyncFolder();
    assert.strictEqual(b.bookmarks.nodes.get(folder.id).parentId, '1');
    // Firefox-like tree: no '1', the toolbar is 'toolbar_____'
    b = loadBackground(noLock);
    const nodes = b.bookmarks.nodes;
    nodes.delete('1');
    nodes.get('0').children = ['toolbar_____', 'unfiled_____'];
    nodes.set('toolbar_____', { id: 'toolbar_____', parentId: '0', title: 'toolbar', children: [] });
    nodes.set('unfiled_____', { id: 'unfiled_____', parentId: '0', title: 'unfiled', children: [] });
    folder = await b.sandbox.getOrCreateSyncFolder();
    assert.strictEqual(nodes.get(folder.id).parentId, 'toolbar_____');
    assert.strictEqual(folder.created, true);
});

test('popup: Import only (advanced settings) sends an import and shows its result there', async () => {
    const r = await popup('https://cloud.example/dav/', { button: 'importBtn', response: { status: 'success', message: '1 added.' } });
    assert.deepStrictEqual(r.sent, ['pull_bookmarks']);
    assert.strictEqual(r.el('importResult').textContent, '1 added.');
    assert.strictEqual(r.status, '');
});

test('popup: a failed sync stays on screen with a link to the settings', async () => {
    const r = await popup('https://cloud.example/dav/', { response: { status: 'error', message: 'Wrong username or app password.' } });
    assert.strictEqual(r.status, 'Wrong username or app password.');
    assert.strictEqual(r.el('checkSettings').hidden, false);
    const ok = await popup('https://cloud.example/dav/', { response: { status: 'success', message: 'Up to date.' } });
    assert.strictEqual(ok.el('checkSettings').hidden, true);
});

test('popup: the password can be shown and hidden', async () => {
    const r = await popup('', { click: false });
    r.el('password').type = 'password';
    r.el('togglePassword').listeners.click();
    assert.strictEqual(r.el('password').type, 'text');
    assert.strictEqual(r.el('togglePassword').textContent, 'Hide');
    r.el('togglePassword').listeners.click();
    assert.strictEqual(r.el('password').type, 'password');
});

test('popup: the automatic sync state reads On or Paused', async () => {
    const on = await popup('', { click: false });
    assert.strictEqual(on.el('autoSyncState').textContent, 'On');
    const paused = await popup('', { click: false, stored: { autoSyncEnabled: false } });
    assert.strictEqual(paused.el('autoSyncState').textContent, 'Paused');
});

test('popup: changing the synced folder asks first, then saves it', async () => {
    const tree = [{ id: '0', children: [{ id: '1', parentId: '0', title: 'Bookmarks bar', children: [
        { id: '7', parentId: '1', title: 'Work', children: [] },
        { id: '8', parentId: '1', title: '🔄 Bookmark Sync', children: [] },
    ] }] }];
    const r = await popup('', { click: false, tree });
    const select = r.el('syncFolder');
    select.value = '7';
    select.listeners.change();
    assert.strictEqual(r.el('folderConfirm').hidden, false, 'no confirmation asked');
    assert.deepStrictEqual(r.writes.filter(w => 'syncFolderId' in w), []);
    r.el('confirmFolder').listeners.click();
    assert.deepStrictEqual(JSON.parse(JSON.stringify(r.writes.filter(w => 'syncFolderId' in w))), [{ syncFolderId: '7' }]);
    // Back to the default folder: the setting is removed
    select.value = '';
    select.listeners.change();
    r.el('confirmFolder').listeners.click();
    assert.deepStrictEqual(r.removed, ['syncFolderId']);
});

test('popup: cancelling a folder change keeps the current folder', async () => {
    const tree = [{ id: '0', children: [{ id: '1', parentId: '0', title: 'Bookmarks bar', children: [] }] }];
    const r = await popup('', { click: false, tree });
    const select = r.el('syncFolder');
    select.value = '1';
    select.listeners.change();
    r.el('cancelFolder').listeners.click();
    assert.strictEqual(select.value, '');
    assert.strictEqual(r.el('folderConfirm').hidden, true);
    assert.deepStrictEqual(r.writes.filter(w => 'syncFolderId' in w), []);
});
