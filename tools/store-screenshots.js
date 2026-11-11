'use strict';
// Store screenshots (1280x800) of the real popup, rendered by the extension in a browser.
//   node tools/store-screenshots.js en      -> dist/screenshots/en-*.png
//   node tools/store-screenshots.js fr
// No server needed: the popup states are set in storage. E2E_BROWSER=msedge on Windows.
const fs = require('fs');
const path = require('path');
const { REPO, buildExtension, launchDevice } = require('../tests/e2e/helpers');

const LANG = process.argv[2] || 'en';
const OUT = path.join(REPO, 'dist', 'screenshots');

const MSG = JSON.parse(fs.readFileSync(path.join(REPO, '_locales', LANG, 'messages.json'), 'utf8'));
const m = (key, ...subs) => MSG[key].message.replace(/\$(\d)/g, (x, n) => subs[n - 1]);

const settings = {
    serverUrl: 'https://cloud.example.com/remote.php/dav/files/alice/Bookmarks/',
    username: 'alice', password: 'app-password-example', extensionId: 'e1', autoSyncEnabled: true,
};

// Each scene: what storage holds, which view, what the status shows, and a caption
const scenes = [
    {
        file: '1-sync-now', scheme: 'light', view: 'main', store: settings,
        lastSync: { kind: 'sync', ok: true, message: '', time: Date.now() - 3 * 60000 },
        status: { text: `${m('countAdded', 2)}, ${m('countArchived', 1)} · ${m('changesSent')}`.replace(/^./, c => c.toUpperCase()), kind: 'ok' },
        title: LANG === 'fr' ? 'Un seul bouton, qui dit ce qui a changé' : 'One button that tells you what changed',
        text: LANG === 'fr' ? 'Les modifications de chaque appareil sont fusionnées, rien n\'est écrasé.' : 'Changes from every device are merged, nothing is overwritten.',
    },
    {
        file: '2-setup', scheme: 'light', view: 'main', store: { extensionId: 'e1', autoSyncEnabled: true },
        title: LANG === 'fr' ? 'Guidé dès la première ouverture' : 'Guided from the first click',
        text: LANG === 'fr' ? 'Trois étapes pour relier l\'extension à votre Nextcloud.' : 'Three steps to connect the extension to your Nextcloud.',
    },
    {
        file: '3-test-connection', scheme: 'light', view: 'settings', store: settings,
        testResult: { text: m('testConnectedFile'), kind: 'ok' },
        title: LANG === 'fr' ? 'Tester la connexion avant de synchroniser' : 'Test the connection before syncing',
        text: LANG === 'fr' ? 'Mot de passe, dossier, adresse WebDAV : vous savez exactement quoi corriger.' : 'Password, folder, WebDAV address: you know exactly what to fix.',
    },
    {
        file: '4-clear-errors', scheme: 'light', view: 'main', store: settings,
        lastSync: { kind: 'sync', ok: false, message: m('errWrongPassword'), time: Date.now() - 2 * 60000 },
        status: { text: m('errWrongPassword'), kind: 'error' }, checkSettings: true,
        title: LANG === 'fr' ? 'Des erreurs claires' : 'Errors you can act on',
        text: LANG === 'fr' ? 'Un échec de synchro automatique s\'affiche aussi sur l\'icône.' : 'A failed automatic sync is also flagged on the toolbar icon.',
    },
    {
        file: '5-dark', scheme: 'dark', view: 'main', store: settings,
        lastSync: { kind: 'sync', ok: true, message: '', time: Date.now() - 60 * 60000 },
        status: { text: m('upToDate'), kind: 'ok' },
        title: LANG === 'fr' ? 'Thème sombre, en anglais ou en français' : 'Dark theme, in English or French',
        text: LANG === 'fr' ? 'Suit le thème et la langue de votre navigateur.' : 'Follows your browser\'s theme and language.',
    },
];

