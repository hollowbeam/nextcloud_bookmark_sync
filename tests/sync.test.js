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
    return {
        moves,
        nodes,
        search: ({ title }, cb) => setImmediate(() => cb([...nodes.values()].filter(n => n.title === title).map(view))),
        get: (id, cb) => setImmediate(() => cb([view(nodes.get(id))])),
        getChildren: (id, cb) => setImmediate(() => cb(nodes.get(id).children.map(c => view(nodes.get(c))))),
        getSubTree: (id, cb) => setImmediate(() => {
            const build = (n) => ({ ...view(n), children: n.children ? n.children.map(c => build(nodes.get(c))) : undefined });
            cb([build(nodes.get(id))]);
        }),
        // Simulates the browser refusing an entry: an invalid URL, or a folder named BADFOLDER
        create: (d, cb) => setImmediate(() => {
            if ((d.url && d.url.startsWith('chrome://')) || d.title === 'BADFOLDER') return fail(cb, 'refused');
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
    };
}

function loadBackground(server) {
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
        return {
            status: res.status, ok: res.status >= 200 && res.status < 300, json: async () => res.body,
            headers: { get: (h) => (h === 'ETag' ? res.etag || null : null) },
        };
    };
    const sandbox = {
        chrome: {
            runtime, bookmarks,
            storage: { local: {
                get: (k, cb) => setImmediate(() => cb({ ...store })),
                set: (o, cb) => { Object.assign(store, o); setImmediate(() => cb && cb()); },
            } },
            alarms: { create() {}, clear() {}, onAlarm: { addListener() {} } },
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
    return { sandbox, log, timers, bookmarks, seed, addLocal, titlesIn, flush, call, control, store, installed };
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
    await b.seed();
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
    b.timers[1].fn();
    await b.flush();
    assert.ok(b.log.includes('PUT bookmarks_sync.json'));
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
    assert.strictEqual(res.message, '2 items imported! (2 skipped)');
    const titles = b.bookmarks.nodes.get(id).children.map(c => b.bookmarks.nodes.get(c).title);
    assert.deepStrictEqual(titles, ['A', 'B']);
    assert.deepStrictEqual(b.bookmarks.moves.map(m => m.index), [0, 1]);
});

test('pull: plain message when nothing is skipped, lock released after the delay', async () => {
    const b = loadBackground((url, opts) => {
        if (url === LOCK_URL && opts.method === 'GET') return { status: 404 };
        if (url === JSON_URL) return { status: 200, body: { children: [{ title: 'A', url: 'https://a.example/' }] } };
        return { status: 201 };
    });
    await b.seed();
    const res = await b.call('pullBookmarksFromServer');
    await b.flush();
    assert.strictEqual(res.message, '1 item imported!');
    const removal = b.timers.find(t => t.ms === 2000);
    assert.ok(removal, 'lock removal not scheduled');
    await removal.fn();
    assert.strictEqual(b.log[b.log.length - 1], 'DELETE bookmarks_sync.lock');
});

test('pull: backs off when another device holds the lock', async () => {
    const b = loadBackground(lockedBy('firefox2'));
    await b.seed();
    const res = await b.call('pullBookmarksFromServer');
    assert.strictEqual(res.status, 'locked');
    assert.deepStrictEqual(b.log, ['GET bookmarks_sync.lock']);
});

test("pull: the delayed lock removal does not delete the next push's lock", async () => {
    const state = { remote: { children: [] } };
    const b = loadBackground(davServer(state));
    await b.seed();
    await b.call('pullBookmarksFromServer');
    await b.flush();
    const removal = b.timers.find(t => t.ms === 2000);
    assert.ok(removal);
    await b.call('pushBookmarksToServer');
    await b.flush();
    await removal.fn();
    await b.flush();
    assert.strictEqual(b.log.filter(l => l === 'DELETE bookmarks_sync.lock').length, 1);
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
    assert.match(res.message, /merged/);
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
    assert.strictEqual(res.message, 'Export successful!');
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

test('push: without a base the server wins, local-only items are archived', async () => {
    const state = { remote: { title: 'root', children: [bm('A'), bm('R')] } };
    const { b, id } = await deviceWith(state, null, [bm('A'), bm('X')]);
    const res = await b.call('pushBookmarksToServer');
    await b.flush();
    assert.strictEqual(res.status, 'success', res.message);
    assert.deepStrictEqual(b.titlesIn(id), ['A', 'R']);
    assert.deepStrictEqual(titles(state.remote.children), ['A', 'R']);
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
    b.store.syncBase = { fileUrl: JSON_URL, children: [bm('A')] };
    assert.strictEqual((await b.call('pushBookmarksToServer')).status, 'error');
    assert.deepStrictEqual(b.titlesIn(id), ['A', 'R']);
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
    await b.call('pullBookmarksFromServer');
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
    assert.strictEqual(res.message, 'Invalid remote file. Export to replace it.');
    assert.deepStrictEqual(b.titlesIn(id), ['A']);
});

test('pull: without a base the server wins (no resurrection of remote deletions)', async () => {
    const state = { remote: { title: 'root', children: [bm('A'), bm('R')] } };
    const { b, id } = await deviceWith(state, null, [bm('A'), bm('X')]);
    await b.call('pullBookmarksFromServer');
    await b.flush();
    assert.deepStrictEqual(b.titlesIn(id), ['A', 'R']);
    assert.ok(!b.timers.some(t => t.ms === 5000), 'X would be pushed back');
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
    b.store.syncBase = { fileUrl: JSON_URL, children: [bm('A')] };
    assert.strictEqual((await b.call('pushBookmarksToServer')).status, 'locked');
    await b.flush();
    assert.deepStrictEqual(b.titlesIn(id), ['A', 'R'], 'merge applied locally');
    assert.strictEqual((await b.call('pushBookmarksToServer')).status, 'success');
    await b.flush();
    assert.deepStrictEqual(titles(state.remote.children), ['A'], 'R resurrected');
    assert.deepStrictEqual(b.titlesIn(id), ['A']);
});

// ------------------------------------------------------------------
// Popup
// ------------------------------------------------------------------

async function popup(serverUrl) {
    const els = new Map();
    const el = (id) => {
        if (!els.has(id)) {
            const listeners = {};
            els.set(id, new Proxy({ id, value: '', textContent: '', style: {}, listeners,
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
    const sandbox = {
        document: { getElementById: el, addEventListener: (t, f) => { if (t === 'DOMContentLoaded') ready = f; }, querySelectorAll: () => [], querySelector: () => el('q') },
        window: { addEventListener() {} }, navigator: { userAgent: 'test', brave: undefined },
        console: { log() {}, warn() {}, error() {} }, setTimeout: () => 0, clearTimeout() {}, URL, Math, parseInt, Promise,
        chrome: {
            storage: { local: { get: (k, cb) => cb({}), set: (o, cb) => cb && cb() } },
            permissions: { request: (p, cb) => { requests.push(p.origins[0]); cb(true); } },
            runtime: { sendMessage: (m, cb) => { sent.push(m.action); if (cb) cb({ status: 'success', message: 'ok' }); } },
        },
    };
    vm.createContext(sandbox);
    vm.runInContext(popupSrc, sandbox);
    await ready();
    await new Promise(r => setTimeout(r, 20));
    el('serverUrl').value = serverUrl;
    await el('pushBtn').listeners.click();
    return { requests, sent, status: el('status').textContent };
}

test('popup: the port is dropped from the permission pattern', async () => {
    const r = await popup('https://cloud.example:8443/remote.php/dav/');
    assert.deepStrictEqual(r.requests, ['https://cloud.example/*']);
    assert.deepStrictEqual(r.sent, ['push_bookmarks']);
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
