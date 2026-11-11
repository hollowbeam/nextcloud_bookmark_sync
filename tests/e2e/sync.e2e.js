'use strict';
// End-to-end tests: the real extension in a Chromium browser, against a real Nextcloud
// behind an HTTPS gzip proxy (tests/e2e/server.sh start).
//   node tests/e2e/sync.e2e.js                    (Playwright's Chromium, as in CI)
//   E2E_BROWSER=msedge node tests/e2e/sync.e2e.js (the installed Edge, on Windows)
const assert = require('assert');
const { HOST, launchDevice, dav, settings, sleep, runner } = require('./helpers');

const { step, report } = runner();

async function oneDevice() {
    const server = dav('bookmarks-test');
    await server.reset();
    const good = settings('bookmarks-test');
    const device = await launchDevice('single');
    const settle = () => sleep(1500); // lets a sync release its lock, or storage events land

    try {
        await device.set({ ...good, extensionId: 'e2e000001', autoSyncEnabled: false });

        await step('Test connection: correct settings, no file yet', async () => {
            const r = await device.testConnection(good);
            assert.deepStrictEqual([r.status, r.message], ['success', 'Connected. No bookmarks file yet: Sync now creates it.']);
        });
        await step('Test connection: wrong password', async () => {
            assert.strictEqual((await device.testConnection({ ...good, password: 'nope' })).message, 'Wrong username or app password.');
        });
        await step('Test connection: folder that does not exist', async () => {
            const r = await device.testConnection({ ...good, serverUrl: good.serverUrl.replace('bookmarks-test', 'no-such-folder') });
            assert.strictEqual(r.message, 'Folder not found. Create it in Nextcloud Files first.');
        });
        await step('Test connection: Nextcloud web address instead of WebDAV', async () => {
            const r = await device.testConnection({ ...good, serverUrl: `${HOST}/apps/files/` });
            assert.match(r.message, /^Not a WebDAV folder URL\./, r.message);
        });
        await step('Test connection: URL of a file', async () => {
            await server.request('PUT', 'some-file.txt', 'x');
            const r = await device.testConnection({ ...good, serverUrl: server.url + 'some-file.txt' });
            assert.strictEqual(r.message, 'This URL points to a file. Use the URL of a folder.');
        });
        await step('Test connection: server unreachable', async () => {
            const r = await device.testConnection({ ...good, serverUrl: 'https://localhost:9/dav/' });
            assert.strictEqual(r.message, 'Server unreachable. Check the URL and your connection.');
        });

        await step('Sync with a wrong password: precise message, recorded, red badge', async () => {
            await device.set({ password: 'nope' });
            await settle();
            const r = await device.sync();
            assert.deepStrictEqual([r.status, r.message], ['error', 'Wrong username or app password.']);
            const last = await device.get('lastSync');
            assert.deepStrictEqual([last.kind, last.ok], ['sync', false]);
            assert.strictEqual(await device.badge(), '!');
        });
        await step('Fixing the password clears the failure and the badge', async () => {
            await device.set({ password: good.password });
            await settle();
            assert.strictEqual(await device.get('lastSync'), undefined);
            assert.strictEqual(await device.badge(), '');
        });

        await step('Sync creates the file; a second one uploads nothing', async () => {
            await device.add('A');
            await device.add('B');
            let r = await device.sync();
            assert.strictEqual(r.status, 'success', r.message);
            assert.deepStrictEqual(await server.titles(), ['A', 'B']);
            await settle();
            r = await device.sync();
            assert.strictEqual(r.message, 'Up to date.');
            assert.ok((await device.get('lastSync')).ok);
        });
        await step('Test connection now finds the bookmarks file', async () => {
            assert.strictEqual((await device.testConnection(good)).message, 'Connected. Bookmarks file found on the server.');
        });

        await step('Deleted sync folder: restored from the server, server not wiped', async () => {
            await device.ev(async () => {
                const { id } = await getOrCreateSyncFolder();
                await new Promise(r => chrome.bookmarks.removeTree(id, r));
            });
            await settle();
            const r = await device.importOnly();
            assert.strictEqual(r.status, 'success', r.message);
            await settle();
            assert.deepStrictEqual(await device.folderTitles(), ['A', 'B']);
            assert.deepStrictEqual(await server.titles(), ['A', 'B']);
        });

        await step('Automatic sync: a change outside the sync folder sends nothing', async () => {
            await device.set({ autoSyncEnabled: true });
            const before = (await device.get('lastSync')) || {};
            await device.add('Outside', '1');
            await sleep(7000);
            const after = (await device.get('lastSync')) || {};
            assert.strictEqual(after.time, before.time, 'a sync ran');
        });
        await step('Automatic sync: a change inside the folder is sent within 5 seconds', async () => {
            await device.add('C');
            await sleep(8000);
            assert.deepStrictEqual(await server.titles(), ['A', 'B', 'C']);
            await device.set({ autoSyncEnabled: false });
        });

        await step('Old-version file replacing a new one: warning recorded, file rewritten', async () => {
            const raw = { id: '9', title: 'root', dateAdded: 1, children: [{ id: '10', title: 'A', url: 'https://a.example/', dateAdded: 1 }] };
            await server.request('PUT', 'bookmarks_sync.json', JSON.stringify(raw));
            await device.set({ autoSyncEnabled: true }); // the rewrite is an automatic sync
            const r = await device.importOnly();
            assert.strictEqual(r.status, 'success', r.message);
            await settle();
            assert.ok(Date.now() - (await device.get('legacySeenAt')) < 60000, 'warning not recorded');
            await sleep(8000);
            const file = await server.file();
            assert.strictEqual(file.id, undefined, 'file still in the old format');
            assert.ok(file.children.every(c => c.id === undefined && c.dateAdded === undefined));
        });

        await step('Duplicate sync folder: the oldest keeps syncing, the extra one is reported', async () => {
            await device.set({ autoSyncEnabled: false });
            await settle();
            const before = await server.titles();
            const extra = await device.ev(() => new Promise(r => chrome.bookmarks.create({ parentId: '1', title: '🔄 Bookmark Sync' }, n => r(n.id))));
            await device.ev((id) => new Promise(r => chrome.bookmarks.create({ parentId: id, title: 'In the duplicate', url: 'https://dup.example/' }, r)), extra);
            const r = await device.sync();
            assert.strictEqual(r.status, 'success', r.message);
            assert.deepStrictEqual(await server.titles(), before, 'the duplicate was synced');
            assert.strictEqual(await device.get('duplicateSyncFolders'), 1);
            await device.ev((id) => new Promise(r => chrome.bookmarks.removeTree(id, r)), extra);
            await settle();
            await device.sync();
            assert.strictEqual(await device.get('duplicateSyncFolders'), 0);
        });
    } finally {
        await device.close();
    }
}