(async () => {
    fs.mkdirSync(OUT, { recursive: true });
    const locale = LANG === 'fr' ? 'fr' : 'en-US';
    // 2x for a sharp popup; the final images are rendered at 1280x800 (scale: 'css')
    const device = await launchDevice(`store-${LANG}`, { extensionDir: buildExtension(`store-${LANG}`, { grantHost: false }), locale, deviceScaleFactor: 2 });
    const { context, sw, extensionId: extId } = device;
    const icon = fs.readFileSync(path.join(REPO, 'icon128.png')).toString('base64');

    for (const scene of scenes) {
        await sw.evaluate(() => new Promise(r => chrome.storage.local.clear(r)));
        await sw.evaluate((o) => new Promise(r => chrome.storage.local.set(o, r)), scene.store);
        await new Promise(r => setTimeout(r, 300)); // settings changes clear lastSync
        if (scene.lastSync) await sw.evaluate((o) => new Promise(r => chrome.storage.local.set({ lastSync: o }, r)), scene.lastSync);

        // The popup itself, at 2x for a sharp result
        const popup = await context.newPage();
        await popup.setViewportSize({ width: 350, height: 640 });
        await popup.emulateMedia({ colorScheme: scene.scheme });
        await popup.goto(`chrome-extension://${extId}/popup.html`);
        await popup.waitForTimeout(400);
        await popup.evaluate((scene) => {
            if (scene.status) {
                const s = document.getElementById('status');
                s.textContent = scene.status.text;
                s.className = scene.status.kind;
            }
            document.getElementById('checkSettings').hidden = !scene.checkSettings;
            if (scene.view === 'settings') document.getElementById('goToSettingsBtn').click();
            if (scene.testResult) {
                const t = document.getElementById('testResult');
                t.textContent = scene.testResult.text;
                t.className = `result ${scene.testResult.kind}`;
            }
            document.activeElement && document.activeElement.blur();
            // A screenshot, not a window: no scrollbars
            const style = document.createElement('style');
            style.textContent = 'html, body { overflow: hidden !important; } ::-webkit-scrollbar { display: none; }';
            document.head.appendChild(style);
        }, scene);
        await popup.waitForTimeout(200);
        const height = await popup.evaluate(() => document.body.scrollHeight);
        await popup.setViewportSize({ width: 350, height: Math.min(height, 640) });
        const shot = (await popup.screenshot({ clip: { x: 0, y: 0, width: 350, height: Math.min(height, 640) }, scale: 'device' })).toString('base64');
        await popup.close();

        // Composed on a 1280x800 canvas with a caption
        const dark = scene.scheme === 'dark';
        const canvas = await context.newPage();
        await canvas.setViewportSize({ width: 1280, height: 800 });
        await canvas.setContent(`<!DOCTYPE html><html><head><meta charset="utf-8"><style>
            body { margin: 0; width: 1280px; height: 800px; display: flex; align-items: center; gap: 70px; padding: 0 90px; box-sizing: border-box;
                   font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
                   background: ${dark ? 'linear-gradient(135deg, #14171a, #23303a)' : 'linear-gradient(135deg, #e8f3fb, #ffffff)'}; }
            .text { flex: 1; color: ${dark ? '#e6e6e6' : '#1d2a33'}; }
            .text img { width: 72px; height: 72px; }
            h1 { font-size: 46px; line-height: 1.15; margin: 22px 0 18px; color: ${dark ? '#7cc6ef' : '#0071ae'}; }
            p { font-size: 24px; line-height: 1.45; margin: 0; color: ${dark ? '#c4c7ca' : '#45535c'}; }
            .shot { flex: none; border-radius: 14px; overflow: hidden; box-shadow: 0 18px 50px rgba(0,0,0,${dark ? '0.6' : '0.18'}); }
            .shot img { display: block; width: 380px; }
        </style></head><body>
            <div class="text"><img src="data:image/png;base64,${icon}"><h1>${scene.title}</h1><p>${scene.text}</p></div>
            <div class="shot"><img src="data:image/png;base64,${shot}"></div>
        </body></html>`);
        await canvas.waitForTimeout(200);
        await canvas.screenshot({ path: path.join(OUT, `${LANG}-${scene.file}.png`), scale: 'css' });
        await canvas.close();
    }
    await device.close();
    console.log(fs.readdirSync(OUT).filter(f => f.startsWith(LANG)).join('\n'));
})().catch(e => { console.error('CRASH', e.message); process.exit(1); });
