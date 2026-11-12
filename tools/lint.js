'use strict';
// Lints the store package with Mozilla's own linter (addons-linter: the checks AMO runs) and
// fails on anything new: an error, or a warning that is not in KNOWN below.
//   node tools/package.js && node tools/lint.js    (the zip of the manifest's version)
//   node tools/lint.js path/to/package.zip
const { execFileSync, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
// Pinned: the version shipped by web-ext 10.8.0 (Node 20 or later)
const LINTER = 'addons-linter@10.14.0';

// The warnings we accept, each with its reason
const KNOWN = [
    // Chromium reads background.service_worker, Firefox reads background.scripts: both point at background.js
    { code: 'BACKGROUND_SERVICE_WORKER_IGNORED', file: 'manifest.json' },
    // Feature-detected in background.js and skipped on Firefox
    { code: 'UNSUPPORTED_API', file: 'background.js', message: /onChildrenReordered/ },
];

const accepted = (finding, known) => finding.code === known.code && finding.file === known.file
    && (!known.message || known.message.test(finding.message || ''));

// What the report holds that is not accepted: every error, and each warning that is not in KNOWN
function unexpected(report, known = KNOWN) {
    return [
        ...(report.errors || []).map(finding => ({ level: 'error', ...finding })),
        ...(report.warnings || []).filter(finding => !known.some(k => accepted(finding, k)))
            .map(finding => ({ level: 'warning', ...finding })),
    ];
}

function lint(zip) {
    const options = { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] };
    try {
        // npx is a .cmd file on Windows, which only runs through a shell (the path is ours, quoted)
        const stdout = process.platform === 'win32'
            ? execSync(`npx.cmd --yes ${LINTER} "${zip}" --output json`, options)
            : execFileSync('npx', ['--yes', LINTER, zip, '--output', 'json'], options);
        return JSON.parse(stdout);
    } catch (error) {
        // The linter exits with 1 when it finds errors: its report is still on stdout
        if (error.stdout) return JSON.parse(error.stdout);
        throw new Error(`The linter did not run: ${error.stderr || error.message}`);
    }
}

if (require.main === module) {
    const version = JSON.parse(fs.readFileSync(path.join(REPO, 'manifest.json'), 'utf8')).version;
    const zip = path.resolve(process.argv[2] || path.join(REPO, 'dist', `nextcloud_bookmark_sync-${version}.zip`));
    if (!fs.existsSync(zip)) {
        console.error(`${zip} not found: run node tools/package.js first.`);
        process.exit(2);
    }
    const report = lint(zip);
    const problems = unexpected(report);
    console.log(`${path.relative(REPO, zip)}: ${report.summary.errors} errors, ${report.summary.warnings} warnings (${report.summary.warnings - problems.filter(p => p.level === 'warning').length} accepted), ${report.summary.notices} notices`);
    for (const p of problems) console.error(`${p.level.toUpperCase()} ${p.code} ${p.file || ''}: ${p.message}`);
    if (problems.length > 0) {
        console.error('Fix it, or add the warning to KNOWN in tools/lint.js with the reason it is accepted.');
        process.exit(1);
    }
}

module.exports = { unexpected, KNOWN };
