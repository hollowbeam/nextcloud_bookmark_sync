// background.js
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
// CONFIGURATION & GLOBAL VARIABLES
// ==========================================

const SYNC_FOLDER_NAME = "🔄 Bookmark Sync";
const ARCHIVE_FOLDER_NAME = "🗑️ Bookmark Archives";

let isSyncing = false;
let syncTimeout = null;

// ==========================================
// WEBDAV / NEXTCLOUD HELPER FUNCTIONS
// ==========================================

async function getActiveLocks(baseUrl, authHeader) {
    // Your implementation to check .lock files via PROPFIND
    return [];
}

async function createLock(baseUrl, authHeader, extensionId) {
    // Your implementation to create a .lock file via PUT
    return "lockfile";
}

async function removeLock(baseUrl, authHeader, lockFile) {
    // Your implementation to delete the .lock file via DELETE
}

async function getBookmarksTreeAsync(folderId) {
    // Recursively gets the local bookmark tree starting from folderId
    return new Promise(resolve => {
        chrome.bookmarks.getSubTree(folderId, (results) => {
            resolve(results[0]);
        });
    });
}

// ==========================================
// FOLDER MANAGEMENT (SYNC & ARCHIVE)
// ==========================================

// Get or Create the main Sync Folder (Cross-browser safe)
async function getOrCreateSyncFolder() {
    return new Promise((resolve) => {
        chrome.bookmarks.search({ title: SYNC_FOLDER_NAME }, (results) => {
            const folder = results.find(r => !r.url);
            if (folder) return resolve(folder.id);

            // Create in Bookmarks Bar by default (Works on Chrome/Brave)
            chrome.bookmarks.create({ parentId: '1', title: SYNC_FOLDER_NAME }, (newFolder) => {
                if (chrome.runtime.lastError || !newFolder) {
                    // FIREFOX FALLBACK: Let the browser place it safely if '1' is rejected
                    chrome.bookmarks.create({ title: SYNC_FOLDER_NAME }, (fallback) => {
                        resolve(fallback ? fallback.id : null);
                    });
                } else {
                    resolve(newFolder.id);
                }
            });
        });
    });
}

// Find, Create, or Move the Archive folder dynamically next to the Sync folder
async function getOrCreateArchiveFolder(targetParentId, targetIndex) {
    const today = new Date().toISOString().split('T')[0]; // Format: YYYY-MM-DD

    // 1. Ensure the main Archive folder exists in the exact right place
    const mainArchiveId = await new Promise((resolve) => {
        chrome.bookmarks.search({ title: ARCHIVE_FOLDER_NAME }, (results) => {
            const folder = results.find(r => !r.url);

            if (folder) {
                chrome.bookmarks.move(folder.id, { parentId: targetParentId, index: targetIndex }, (movedFolder) => {
                    resolve(movedFolder.id);
                });
                return;
            }

            chrome.bookmarks.create({ parentId: targetParentId, index: targetIndex, title: ARCHIVE_FOLDER_NAME }, (newFolder) => {
                if (chrome.runtime.lastError || !newFolder) {
                    console.error("Archive creation error:", chrome.runtime.lastError);
                    chrome.bookmarks.create({ title: ARCHIVE_FOLDER_NAME }, (fallback) => resolve(fallback.id));
                } else {
                    resolve(newFolder.id);
                }
            });
        });
    });

    // 2. Ensure a sub-folder for today's date exists inside the main Archive
    return new Promise(resolve => {
        chrome.bookmarks.getChildren(mainArchiveId, (children) => {
            const dateFolder = children.find(c => !c.url && c.title === today);
            if (dateFolder) return resolve(dateFolder.id);

            chrome.bookmarks.create({ parentId: mainArchiveId, title: today }, (f) => resolve(f.id));
        });
    });
}

// ==========================================
// SYNC LOGIC: EXPORT (PUSH)
// ==========================================

