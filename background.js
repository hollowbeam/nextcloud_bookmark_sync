// background.js

const SYNC_FOLDER_NAME = "🔄 Bookmark Sync"; // Added the emoji back!

let isSyncing = false; // Prevents infinite loops during automated pulls
let syncTimeout = null; // Debounce timer for automated pushes

// --- FOLDER MANAGEMENT ---

// Find the sync folder, or create it in the Bookmarks Bar
async function getOrCreateSyncFolder() {
    return new Promise((resolve, reject) => {
        chrome.bookmarks.search({ title: SYNC_FOLDER_NAME }, (results) => {
            const folder = results.find(r => !r.url);
            if (folder) return resolve(folder.id);

            // Attempt 1: Chrome/Brave Bookmarks Bar (ID '1')
            chrome.bookmarks.create({ parentId: '1', title: SYNC_FOLDER_NAME, index: 0 }, (chromeFolder) => {
                if (!chrome.runtime.lastError) return resolve(chromeFolder.id);

                // Attempt 2: Firefox Bookmarks Toolbar
                chrome.bookmarks.create({ parentId: 'toolbar_____', title: SYNC_FOLDER_NAME, index: 0 }, (ffFolder) => {
                    if (!chrome.runtime.lastError) return resolve(ffFolder.id);

                    // Attempt 3: Ultimate fallback
                    chrome.bookmarks.create({ title: SYNC_FOLDER_NAME }, (fallbackFolder) => {
                        if (chrome.runtime.lastError) {
                            return reject(new Error("Browser blocked folder creation."));
                        }
                        resolve(fallbackFolder.id);
                    });
                });
            });
        });
    });
}

// --- MUTEX LOCK MANAGEMENT ---

// Check Nextcloud for existing lock files
async function getActiveLocks(baseUrl, authHeader) {
    try {
        const response = await fetch(baseUrl, {
            method: 'PROPFIND',
            credentials: 'omit',
            headers: { 'Authorization': authHeader, 'Depth': '1' }
        });

        if (!response.ok) return null;

        const xmlText = await response.text();
        const lockRegex = /([bfecx]\d{8}_(\d+)\.lock)/g;
        const matches = [...xmlText.matchAll(lockRegex)];

        let activeLocks = [];
        const now = Date.now();
        const TEN_MINUTES = 10 * 60 * 1000;

        for (const match of matches) {
            const lockFileName = match[1];
            const timestamp = parseInt(match[2], 10);

            // Delete stale locks (older than 10 mins)
            if (now - timestamp > TEN_MINUTES) {
                await removeLock(baseUrl, authHeader, lockFileName);
            } else {
                activeLocks.push(lockFileName);
            }
        }
        return activeLocks;
    } catch (error) {
        return null;
    }
}

// Create a temporary lock file
async function createLock(baseUrl, authHeader, extensionId) {
    const timestamp = Date.now();
    const lockFileName = `${extensionId}_${timestamp}.lock`;
    try {
        const response = await fetch(baseUrl + lockFileName, {
            method: 'PUT',
            credentials: 'omit',
            headers: { 'Authorization': authHeader },
            body: "BookSync in progress."
        });
        return response.ok ? lockFileName : false;
    } catch (error) {
        return false;
    }
}

// Delete the lock file
async function removeLock(baseUrl, authHeader, lockFileName) {
    try {
        await fetch(baseUrl + lockFileName, {
            method: 'DELETE',
            credentials: 'omit',
            headers: { 'Authorization': authHeader }
        });
    } catch (error) {}
}

// --- EXPORT (PUSH) ---

async function pushBookmarksToServer(sendResponse = () => {}) {
    chrome.storage.local.get(['serverUrl', 'username', 'password', 'extensionId'], async (result) => {
        if (!result.serverUrl || !result.username || !result.password || !result.extensionId) {
            return sendResponse({ status: "error", message: "Missing credentials." });
        }

        const { serverUrl, username, password, extensionId } = result;
        const credentials = username + ':' + password;
        const authHeader = 'Basic ' + btoa(unescape(encodeURIComponent(credentials)));
        const baseUrl = serverUrl.endsWith('/') ? serverUrl : serverUrl + '/';
        const fileUrl = baseUrl + 'bookmarks_sync.json';

        const activeLocks = await getActiveLocks(baseUrl, authHeader);
        if (activeLocks === null) return sendResponse({ status: "error", message: "Server error." });

        const otherLocks = activeLocks.filter(lock => !lock.startsWith(extensionId));
        if (otherLocks.length > 0) {
            return sendResponse({ status: "locked", message: "Another device is syncing." });
        }

        const myLockFile = await createLock(baseUrl, authHeader, extensionId);
        if (!myLockFile) return sendResponse({ status: "error", message: "Lock failed." });

        try {
            const syncFolderId = await getOrCreateSyncFolder();

            chrome.bookmarks.getSubTree(syncFolderId, async (results) => {
                if (chrome.runtime.lastError) throw new Error(chrome.runtime.lastError.message);

                const bookmarksData = JSON.stringify(results[0], null, 2);

                const response = await fetch(fileUrl, {
                    method: 'PUT',
                    credentials: 'omit',
                    headers: { 'Authorization': authHeader },
                    body: bookmarksData
                });

                if (response.ok) {
                    sendResponse({ status: "success", message: "Export successful!" });
                } else {
                    sendResponse({ status: "error", message: `HTTP Error: ${response.status}` });
                }
            });
        } catch (error) {
            sendResponse({ status: "error", message: "Export crashed." });
        } finally {
            setTimeout(async () => { await removeLock(baseUrl, authHeader, myLockFile); }, 2000);
        }
    });
}

