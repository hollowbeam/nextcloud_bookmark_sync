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

    document.getElementById('goToSettingsBtn').addEventListener('click', () => {
        mainView.classList.remove('active');
        settingsView.classList.add('active');
    });

    document.getElementById('goToMainBtn').addEventListener('click', () => {
        settingsView.classList.remove('active');
        mainView.classList.add('active');
    });


    // 2. Load Settings & Initialize ID
    chrome.storage.local.get([
        'serverUrl', 'username', 'password', 'extensionId',
        'syncFrequency', 'autoSyncEnabled', 'retentionDays'
    ], async (result) => {

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
    let timeoutId;

    inputs.forEach(id => {
        document.getElementById(id).addEventListener('input', (e) => {
            clearTimeout(timeoutId);
            timeoutId = setTimeout(() => {
                const value = e.target.value.trim();
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
            }, 600); // 600ms debounce
        });
    });


    // 6. Main Actions (Push & Pull)
    // Wrapped inside DOMContentLoaded so document.getElementById doesn't fail
    function handleSyncAction(actionName, btnId, activeColor, loadingText) {
        const btn = document.getElementById(btnId);
        if (!btn) return;

        btn.addEventListener('click', () => {
            const status = document.getElementById('status');
            status.style.color = activeColor;
            status.textContent = loadingText;

            chrome.runtime.sendMessage({ action: actionName }, (response) => {
                if (response && response.status === "locked") {
                    status.style.color = "#c0392b"; // Red
                    status.textContent = response.message;
                } else if (response && response.status === "success") {
                    status.style.color = activeColor;
                    status.textContent = response.message;
                } else {
                    status.style.color = "#c0392b";
                    status.textContent = response ? response.message : "Error.";
                }
                setTimeout(() => { status.textContent = ''; }, 3500);
            });
        });
    }

    // Initialize the sync buttons with your specific action names
    handleSyncAction('push_bookmarks', 'pushBtn', '#27ae60', 'Exporting...');
    handleSyncAction('pull_bookmarks', 'pullBtn', '#e67e22', 'Importing...');

});