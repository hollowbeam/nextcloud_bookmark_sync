'use strict';
// Shared by the end-to-end tests and tools: a test copy of the extension, a browser
// profile with it loaded, and direct WebDAV access to the test server.
const { chromium } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const HOST = 'https://localhost:8443';
const DAV_ROOT = `${HOST}/remote.php/dav/files/admin/`;
const USER = 'admin';
const PASSWORD = 'e2e-test-pass';
const AUTH = 'Basic ' + Buffer.from(`${USER}:${PASSWORD}`).toString('base64');

// The self-signed certificate of the test proxy (Node's own fetch)
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// The files of the store package (tools/package.js ships the same list)
const EXTENSION_FILES = ['manifest.json', 'background.js', 'popup.html', 'popup.js', 'icon48.png', 'icon128.png', 'LICENSE'];

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nbs-e2e-'));

// A copy of the extension. grantHost: the host permission is granted up front, as a
// test can't click the browser's permission prompt.
function buildExtension(name, { grantHost = true } = {}) {
    const dir = path.join(workDir, `ext-${name}`);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    fs.cpSync(path.join(REPO, '_locales'), path.join(dir, '_locales'), { recursive: true });
    for (const f of EXTENSION_FILES) fs.copyFileSync(path.join(REPO, f), path.join(dir, f));
    if (grantHost) {
        const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
        manifest.host_permissions = ['https://localhost/*'];
        fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    }
    return dir;
}

// A browser profile with the extension loaded. E2E_BROWSER=msedge uses the installed
// Edge (Windows); by default, Playwright's Chromium (CI).
async function launchDevice(name, { extensionDir = buildExtension(name), locale = 'en-US', deviceScaleFactor } = {}) {
    const profile = path.join(workDir, `profile-${name}`);
    fs.rmSync(profile, { recursive: true, force: true });
    const channel = process.env.E2E_BROWSER || 'chromium';
    const context = await chromium.launchPersistentContext(profile, {
        channel, headless: false, locale, deviceScaleFactor,
        args: [
            `--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`,
            '--ignore-certificate-errors', '--headless=new', `--lang=${locale}`,
        ],
    });
    const sw = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 30000 });
    const ev = (fn, arg) => sw.evaluate(fn, arg);

    return {
        context, sw, ev,
        extensionId: sw.url().split('/')[2],
        set: (o) => ev((o) => new Promise(r => chrome.storage.local.set(o, r)), o),
        get: (k) => ev((k) => new Promise(r => chrome.storage.local.get(k, res => r(res[k]))), k),
        sync: () => ev(() => new Promise(r => pushBookmarksToServer(r))),
        importOnly: () => ev(() => new Promise(r => pullBookmarksFromServer(r))),
        badge: () => ev(() => chrome.action.getBadgeText({})),
        testConnection: (s) => ev((s) => testConnection(s), s),
        folderTitles: () => ev(async () => {
            const { id } = await getOrCreateSyncFolder();
            return new Promise(r => chrome.bookmarks.getChildren(id, k => r(k.map(n => n.title))));
        }),
        archived: () => ev(() => new Promise(r => chrome.bookmarks.search({ title: '🗑️ Bookmark Archives' }, async (res) => {
            const top = res.find(x => !x.url);
            if (!top) return r([]);
            const sub = await new Promise(rr => chrome.bookmarks.getSubTree(top.id, rr));
            const out = [];
            const walk = (n) => { if (n.url) out.push(n.title); (n.children || []).forEach(walk); };
            walk(sub[0]);
            r(out);
        }))),
        // A bookmark in the sync folder, or in parentId when given
        add: (title, parentId) => ev(async ([title, parentId]) => {
            const parent = parentId || (await getOrCreateSyncFolder()).id;
            return new Promise(r => chrome.bookmarks.create({ parentId: parent, title, url: `https://${title.toLowerCase()}.example/` }, n => r(n.id)));
        }, [title, parentId]),
        remove: (title) => ev(async (title) => {
            const { id } = await getOrCreateSyncFolder();
            const kids = await new Promise(r => chrome.bookmarks.getChildren(id, r));
            const node = kids.find(k => k.title === title);
            await new Promise(r => chrome.bookmarks.remove(node.id, r));
        }, title),
        close: () => context.close(),
    };
}

// Direct WebDAV access, to set up or inspect the server side
function dav(folder) {
    const base = DAV_ROOT + folder + '/';
    const request = async (method, file, body, headers = {}) => {
        const res = await fetch(base + file, { method, body, headers: { Authorization: AUTH, ...headers } });
        return { status: res.status, text: method === 'GET' ? await res.text() : '' };
    };
    return {
        url: base,
        request,
        reset: async () => {
            await request('DELETE', 'bookmarks_sync.json');
            await request('DELETE', 'bookmarks_sync.lock');
        },
        titles: async () => JSON.parse((await request('GET', 'bookmarks_sync.json')).text).children.map(c => c.title),
        file: async () => JSON.parse((await request('GET', 'bookmarks_sync.json')).text),
    };
}

const settings = (folder) => ({ serverUrl: DAV_ROOT + folder + '/', username: USER, password: PASSWORD });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// A tiny runner: named steps, a summary, a failing exit code
function runner() {
    const results = [];
    return {
        async step(name, fn) {
            try {
                await fn();
                results.push(`PASS  ${name}`);
            } catch (e) {
                results.push(`FAIL  ${name}\n      ${String(e.message).split('\n').join('\n      ')}`);
                process.exitCode = 1;
            }
        },
        report() {
            console.log(results.join('\n'));
            const failed = results.filter(r => r.startsWith('FAIL')).length;
            console.log(`\n${results.length - failed}/${results.length} passed`);
        },
    };
}

module.exports = { REPO, HOST, DAV_ROOT, EXTENSION_FILES, workDir, buildExtension, launchDevice, dav, settings, sleep, runner };
