'use strict';
// Which version of the extension each store serves right now, compared with manifest.json.
//   node tools/store-status.js
// Chrome: the update server that browsers query for auto-updates. The store page is cached and
// can lag behind by hours, the update server tells what a browser would install.
// Firefox: the AMO API (current version and its file status).
// Exit code: 0 when both stores serve the manifest's version, 1 when one differs, 2 when a request failed.
const fs = require('fs');
const path = require('path');

const CHROME_ID = 'khfpengpkhgddoglikfbmbacpgokjnpo';
const CHROME_URL = `https://clients2.google.com/service/update2/crx?response=updatecheck&acceptformat=crx3&prodversion=130.0.0.0&x=id%3D${CHROME_ID}%26uc`;
const AMO_URL = 'https://addons.mozilla.org/api/v5/addons/addon/nextcloud-bookmark-sync/?lang=en-US';

// The version of the <updatecheck> element in the update server's answer, null when it has none
function chromeVersion(xml) {
    const match = /<updatecheck\b[^>]*\bversion="([^"]+)"/.exec(String(xml));
    return match ? match[1] : null;
}

// { version, status } of the current version in the AMO API answer, null when there is none
function amoVersion(json) {
    const current = json && json.current_version;
    return current ? { version: current.version, status: current.file && current.file.status } : null;
}

const get = async (url) => {
    const response = await fetch(url, { signal: AbortSignal.timeout(30000), headers: { 'User-Agent': 'nextcloud_bookmark_sync store-status' } });
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    return response;
};

async function main() {
    const wanted = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'manifest.json'), 'utf8')).version;
    let chrome, amo;
    try {
        chrome = chromeVersion(await (await get(CHROME_URL)).text());
        amo = amoVersion(await (await get(AMO_URL)).json());
    } catch (error) {
        console.error(`Request failed: ${error.message}`);
        process.exit(2);
    }
    const line = (store, version, extra = '') => `${store.padEnd(24)}: ${(version || 'none').padEnd(8)} ${version === wanted ? 'up to date' : 'BEHIND'}${extra}`;
    console.log(`${'manifest.json'.padEnd(24)}: ${wanted}`);
    console.log(line('Chrome (update server)', chrome));
    console.log(line('Firefox (AMO)', amo && amo.version, amo && amo.status ? ` (file ${amo.status})` : ''));
    process.exit(chrome === wanted && amo && amo.version === wanted ? 0 : 1);
}

if (require.main === module) main();

module.exports = { chromeVersion, amoVersion };