async function twoDevices() {
    const server = dav('bookmarks-a');
    await server.reset();
    const config = { ...settings('bookmarks-a'), autoSyncEnabled: false };
    const a = await launchDevice('device-a');
    const b = await launchDevice('device-b');
    const settle = () => sleep(1500);

    try {
        await a.set({ ...config, extensionId: 'e2e00000a' });
        await b.set({ ...config, extensionId: 'e2e00000b' });

        await step('Two devices: the first sync of each keeps both sides', async () => {
            await a.add('A1');
            assert.strictEqual((await a.sync()).status, 'success');
            await settle();
            await b.add('B1');
            const r = await b.sync();
            assert.strictEqual(r.status, 'success', r.message);
            assert.deepStrictEqual((await b.folderTitles()).sort(), ['A1', 'B1']);
            assert.deepStrictEqual((await server.titles()).sort(), ['A1', 'B1']);
        });

        await step('Two devices: concurrent additions are merged, nothing overwritten', async () => {
            await settle();
            await a.add('A2');
            await b.add('B2');
            let r = await a.sync(); // A doesn't have B1 yet: it merges it
            assert.strictEqual(r.status, 'success', r.message);
            await settle();
            r = await b.sync(); // B didn't get A2 yet: merges it too
            assert.strictEqual(r.status, 'success', r.message);
            assert.match(r.message, /1 added · changes sent$/, r.message);
            await settle();
            assert.strictEqual((await a.sync()).status, 'success');
            const expected = ['A1', 'A2', 'B1', 'B2'];
            assert.deepStrictEqual((await server.titles()).sort(), expected);
            assert.deepStrictEqual((await a.folderTitles()).sort(), expected);
            assert.deepStrictEqual((await b.folderTitles()).sort(), expected);
        });

        await step('Two devices: a deletion on one is archived on the other', async () => {
            await settle();
            await b.remove('A2');
            assert.strictEqual((await b.sync()).status, 'success');
            await settle();
            const r = await a.importOnly();
            assert.strictEqual(r.status, 'success', r.message);
            assert.strictEqual(r.message, '1 archived.');
            assert.ok(!(await a.folderTitles()).includes('A2'));
            assert.ok((await a.archived()).includes('A2'), 'A2 not in the archive');
        });
    } finally {
        await a.close();
        await b.close();
    }
}

(async () => {
    await oneDevice();
    await twoDevices();
    report();
})().catch((e) => {
    report();
    console.error('CRASH', e);
    process.exit(1);
});
