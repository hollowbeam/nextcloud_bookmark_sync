// popup.js
/*
    Netcloud Bookmark Sync
    Copyright (C) 2026  [Votre Nom ou Pseudonyme]

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

// Utility: Detect browser for unique ID generation
async function getBrowserPrefix() {
    if (navigator.brave && await navigator.brave.isBrave()) return 'b';
    if (navigator.userAgent.includes('Firefox')) return 'f';
    if (navigator.userAgent.includes('Edg')) return 'e';
    if (navigator.userAgent.includes('Chrome')) return 'c';
    return 'x';
}

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
    chrome.storage.local.get(['serverUrl', 'username', 'password', 'extensionId', 'syncFrequency'], async (result) => {
        if (result.serverUrl) document.getElementById('serverUrl').value = result.serverUrl;
        if (result.username) document.getElementById('username').value = result.username;
        if (result.password) document.getElementById('password').value = result.password;
        if (result.syncFrequency) document.getElementById('syncFrequency').value = result.syncFrequency;

        let extId = result.extensionId;
        if (!extId) {
            const prefix = await getBrowserPrefix();
            const randomDigits = Math.floor(10000000 + Math.random() * 90000000);
            extId = `${prefix}${randomDigits}`;
            chrome.storage.local.set({ extensionId: extId });
        }
    });

    // 3. Auto-Save Logic (Triggers when user stops typing or changes dropdown)
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
});

// 4. Main Actions (Push & Pull)
function handleSyncAction(actionName, btnId, activeColor, loadingText) {
    document.getElementById(btnId).addEventListener('click', () => {
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

handleSyncAction('push_bookmarks', 'pushBtn', '#27ae60', 'Exporting...');
handleSyncAction('pull_bookmarks', 'pullBtn', '#e67e22', 'Importing...');