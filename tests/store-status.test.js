'use strict';
// The parsing of tools/store-status.js, on answers shaped like the real ones
const { test } = require('node:test');
const assert = require('assert');
const { chromeVersion, amoVersion } = require('../tools/store-status.js');

const updateServer = (updatecheck) => '<?xml version="1.0" encoding="UTF-8"?><gupdate xmlns="http://www.google.com/update2/response" protocol="2.0" server="prod">'
    + '<daystart elapsed_days="7255" elapsed_seconds="17104"/><app appid="khfpengpkhgddoglikfbmbacpgokjnpo" cohort="1::" status="ok">' + updatecheck + '</app></gupdate>';

test('store status: the Chrome version is the one of the updatecheck element, not the XML version', () => {
    assert.strictEqual(chromeVersion(updateServer('<updatecheck codebase="https://x/y.crx" size="54398" status="ok" version="1.7.0"/>')), '1.7.0');
    assert.strictEqual(chromeVersion(updateServer('<updatecheck status="ok" version="1.7.1" size="1"/>')), '1.7.1');
});

test('store status: an unknown extension or an empty answer has no version', () => {
    assert.strictEqual(chromeVersion(updateServer('<updatecheck status="error-unknownApplication"/>')), null);
    assert.strictEqual(chromeVersion(''), null);
    assert.strictEqual(chromeVersion(undefined), null);
});

test('store status: the AMO version and its file status', () => {
    assert.deepStrictEqual(amoVersion({ current_version: { version: '1.7.1', file: { status: 'public' } } }), { version: '1.7.1', status: 'public' });
    assert.deepStrictEqual(amoVersion({ current_version: { version: '1.7.1' } }), { version: '1.7.1', status: undefined });
    assert.strictEqual(amoVersion({}), null);
    assert.strictEqual(amoVersion(null), null);
});
