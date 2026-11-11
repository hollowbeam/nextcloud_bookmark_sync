// popup.js
/*
    Nextcloud Bookmark Sync
    Copyright (C) 2026  Hollow Inc.

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

// ==========================================
// UTILITY FUNCTIONS
// ==========================================

const LEGACY_WARNING_MS = 7 * 24 * 60 * 60 * 1000;

// Text in the browser's language (_locales/), the key itself when missing
function t(key, ...substitutions) {
    const text = chrome.i18n && chrome.i18n.getMessage(key, substitutions.map(String));
    return text || key;
}

// The language of the messages actually shown (a browser in German gets English
// messages: dates must be in English too)
function uiLanguage() {
    return t('locale') === 'locale' ? 'en' : t('locale');
}

// Fills the elements marked data-i18n (text), data-i18n-placeholder and data-i18n-title
function translatePage() {
    document.documentElement.lang = uiLanguage();
    document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
    document.querySelectorAll('[data-i18n-placeholder]').forEach(el => { el.placeholder = t(el.dataset.i18nPlaceholder); });
    document.querySelectorAll('[data-i18n-title]').forEach(el => {
        el.title = t(el.dataset.i18nTitle);
        el.setAttribute('aria-label', el.title);
    });
}

// "just now", "3 minutes ago", "yesterday"...
function relativeTime(time) {
    const seconds = Math.round((time - Date.now()) / 1000);
    if (seconds > -60) return t('justNow');
    const format = new Intl.RelativeTimeFormat(uiLanguage(), { numeric: 'auto' });
    const minutes = Math.round(seconds / 60);
    if (minutes > -60) return format.format(minutes, 'minute');
    const hours = Math.round(minutes / 60);
    if (hours > -24) return format.format(hours, 'hour');
    return format.format(Math.round(hours / 24), 'day');
}

// Detect browser for unique ID generation
async function getBrowserPrefix() {
    if (navigator.brave && await navigator.brave.isBrave()) return 'b';
    if (navigator.userAgent.includes('Firefox')) return 'f';
    if (navigator.userAgent.includes('Edg')) return 'e';
    if (navigator.userAgent.includes('Chrome')) return 'c';
    return 'x';
}

// ==========================================
// MAIN INITIALIZATION
// ==========================================

document.addEventListener('DOMContentLoaded', async () => {
    translatePage();

    const $ = (id) => document.getElementById(id);

    // Shows a result line: kind is 'ok', 'error', 'busy' or '' (plain)
    function show(el, text, kind = '') {
        el.className = el.className.split(' ').filter(c => !['ok', 'error', 'busy'].includes(c)).concat(kind ? [kind] : []).join(' ');
        el.textContent = text;
    }

    // Reads the background's answer; a missing one (e.g. a closed port) reads as an error
    function backgroundResponse(response) {
        if (chrome.runtime.lastError) console.warn(chrome.runtime.lastError.message);
        return response || { status: "error", message: t('errGeneric') };
    }


    // 1. Views
    const mainView = $('mainView');
    const settingsView = $('settingsView');

    const showSettings = () => {
        mainView.classList.remove('active');
        settingsView.classList.add('active');
    };
    $('goToSettingsBtn').addEventListener('click', showSettings);
    $('openSettingsBtn').addEventListener('click', showSettings);
    $('checkSettings').addEventListener('click', showSettings);

    $('goToMainBtn').addEventListener('click', () => {
        settingsView.classList.remove('active');
        mainView.classList.add('active');
    });


    // 2. Main screen state: setup card, last sync, old-version warning, version

    // First-run guidance: shown until the URL, username and password are filled in
    function updateSetupCard(settings) {
        const configured = settings.serverUrl && settings.username && settings.password;
        $('setupCard').hidden = Boolean(configured);
    }

    // Outcome of the last sync (manual or automatic), kept by the background script
    let lastSync = null;
    function renderLastSync(record) {
        lastSync = record || null;
        const line = $('lastSync');
        if (!lastSync) {
            show(line, '');
            return;
        }
        const when = relativeTime(lastSync.time);
        line.classList.toggle('failed', !lastSync.ok);
        line.textContent = lastSync.ok
            ? t('lastSyncOk', when)
            : t('lastSyncFailed', when, lastSync.message);
    }
    // Keeps "3 minutes ago" true while the popup stays open
    if (typeof setInterval === 'function') setInterval(() => renderLastSync(lastSync), 30000);

    // A file written by a device on 1.5.1 or older was seen recently (set by the background)
    function renderLegacyWarning(legacySeenAt) {
        $('legacyWarning').hidden = !(legacySeenAt && Date.now() - legacySeenAt < LEGACY_WARNING_MS);
    }

    // Version of the installed extension, handy when helping someone or reporting a bug
    if (chrome.runtime.getManifest) {
        $('version').textContent = `v${chrome.runtime.getManifest().version}`;
    }

    // Several "🔄 Bookmark Sync" folders (counted by the background): only the oldest syncs
    function renderDuplicateWarning(extra) {
        const warning = $('duplicateWarning');
        warning.hidden = !(extra > 0);
        if (extra > 0) warning.textContent = t('duplicateFolders', extra);
    }

    chrome.storage.local.get(['lastSync', 'legacySeenAt', 'duplicateSyncFolders'], (result) => {
        renderLastSync(result.lastSync);
        renderLegacyWarning(result.legacySeenAt);
        renderDuplicateWarning(result.duplicateSyncFolders);
    });

    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        if (changes.lastSync) renderLastSync(changes.lastSync.newValue);
        if (changes.legacySeenAt) renderLegacyWarning(changes.legacySeenAt.newValue);
        if (changes.duplicateSyncFolders) renderDuplicateWarning(changes.duplicateSyncFolders.newValue);
        if (changes.serverUrl || changes.username || changes.password) {
            chrome.storage.local.get(['serverUrl', 'username', 'password'], updateSetupCard);
        }
    });


    // 3. Load settings & initialize the device ID
    const daysText = (days) => (Number(days) === 1 ? t('oneDay') : t('days', days));

    chrome.storage.local.get([
        'serverUrl', 'username', 'password', 'extensionId',
        'syncFrequency', 'autoSyncEnabled', 'retentionDays'
    ], async (result) => {
        updateSetupCard(result);

        if (result.serverUrl) $('serverUrl').value = result.serverUrl;
        if (result.username) $('username').value = result.username;
        if (result.password) $('password').value = result.password;
        if (result.syncFrequency) $('syncFrequency').value = result.syncFrequency;

        // Auto-sync is on by default
        $('autoSyncEnabled').checked = result.autoSyncEnabled !== false;
        renderAutoSyncState();

        const days = result.retentionDays || 30;
        $('retentionDays').value = days;
        $('daysValue').textContent = daysText(days);

        if (!result.extensionId) {
            const prefix = await getBrowserPrefix();
            const randomDigits = Math.floor(10000000 + Math.random() * 90000000);
            chrome.storage.local.set({ extensionId: `${prefix}${randomDigits}` });
        }
    });


    // 4. Automatic sync toggle (main screen)
    function renderAutoSyncState() {
        const on = $('autoSyncEnabled').checked;
        const state = $('autoSyncState');
        state.textContent = on ? t('autoSyncOn') : t('autoSyncPaused');
        state.classList.toggle('on', on);
    }

    $('autoSyncEnabled').addEventListener('change', (e) => {
        const isEnabled = e.target.checked;
        renderAutoSyncState();
        chrome.storage.local.set({ autoSyncEnabled: isEnabled }, () => {
            // Starts or stops the background timers
            chrome.runtime.sendMessage({ action: "toggle_auto_sync", enabled: isEnabled });
        });
    });


    // 5. Settings: saved as you type
    const flashSaved = () => {
        const indicator = $('saveIndicator');
        indicator.style.opacity = '1';
        setTimeout(() => { indicator.style.opacity = '0'; }, 2000);
    };

    $('retentionDays').addEventListener('input', (e) => { $('daysValue').textContent = daysText(e.target.value); });
    $('retentionDays').addEventListener('change', (e) => {
        chrome.storage.local.set({ retentionDays: parseInt(e.target.value, 10) }, flashSaved);
    });

    const inputs = ['serverUrl', 'username', 'password', 'syncFrequency'];
    const saveTimeouts = {};

    function persistField(id) {
        const value = $(id).value.trim();
        return new Promise(resolve => chrome.storage.local.set({ [id]: value }, () => {
            flashSaved();
            // The frequency drives the background alarm
            if (id === 'syncFrequency') {
                chrome.runtime.sendMessage({ action: "update_alarm", frequency: parseInt(value, 10) });
            }
            resolve();
        }));
    }

    // Saves the fields still waiting for their debounce: a sync started right after
    // typing must use the new values, which the background reads from storage
    function flushPendingSaves() {
        return Promise.all(inputs.filter(id => saveTimeouts[id]).map(id => {
            clearTimeout(saveTimeouts[id]);
            saveTimeouts[id] = null;
            return persistField(id);
        }));
    }

    inputs.forEach(id => {
        $(id).addEventListener('input', () => {
            clearTimeout(saveTimeouts[id]);
            saveTimeouts[id] = setTimeout(() => persistField(id), 600);
        });
    });

    // The popup can close at any moment: a pending save is flushed when it loses focus
    window.addEventListener('blur', () => { flushPendingSaves(); });

    // App passwords are long and pasted: showing them helps spot a stray character
    $('togglePassword').addEventListener('click', () => {
        const field = $('password');
        const showing = field.type === 'text';
        field.type = showing ? 'password' : 'text';
        $('togglePassword').textContent = showing ? t('showPassword') : t('hidePassword');
    });


    // 6. Server access
    // Checks the URL and asks for the host permission (needs the user's click).
    // Returns null when access is granted, otherwise the message to show.
    async function requestServerAccess(serverUrl) {
        if (!serverUrl) return t('notSetUp');

        let parsedUrl = null;
        try {
            parsedUrl = new URL(serverUrl);
        } catch {
            return t('errInvalidUrl');
        }

        // The manifest only allows https hosts
        if (parsedUrl.protocol !== 'https:') return t('errHttpsOnly');

        // Hostname rather than origin: Firefox match patterns don't support ports
        const origin = `https://${parsedUrl.hostname}/*`;

        const granted = await new Promise(resolve => chrome.permissions.request({ origins: [origin] }, resolve));
        return granted ? null : t('errPermissionDenied');
    }


    // 7. Connection test: uses the values typed, even if not saved yet
    const testResult = $('testResult');
    // A result for other values is misleading once a field changes
    ['serverUrl', 'username', 'password'].forEach(id => {
        $(id).addEventListener('input', () => show(testResult, ''));
    });

    const testBtn = $('testConnectionBtn');
    testBtn.addEventListener('click', async () => {
        const settings = {
            serverUrl: $('serverUrl').value.trim(),
            username: $('username').value.trim(),
            password: $('password').value.trim(),
        };

        const accessError = await requestServerAccess(settings.serverUrl);
        if (accessError) return show(testResult, accessError, 'error');

        show(testResult, t('testing'), 'busy');
        testBtn.disabled = true;
        chrome.runtime.sendMessage({ action: "test_connection", ...settings }, (reply) => {
            const response = backgroundResponse(reply);
            testBtn.disabled = false;
            show(testResult, response.message, response.status === "success" ? 'ok' : 'error');
        });
    });


    // 8. Sync now (main screen) and Import only (advanced settings)
    let statusClearTimer = null;

    async function runAction(action, resultEl, busyText, button) {
        // A pending clear from an earlier success must not wipe this action's message
        clearTimeout(statusClearTimer);
        $('checkSettings').hidden = true;

        const accessError = await requestServerAccess($('serverUrl').value.trim());
        if (accessError) {
            show(resultEl, accessError, 'error');
            if (resultEl === $('status')) $('checkSettings').hidden = false;
            return;
        }

        show(resultEl, busyText, 'busy');
        button.disabled = true;
        await flushPendingSaves();
        chrome.runtime.sendMessage({ action }, (reply) => {
            const response = backgroundResponse(reply);
            button.disabled = false;
            const ok = response.status === "success";
            show(resultEl, response.message, ok ? 'ok' : (response.status === "locked" ? 'busy' : 'error'));
            // Errors stay until the next action, with a way to the settings to fix them
            if (response.status === "error" && resultEl === $('status')) $('checkSettings').hidden = false;
            if (ok || response.status === "locked") {
                statusClearTimer = setTimeout(() => show(resultEl, ''), 4000);
            }
        });
    }

    $('syncBtn').addEventListener('click', () => runAction('sync_now', $('status'), t('syncing'), $('syncBtn')));
    $('importBtn').addEventListener('click', () => runAction('pull_bookmarks', $('importResult'), t('importing'), $('importBtn')));
});