async function pushBookmarksToServer(sendResponse = () => {}) {
    if (isSyncing) return;
    isSyncing = true;

    chrome.storage.local.get(['serverUrl', 'username', 'password', 'extensionId'], async (result) => {
        if (!result.serverUrl || !result.username || !result.password) {
            isSyncing = false;
            return sendResponse({ status: "error", message: "Missing credentials." });
        }

        const { serverUrl, username, password, extensionId } = result;
        const credentials = username + ':' + password;
        const authHeader = 'Basic ' + btoa(unescape(encodeURIComponent(credentials)));
        const baseUrl = serverUrl.endsWith('/') ? serverUrl : serverUrl + '/';
        const fileUrl = baseUrl + 'bookmarks_sync.json';

        try {
            const syncFolderId = await getOrCreateSyncFolder();
            if (!syncFolderId) throw new Error("Could not create Sync Folder.");

            const tree = await getBookmarksTreeAsync(syncFolderId);

            const response = await fetch(fileUrl, {
                method: 'PUT',
                credentials: 'omit',
                body: JSON.stringify(tree, null, 2),
                headers: {
                    'Authorization': authHeader,
                    'Content-Type': 'application/json'
                }
            });

            if (!response.ok) throw new Error(`HTTP Error: ${response.status}`);

            console.log("🚀 Export successful!");
            sendResponse({ status: "success", message: "Export successful!" });

        } catch (error) {
            console.error("PUSH Error:", error);
            sendResponse({ status: "error", message: "Export failed." });
        } finally {
            isSyncing = false;
        }
    });
}

// ==========================================
// SYNC LOGIC: IMPORT (PULL) & MERGE
// ==========================================

async function pullBookmarksFromServer(sendResponse = () => {}) {
    isSyncing = true;

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

            // EXACT POSITION DETECTION
            const syncFolderId = await getOrCreateSyncFolder();
            if (!syncFolderId) throw new Error("Could not find Sync Folder.");

            const syncFolderInfo = await new Promise(resolve => chrome.bookmarks.get(syncFolderId, resolve));

            const rootParentId = syncFolderInfo[0].parentId;
            const rootIndex = syncFolderInfo[0].index;

            let addedCount = 0;

            const getChildrenAsync = (parentId) => {
                return new Promise(resolve => chrome.bookmarks.getChildren(parentId, resolve));
            };

            // Recursive two-way merge algorithm
            async function syncNodes(remoteNodes, localParentId) {
                const localChildren = await getChildrenAsync(localParentId);
                const safeRemoteNodes = remoteNodes || [];

                for (const remoteNode of safeRemoteNodes) {
                    if (remoteNode.url) {
                        const existsLocally = localChildren.some(local => local.url === remoteNode.url);
                        if (!existsLocally) {
                            await new Promise(resolve => chrome.bookmarks.create({ parentId: localParentId, title: remoteNode.title, url: remoteNode.url }, resolve));
                            addedCount++;
                        }
                    } else {
                        let existingFolder = localChildren.find(local => !local.url && local.title === remoteNode.title);
                        let targetFolderId;

                        if (existingFolder) {
                            targetFolderId = existingFolder.id;
                        } else {
                            const newFolder = await new Promise(resolve => chrome.bookmarks.create({ parentId: localParentId, title: remoteNode.title }, resolve));
                            targetFolderId = newFolder.id;
                        }
                        await syncNodes(remoteNode.children || [], targetFolderId);
                    }
                }

                for (const localNode of localChildren) {
                    let existsOnServer = false;

                    if (localNode.url) {
                        existsOnServer = safeRemoteNodes.some(remote => remote.url === localNode.url);
                    } else {
                        existsOnServer = safeRemoteNodes.some(remote => !remote.url && remote.title === localNode.title);
                    }

                    if (!existsOnServer) {
                        const archiveFolderId = await getOrCreateArchiveFolder(rootParentId, rootIndex + 1);
                        await new Promise(resolve => {
                            chrome.bookmarks.move(localNode.id, { parentId: archiveFolderId }, resolve);
                        });
                        console.log(`🗑️ Archived missing item: ${localNode.title}`);
                    }
                }

                const freshLocalChildren = await getChildrenAsync(localParentId);

                for (let i = 0; i < safeRemoteNodes.length; i++) {
                    const remoteNode = safeRemoteNodes[i];

                    let targetLocalNode;
                    if (remoteNode.url) {
                        targetLocalNode = freshLocalChildren.find(local => local.url === remoteNode.url);
                    } else {
                        targetLocalNode = freshLocalChildren.find(local => !local.url && local.title === remoteNode.title);
                    }

                    if (targetLocalNode) {
                        await new Promise(resolve => {
                            chrome.bookmarks.move(targetLocalNode.id, { parentId: localParentId, index: i }, resolve);
                        });
                    }
                }
            }

            await syncNodes(remoteFolderData.children || [], syncFolderId);

            isSyncing = false;
            sendResponse({ status: "success", message: `${addedCount} items imported!` });

        } catch (error) {
            console.error("PULL Error:", error);
            isSyncing = false;
            sendResponse({ status: "error", message: "Import crashed." });
        } finally {
            setTimeout(async () => { await removeLock(baseUrl, authHeader, myLockFile); }, 2000);
        }
    });
}

