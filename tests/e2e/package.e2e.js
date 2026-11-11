'use strict';
// Loads the extension exactly as packaged for the stores (node tools/package.js first),
// in English and in French. No server needed.
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { REPO, workDir, launchDevice, runner } = require('./helpers');

const { step, report } = runner();

(async () => {
    const version = JSON.parse(fs.readFileSync(path.join(REPO, 'manifest.json'), 'utf8')).version;
    const zip = path.join(REPO, 'dist', `nextcloud_bookmark_sync-${version}.zip`);
    assert.ok(fs.existsSync(zip), `${zip} missing: run node tools/package.js first`);

    const dir = path.join(workDir, 'unzipped');
    fs.mkdirSync(dir, { recursive: true });
    if (process.platform === 'win32') {
        execFileSync('C:/Windows/System32/tar.exe', ['-xf', zip, '-C', dir]);
    } else {
        execFileSync('unzip', ['-q', zip, '-d', dir]);
    }

    for (const [locale, button, message] of [
        ['en-US', 'Sync now', 'Wrong username or app password.'],
        ['fr', 'Synchroniser', "Identifiant ou mot de passe d'application incorrect."],
    ]) {
        await step(`Store package loads and is translated (${locale})`, async () => {
            const device = await launchDevice(`package-${locale}`, { extensionDir: dir, locale });
            try {
                const info = await device.ev(() => ({ version: chrome.runtime.getManifest().version, message: t('errWrongPassword') }));
                assert.deepStrictEqual(info, { version, message });
                const page = await device.context.newPage();
                await page.goto(`chrome-extension://${device.extensionId}/popup.html`);
                await page.waitForTimeout(300);
                assert.strictEqual(await page.textContent('#syncBtn'), button);
                assert.strictEqual(await page.textContent('#version'), `v${version}`);
            } finally {
                await device.close();
            }
        });
    }
    report();
})().catch((e) => {
    report();
    console.error('CRASH', e);
    process.exit(1);
});
