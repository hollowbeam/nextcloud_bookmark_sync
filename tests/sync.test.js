'use strict';
// Runs background.js and popup.js in a Node vm with mocked browser and WebDAV APIs.
// Run with: node --test tests/
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
        removeTree: () => {},
    };
}

function loadBackground(server) {
    const runtime = { lastError: undefined, onMessage: { addListener() {} }, onInstalled: { addListener() {} } };
    const bookmarks = makeBookmarks(runtime);
    const timers = [];
    const log = [];
    const store = { ...STORAGE };
    const control = { gate: null };
    const fetchStub = async (url, opts = {}) => {
        if (control.gate) await control.gate;
        log.push(`${opts.method} ${url.split('/').pop()}`);
        const res = server(url, opts);
        return { status: res.status, ok: res.status >= 200 && res.status < 300, json: async () => res.body };
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
    const flush = () => new Promise(r => setTimeout(r, 30));
    const call = (name) => new Promise((resolve) => sandbox[name](resolve));
    return { sandbox, log, timers, bookmarks, seed, flush, call, control, store };
}

const noLock = (url, opts) => {
    if (url === LOCK_URL && opts.method === 'GET') return { status: 404 };
    return { status: 201 };
};

const lockedBy = (owner) => (url, opts) => url === LOCK_URL && opts.method === 'GET'
    ? { status: 200, body: { owner, timestamp: Date.now() } } : { status: 201 };

function davServer(state) {
    return (url, opts) => {
        if (url === LOCK_URL && opts.method === 'GET') return { status: 404 };
        if (url === JSON_URL && opts.method === 'GET') return { status: 200, body: state.remote };
        if (url === JSON_URL && opts.method === 'PUT') { state.pushed = JSON.parse(opts.body); return { status: 201 }; }
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
    assert.deepStrictEqual(b.log, ['GET bookmarks_sync.lock', 'PUT bookmarks_sync.lock', 'PUT bookmarks_sync.json', 'DELETE bookmarks_sync.lock']);
});

test('push: backs off without writing when another device holds the lock', async () => {
    const b = loadBackground(lockedBy('firefox22222222'));
    await b.seed();
    const res = await b.call('pushBookmarksToServer');
    await b.flush();
    assert.strictEqual(res.status, 'locked');
    assert.deepStrictEqual(b.log, ['GET bookmarks_sync.lock']);
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
        return { status: 201 };
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
        return { status: 201 };
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
    assert.strictEqual(res.message, '1 items imported!');
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
