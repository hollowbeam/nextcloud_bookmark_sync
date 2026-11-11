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

// Wait for the DOM to be fully loaded before running scripts (fixes layout warnings)
document.addEventListener('DOMContentLoaded', async () => {

    // 1. View Navigation Logic
    const mainView = document.getElementById('mainView');
    const settingsView = document.getElementById('settingsView');

    const showSettings = () => {
        mainView.classList.remove('active');
        settingsView.classList.add('active');
    };
    document.getElementById('goToSettingsBtn').addEventListener('click', showSettings);
    document.getElementById('openSettingsBtn').addEventListener('click', showSettings);

    document.getElementById('goToMainBtn').addEventListener('click', () => {
        settingsView.classList.remove('active');
        mainView.classList.add('active');
    });


    // First-run guidance: shown until the URL, username and password are filled in
    function updateSetupCard(settings) {
        const configured = settings.serverUrl && settings.username && settings.password;
        document.getElementById('setupCard').hidden = Boolean(configured);
    }

    // Outcome of the last export or import (manual or automatic), kept by the background script
    function renderLastSync(lastSync) {
        const line = document.getElementById('lastSync');
        if (!lastSync) {
            line.textContent = '';
            return;
        }
        const when = new Date(lastSync.time).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
        const what = lastSync.kind === 'import' ? 'Import' : 'Export';
        line.className = lastSync.ok ? '' : 'failed';
        line.textContent = lastSync.ok
            ? `Last sync: ${what} OK, ${when}`
            : `Last ${what.toLowerCase()} failed (${when}): ${lastSync.message}`;
    }

    // A file written by a device on 1.5.1 or older was seen recently (set by the background)
    const LEGACY_WARNING_MS = 7 * 24 * 60 * 60 * 1000;
    function renderLegacyWarning(legacySeenAt) {
        document.getElementById('legacyWarning').hidden = !(legacySeenAt && Date.now() - legacySeenAt < LEGACY_WARNING_MS);
    }

    // Version of the installed extension, handy when helping someone or reporting a bug
    if (chrome.runtime.getManifest) {
        document.getElementById('version').textContent = `v${chrome.runtime.getManifest().version}`;
    }

    chrome.storage.local.get(['lastSync', 'legacySeenAt'], (result) => {
        renderLastSync(result.lastSync);
        renderLegacyWarning(result.legacySeenAt);
    });

    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        if (changes.lastSync) renderLastSync(changes.lastSync.newValue);
        if (changes.legacySeenAt) renderLegacyWarning(changes.legacySeenAt.newValue);
        if (changes.serverUrl || changes.username || changes.password) {
            chrome.storage.local.get(['serverUrl', 'username', 'password'], updateSetupCard);
        }
    });


    // 2. Load Settings & Initialize ID
    chrome.storage.local.get([
        'serverUrl', 'username', 'password', 'extensionId',
        'syncFrequency', 'autoSyncEnabled', 'retentionDays'
    ], async (result) => {
        updateSetupCard(result);

        // Populate text inputs
        if (result.serverUrl) document.getElementById('serverUrl').value = result.serverUrl;
        if (result.username) document.getElementById('username').value = result.username;
        if (result.password) document.getElementById('password').value = result.password;
        if (result.syncFrequency) document.getElementById('syncFrequency').value = result.syncFrequency;

        // Populate Auto-sync toggle (Default to true)
        const autoSyncCheckbox = document.getElementById('autoSyncEnabled');
        if (autoSyncCheckbox) {
            autoSyncCheckbox.checked = result.autoSyncEnabled !== false;
        }

        // Populate Retention Slider (Default to 30 days)
        const retentionDaysInput = document.getElementById('retentionDays');
        const daysValueSpan = document.getElementById('daysValue');
        if (retentionDaysInput && daysValueSpan) {
            const days = result.retentionDays || 30;
            retentionDaysInput.value = days;
            daysValueSpan.textContent = days + (days == 1 ? ' day' : ' days');
        }

        // Generate Extension ID if missing
        let extId = result.extensionId;
        if (!extId) {
            const prefix = await getBrowserPrefix();
            const randomDigits = Math.floor(10000000 + Math.random() * 90000000);
            extId = `${prefix}${randomDigits}`;
            chrome.storage.local.set({ extensionId: extId });
        }
    });


    // 3. Auto-Sync Toggle Logic (Main View)
    document.getElementById('autoSyncEnabled').addEventListener('change', (e) => {
        const isEnabled = e.target.checked;
        chrome.storage.local.set({ autoSyncEnabled: isEnabled }, () => {

            // Show status feedback directly on the main view
            const status = document.getElementById('status');
            status.style.color = isEnabled ? "#27ae60" : "#777";
            status.textContent = isEnabled ? "Auto-sync enabled" : "Auto-sync disabled";

            setTimeout(() => {
                if (status.textContent.includes("Auto-sync")) {
                    status.textContent = '';
                }
            }, 2000);

            // Notify background script to stop/start timers
            chrome.runtime.sendMessage({
                action: "toggle_auto_sync",
                enabled: isEnabled
            });
        });
    });


    // 4. Archive Retention Slider Logic (Settings View)
    const retentionDaysInput = document.getElementById('retentionDays');
    const daysValueSpan = document.getElementById('daysValue');

    if (retentionDaysInput && daysValueSpan) {
        // Update text dynamically while dragging
        retentionDaysInput.addEventListener('input', (e) => {
            const days = e.target.value;
            daysValueSpan.textContent = days + (days == 1 ? ' day' : ' days');
        });

        // Save to storage only when user drops the slider
        retentionDaysInput.addEventListener('change', (e) => {
            chrome.storage.local.set({ retentionDays: parseInt(e.target.value, 10) }, () => {
                const indicator = document.getElementById('saveIndicator');
                indicator.style.opacity = '1';
                setTimeout(() => indicator.style.opacity = '0', 2000);
            });
        });
    }


    // 5. Debounced Auto-Save Logic (For text inputs and dropdowns)
    const inputs = ['serverUrl', 'username', 'password', 'syncFrequency'];
    const saveTimeouts = {};

    function persistField(id) {
        const value = document.getElementById(id).value.trim();
        chrome.storage.local.set({ [id]: value }, () => {

            // Show small "Saved!" animation
            const indicator = document.getElementById('saveIndicator');
            indicator.style.opacity = '1';
            setTimeout(() => indicator.style.opacity = '0', 2000);

            // If frequency changed, notify background script to update the alarm
            if (id === 'syncFrequency') {
                chrome.runtime.sendMessage({
                    action: "update_alarm",
                    frequency: parseInt(value, 10)
                });
            }
        });
    }

    inputs.forEach(id => {
        document.getElementById(id).addEventListener('input', () => {
            clearTimeout(saveTimeouts[id]);
            saveTimeouts[id] = setTimeout(() => persistField(id), 600); // 600ms debounce
        });
    });

    // Flush any pending debounced save immediately once the popup loses focus,
    // since it can be dismissed at any moment and a queued save would otherwise be lost.
    window.addEventListener('blur', () => {
        inputs.forEach(id => {
            if (saveTimeouts[id]) {
                clearTimeout(saveTimeouts[id]);
                saveTimeouts[id] = null;
                persistField(id);
            }
        });
    });


    // 6. Server access
    // Checks the URL and asks for the host permission (needs the user's click).
    // Returns null when access is granted, otherwise the message to show.
    async function requestServerAccess(serverUrl) {
        if (!serverUrl) return "Not set up yet: open Settings (⚙️).";

        let parsedUrl = null;
        try {
            parsedUrl = new URL(serverUrl);
        } catch {
            return "Invalid server URL.";
        }

        // The manifest only allows https hosts
        if (parsedUrl.protocol !== 'https:') return "Server URL must use https.";

        // Hostname rather than origin: Firefox match patterns don't support ports
        const origin = `https://${parsedUrl.hostname}/*`;

        const granted = await new Promise(resolve => chrome.permissions.request({ origins: [origin] }, resolve));
        return granted ? null : "Permission denied for this server.";
    }

    const RED = "#c0392b";

    // Reads the background's answer; a missing one (e.g. a closed port) reads as an error
    function backgroundResponse(response) {
        if (chrome.runtime.lastError) console.warn(chrome.runtime.lastError.message);
        return response || { status: "error", message: "Error." };
    }

    // A result for other values is misleading once a field changes
    const testResult = document.getElementById('testResult');
    ['serverUrl', 'username', 'password'].forEach(id => {
        document.getElementById(id).addEventListener('input', () => { testResult.textContent = ''; });
    });

    // 7. Connection test (Settings View): uses the values typed, even if not saved yet
    const testBtn = document.getElementById('testConnectionBtn');
    testBtn.addEventListener('click', async () => {
        const result = testResult;
        const settings = {
            serverUrl: document.getElementById('serverUrl').value.trim(),
            username: document.getElementById('username').value.trim(),
            password: document.getElementById('password').value.trim(),
        };

        const accessError = await requestServerAccess(settings.serverUrl);
        if (accessError) {
            result.style.color = RED;
            result.textContent = accessError;
            return;
        }

        result.style.color = "#777";
        result.textContent = "Testing...";
        testBtn.disabled = true;
        chrome.runtime.sendMessage({ action: "test_connection", ...settings }, (reply) => {
            const response = backgroundResponse(reply);
            testBtn.disabled = false;
            result.style.color = response.status === "success" ? "#27ae60" : RED;
            result.textContent = response.message;
        });
    });


    // 8. Main Actions (Push & Pull)
    let statusClearTimer = null;

    function handleSyncAction(actionName, btnId, activeColor, loadingText) {
        const btn = document.getElementById(btnId);
        if (!btn) return;

        btn.addEventListener('click', async () => {
            const status = document.getElementById('status');
            // A pending clear from an earlier success must not wipe this action's message
            clearTimeout(statusClearTimer);
            const serverUrl = document.getElementById('serverUrl').value.trim();

            const accessError = await requestServerAccess(serverUrl);
            if (accessError) {
                status.style.color = RED;
                status.textContent = accessError;
                return;
            }

            status.style.color = activeColor;
            status.textContent = loadingText;

            chrome.runtime.sendMessage({ action: actionName }, (reply) => {
                const response = backgroundResponse(reply);
                const ok = response.status === "success";
                status.style.color = ok ? activeColor : RED;
                status.textContent = response.message;
                // Errors stay until the next action: they say what to fix
                if (ok || response.status === "locked") {
                    statusClearTimer = setTimeout(() => { status.textContent = ''; }, 3500);
                }
            });
        });
    }

    // Initialize the sync buttons with your specific action names
    handleSyncAction('push_bookmarks', 'pushBtn', '#27ae60', 'Exporting...');
    handleSyncAction('pull_bookmarks', 'pullBtn', '#e67e22', 'Importing...');

});