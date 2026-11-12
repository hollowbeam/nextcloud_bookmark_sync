'use strict';
// The decision of tools/lint.js: which findings of the linter fail the build
const { test } = require('node:test');
const assert = require('assert');
const { unexpected } = require('../tools/lint.js');

const serviceWorker = { code: 'BACKGROUND_SERVICE_WORKER_IGNORED', file: 'manifest.json', message: 'Unsupported "/background/service_worker" manifest property is ignored by Firefox.' };
const reordered = { code: 'UNSUPPORTED_API', file: 'background.js', message: 'bookmarks.onChildrenReordered is not supported' };

test('lint: the known warnings are accepted, as many times as they appear', () => {
    assert.deepStrictEqual(unexpected({ errors: [], warnings: [serviceWorker, reordered, reordered] }), []);
});

test('lint: an error always fails', () => {
    const error = { code: 'MANIFEST_FIELD_REQUIRED', file: 'manifest.json', message: 'x' };
    const found = unexpected({ errors: [error], warnings: [] });
    assert.deepStrictEqual(found.map(f => [f.level, f.code]), [['error', 'MANIFEST_FIELD_REQUIRED']]);
});

test('lint: a new warning fails, and so does a known code on another API or file', () => {
    const fresh = { code: 'UNSAFE_VAR_ASSIGNMENT', file: 'popup.js', message: 'Unsafe assignment to innerHTML' };
    const otherApi = { ...reordered, message: 'bookmarks.onImportBegan is not supported' };
    const otherFile = { ...serviceWorker, file: 'other.json' };
    const found = unexpected({ errors: [], warnings: [serviceWorker, fresh, otherApi, otherFile] });
    assert.deepStrictEqual(found.map(f => f.code + ' ' + f.file), ['UNSAFE_VAR_ASSIGNMENT popup.js', 'UNSUPPORTED_API background.js', 'BACKGROUND_SERVICE_WORKER_IGNORED other.json']);
});