// ==========================================
// ARCHIVE CLEANUP ROUTINE
// ==========================================

async function cleanOldArchives() {
    chrome.storage.local.get(['retentionDays'], (result) => {
        const retentionDays = result.retentionDays || 30;
        const thresholdDate = new Date();
        thresholdDate.setDate(thresholdDate.getDate() - retentionDays);

        chrome.bookmarks.search({ title: ARCHIVE_FOLDER_NAME }, (results) => {
            const mainArchive = results.find(r => !r.url);
            if (!mainArchive) return;

            chrome.bookmarks.getChildren(mainArchive.id, (dateFolders) => {
                for (const folder of dateFolders) {
                    const folderDate = new Date(folder.title);

                    if (!isNaN(folderDate) && folderDate < thresholdDate) {
                        chrome.bookmarks.removeTree(folder.id);
                        console.log(`♻️ Deleted old archive folder: ${folder.title}`);
                    }
                }
            });
        });
    });
}

// ==========================================
// AUTOMATIC TRIGGER & DEBOUNCING
// ==========================================

function scheduleAutomaticPush() {
    chrome.storage.local.get(['autoSyncEnabled'], (result) => {
        if (result.autoSyncEnabled === false) return;
        if (isSyncing) return;

        if (syncTimeout) clearTimeout(syncTimeout);

        syncTimeout = setTimeout(() => {
            pushBookmarksToServer();
        }, 5000);
    });
}

// ==========================================
// EVENT LISTENERS
// ==========================================

// Listen to messages from popup.js
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    // FIXED: Matched action names from popup.js
    if (request.action === "push_bookmarks") {
        pushBookmarksToServer(sendResponse);
        return true;
    } else if (request.action === "pull_bookmarks") {
        pullBookmarksFromServer(sendResponse);
        return true;
    } else if (request.action === "toggle_auto_sync") {
        if (request.enabled) {
            chrome.storage.local.get(['syncFrequency'], (res) => {
                const freq = parseInt(res.syncFrequency) || 15;
                chrome.alarms.create("autoPullAlarm", { periodInMinutes: freq });
            });
        } else {
            chrome.alarms.clear("autoPullAlarm");
        }
        sendResponse({ status: "success" });
    } else if (request.action === "update_alarm") {
        // FIXED: Added missing listener for syncFrequency changes
        chrome.alarms.clear("autoPullAlarm", () => {
            if (request.frequency) {
                chrome.alarms.create("autoPullAlarm", { periodInMinutes: request.frequency });
            }
        });
        sendResponse({ status: "success" });
    }
});

// Setup background alarms
chrome.runtime.onInstalled.addListener(() => {
    chrome.alarms.create("dailyCleanup", { periodInMinutes: 1440 });

    chrome.storage.local.get(['syncFrequency', 'autoSyncEnabled'], (result) => {
        if (result.autoSyncEnabled !== false) {
            const freq = parseInt(result.syncFrequency) || 15;
            chrome.alarms.create("autoPullAlarm", { periodInMinutes: freq });
        }
    });
});

// Listen to alarms
chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === "autoPullAlarm") {
        chrome.storage.local.get(['autoSyncEnabled'], (result) => {
            if (result.autoSyncEnabled !== false) {
                pullBookmarksFromServer();
            }
        });
    } else if (alarm.name === "dailyCleanup") {
        cleanOldArchives();
    }
});

// ==========================================
// EVENT LISTENERS (Cross-Browser Safe)
// ==========================================

if (chrome.bookmarks.onCreated) {
    chrome.bookmarks.onCreated.addListener(scheduleAutomaticPush);
}
if (chrome.bookmarks.onRemoved) {
    chrome.bookmarks.onRemoved.addListener(scheduleAutomaticPush);
}
if (chrome.bookmarks.onChanged) {
    chrome.bookmarks.onChanged.addListener(scheduleAutomaticPush);
}
if (chrome.bookmarks.onMoved) {
    chrome.bookmarks.onMoved.addListener(scheduleAutomaticPush);
}
if (chrome.bookmarks.onChildrenReordered) {
    chrome.bookmarks.onChildrenReordered.addListener(scheduleAutomaticPush);
}