// --- IMPORT (PULL) ---

async function pullBookmarksFromServer(sendResponse = () => {}) {
    isSyncing = true; // Disable local event listeners to prevent loop

    chrome.storage.local.get(['serverUrl', 'username', 'password', 'extensionId'], async (result) => {
        if (!result.serverUrl || !result.username || !result.password || !result.extensionId) {
            isSyncing = false;
            return sendResponse({ status: "error", message: "Missing credentials." });
        }

        const { serverUrl, username, password, extensionId } = result;
        const credentials = username + ':' + password;
        const authHeader = 'Basic ' + btoa(unescape(encodeURIComponent(credentials)));
        const baseUrl = serverUrl.endsWith('/') ? serverUrl : serverUrl + '/';
        const fileUrl = baseUrl + 'bookmarks_sync.json';

        const activeLocks = await getActiveLocks(baseUrl, authHeader);
        if (activeLocks === null) {
            isSyncing = false;
            return sendResponse({ status: "error", message: "Server error." });
        }

        const otherLocks = activeLocks.filter(lock => !lock.startsWith(extensionId));
        if (otherLocks.length > 0) {
            isSyncing = false;
            return sendResponse({ status: "locked", message: "Another device is syncing." });
        }

        const myLockFile = await createLock(baseUrl, authHeader, extensionId);
        if (!myLockFile) {
            isSyncing = false;
            return sendResponse({ status: "error", message: "Lock failed." });
        }

        try {
            const response = await fetch(fileUrl, {
                method: 'GET',
                credentials: 'omit',
                headers: { 'Authorization': authHeader }
            });

            if (response.status === 404) {
                isSyncing = false;
                return sendResponse({ status: "error", message: "No file found." });
            }
            if (!response.ok) throw new Error(`HTTP Error: ${response.status}`);

            const remoteFolderData = await response.json();
            const syncFolderId = await getOrCreateSyncFolder();
            let addedCount = 0;

            const getChildrenAsync = (parentId) => {
                return new Promise(resolve => chrome.bookmarks.getChildren(parentId, resolve));
            };

            // Recursive merge algorithm
            async function syncNodes(remoteNodes, localParentId) {
                const localChildren = await getChildrenAsync(localParentId);

                for (const remoteNode of remoteNodes) {
                    if (remoteNode.url) {
                        const exists = localChildren.some(c => c.url === remoteNode.url);
                        if (!exists) {
                            await new Promise(resolve => {
                                chrome.bookmarks.create({ parentId: localParentId, title: remoteNode.title, url: remoteNode.url }, resolve);
                            });
                            addedCount++;
                        }
                    } else if (remoteNode.children) {
                        let existingFolder = localChildren.find(c => !c.url && c.title === remoteNode.title);
                        let targetFolderId = existingFolder ? existingFolder.id : null;

                        if (!targetFolderId) {
                            const newFolder = await new Promise(resolve => {
                                chrome.bookmarks.create({ parentId: localParentId, title: remoteNode.title }, resolve);
                            });
                            targetFolderId = newFolder.id;
                        }
                        await syncNodes(remoteNode.children, targetFolderId);
                    }
                }
            }

            if (remoteFolderData.children) {
                await syncNodes(remoteFolderData.children, syncFolderId);
            }

            isSyncing = false; // Re-enable local event listeners
            sendResponse({ status: "success", message: `${addedCount} items imported!` });

        } catch (error) {
            isSyncing = false;
            sendResponse({ status: "error", message: "Import crashed." });
        } finally {
            setTimeout(async () => { await removeLock(baseUrl, authHeader, myLockFile); }, 2000);
        }
    });
}

// ==========================================
// --- AUTOMATION & BACKGROUND LISTENERS ---
// ==========================================

// Handles debouncing for local changes
function scheduleAutomaticPush() {
    if (isSyncing) return;

    if (syncTimeout) clearTimeout(syncTimeout);
    syncTimeout = setTimeout(() => {
        pushBookmarksToServer();
    }, 5000);
}

// 1. Listen to Local Changes (Safe approach for cross-browser)
if (chrome.bookmarks && chrome.bookmarks.onCreated) {
    chrome.bookmarks.onCreated.addListener(scheduleAutomaticPush);
    chrome.bookmarks.onRemoved.addListener(scheduleAutomaticPush);
    chrome.bookmarks.onChanged.addListener(scheduleAutomaticPush);
    chrome.bookmarks.onMoved.addListener(scheduleAutomaticPush);
    if (chrome.bookmarks.onChildrenReordered) {
        chrome.bookmarks.onChildrenReordered.addListener(scheduleAutomaticPush);
    }
}

// 2. Setup Periodic Pull Alarm based on user settings
function setupAlarm() {
    if (!chrome.alarms) return;
    chrome.storage.local.get(['syncFrequency'], (result) => {
        const frequency = parseInt(result.syncFrequency, 10) || 15; // Default to 15 mins
        chrome.alarms.create("autoPullAlarm", { periodInMinutes: frequency });
    });
}

// Initialize alarm on startup
setupAlarm();

chrome.alarms?.onAlarm.addListener((alarm) => {
    if (alarm.name === "autoPullAlarm") {
        pullBookmarksFromServer();
    }
});

// 3. Listen to messages from the popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "push_bookmarks") {
        pushBookmarksToServer(sendResponse);
        return true;
    } else if (request.action === "pull_bookmarks") {
        pullBookmarksFromServer(sendResponse);
        return true;
    } else if (request.action === "update_alarm") {
        setupAlarm(); // Reconfigure alarm when user changes the dropdown
        sendResponse({ status: "success" });
    }
});