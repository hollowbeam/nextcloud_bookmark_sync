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
const LOCK_FILE_NAME = "bookmarks_sync.lock";
const LOCK_STALE_MS = 5 * 60 * 1000; // Ignore locks older than this (crashed device safety net)

let isSyncing = false;
let syncTimeout = null;
let pendingLockRemoval = null;

// ==========================================
// WEBDAV / NEXTCLOUD HELPER FUNCTIONS
// ==========================================

// Best-effort lock: a single well-known file next to bookmarks_sync.json.
// Not a hard distributed mutex, but enough to stop two
// devices from syncing at once for a personal, infrequent-sync use case.
// The export's conditional PUT (If-Match) catches the remaining race.
async function getActiveLocks(baseUrl, authHeader) {
    const lockUrl = baseUrl + LOCK_FILE_NAME;

    try {
        const response = await fetch(lockUrl, {
            method: 'GET',
            credentials: 'omit',
            headers: { 'Authorization': authHeader }
        });

        if (response.status === 404) return [];
        // Nextcloud's own file locking: another device is writing right now
        if (response.status === 423) return ['nextcloud-file-lock'];
        if (!response.ok) return null;

        const lock = await response.json();
        if (!lock || typeof lock.owner !== 'string' || !lock.owner || !lock.timestamp) return [];
        if (Date.now() - lock.timestamp > LOCK_STALE_MS) return []; // Stale, ignore it

        return [lock.owner];
    } catch (error) {
        console.error("Lock check failed:", error);
        return null;
    }
}

async function createLock(baseUrl, authHeader, extensionId) {
    const lockUrl = baseUrl + LOCK_FILE_NAME;
    const payload = JSON.stringify({ owner: extensionId, timestamp: Date.now() });

    try {
        const response = await fetch(lockUrl, {
            method: 'PUT',
            credentials: 'omit',
            body: payload,
            headers: {
                'Authorization': authHeader,
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) return null;
        return LOCK_FILE_NAME;
    } catch (error) {
        console.error("Lock creation failed:", error);
        return null;
    }
}

async function removeLock(baseUrl, authHeader, lockFile) {
    if (!lockFile) return;
    const lockUrl = baseUrl + lockFile;

    // Nextcloud answers 423 while another device is reading the file: retry, or the
    // lock would block every other device until it goes stale (5 minutes)
    for (let attempt = 0; attempt < 5; attempt++) {
        try {
            const response = await fetch(lockUrl, {
                method: 'DELETE',
                credentials: 'omit',
                headers: { 'Authorization': authHeader }
            });
            if (response.status !== 423) return;
        } catch (error) {
            console.error("Lock removal failed:", error);
            return;
        }
        await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
    }
    console.error("Lock removal failed: file still locked by the server.");
}

// Checks for another device's lock, then takes ours.
// Returns { lockFile } on success, or { status, message } when the sync must not proceed.
async function acquireLock(baseUrl, authHeader, extensionId) {
    const activeLocks = await getActiveLocks(baseUrl, authHeader);
    if (activeLocks === null) return { status: "error", message: "Server error." };

    const otherLocks = activeLocks.filter(lock => !lock.startsWith(extensionId));
    if (otherLocks.length > 0) return { status: "locked", message: "Another device is syncing." };

    const lockFile = await createLock(baseUrl, authHeader, extensionId);
    if (!lockFile) return { status: "error", message: "Lock failed." };

    // The lock we just wrote replaces the previous pull's: its delayed removal would delete ours
    if (pendingLockRemoval) {
        clearTimeout(pendingLockRemoval);
        pendingLockRemoval = null;
    }

    return { lockFile };
}

function toBase64Utf8(str) {
    const bytes = new TextEncoder().encode(str);
    let binary = '';
    bytes.forEach(b => binary += String.fromCharCode(b));
    return btoa(binary);
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
// THREE-WAY MERGE
// ==========================================
// The "base" is the folder content as of this device's last successful sync with
// the server (stored locally). Comparing local and remote against it tells an
// addition on one side apart from a deletion on the other, so concurrent changes
// from two devices are combined instead of the last export replacing the other's.

const SYNC_BASE_KEY = 'syncBase';

// Keeps only what is synced: titles, URLs and structure (no ids or dates).
// Tolerates a hand-edited file: entries that aren't objects are dropped.
function normalizeNode(node) {
    if (!node || typeof node !== 'object') return null;
    const title = typeof node.title === 'string' ? node.title : '';
    if (typeof node.url === 'string' && node.url) return { title, url: node.url };
    const children = Array.isArray(node.children) ? node.children.map(normalizeNode).filter(Boolean) : [];
    return { title, children };
}

function sameTree(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
}

// Identity of a node among its siblings: its URL (bookmark) or title (folder),
// plus an occurrence number so duplicates each get their own key
function nodeKeys(nodes) {
    const seen = new Map();
    return nodes.map(node => {
        const id = node.url ? 'u:' + node.url : 'f:' + node.title;
        const count = seen.get(id) || 0;
        seen.set(id, count + 1);
        return id + '#' + count;
    });
}

function mergeChildren(baseNodes, localNodes, remoteNodes) {
    const index = (nodes) => {
        const keys = nodeKeys(nodes);
        return { keys, byKey: new Map(keys.map((key, i) => [key, nodes[i]])) };
    };
    const base = index(baseNodes || []);
    const local = index(localNodes || []);
    const remote = index(remoteNodes || []);

    const mergeNode = (key) => {
        const b = base.byKey.get(key);
        const l = local.byKey.get(key);
        const r = remote.byKey.get(key);

        if (l && r) {
            if (l.url) return { title: b && l.title === b.title ? r.title : l.title, url: l.url };
            return { title: l.title, children: mergeChildren(b && b.children, l.children, r.children) };
        }
        if (!b) return l || r; // Added on one side only

        // Deleted on one side. A folder survives only with what the other side added to it.
        const kept = l || r;
        if (!kept || kept.url || b.url) return null;
        const children = mergeChildren(b.children, l ? l.children : [], r ? r.children : []);
        return children.length > 0 ? { title: kept.title, children } : null;
    };

    // Order: the remote one, unless only the local side reordered since the base.
    // The other side's additions then go before their next sibling on that side
    // (at the end when they have none).
    const inAll = (key) => base.byKey.has(key) && local.byKey.has(key) && remote.byKey.has(key);
    const remoteReordered = !baseNodes || !sameTree(remote.keys.filter(inAll), base.keys.filter(inAll));
    const [primary, secondary] = remoteReordered ? [remote, local] : [local, remote];

    const merged = [];
    const placed = new Map();
    for (const key of primary.keys) {
        const node = mergeNode(key);
        if (node) {
            merged.push(node);
            placed.set(key, node);
        }
    }

    let insertAt = merged.length;
    for (const key of [...secondary.keys].reverse()) {
        if (placed.has(key)) {
            insertAt = merged.indexOf(placed.get(key));
        } else if (!primary.byKey.has(key)) {
            const node = mergeNode(key);
            if (node) {
                merged.splice(insertAt, 0, node);
                placed.set(key, node);
            }
        }
    }

    return merged;
}

// Entries this browser refused to create stay out of the base: they then keep reading
// as remote additions (retried, kept on the server) rather than as local deletions
function withoutSkipped(nodes, skipped) {
    if (!skipped || skipped.size === 0) return nodes;
    return nodes
        .filter(node => !skipped.has(node))
        .map(node => node.url ? node : { title: node.title, children: withoutSkipped(node.children, skipped) });
}

// The base is tied to the remote file: after a server change it would wrongly read as deletions
function loadSyncBase(fileUrl) {
    return new Promise(resolve => chrome.storage.local.get([SYNC_BASE_KEY], (result) => {
        const saved = result[SYNC_BASE_KEY];
        resolve(saved && saved.fileUrl === fileUrl ? saved.children : null);
    }));
}

function saveSyncBase(fileUrl, children) {
    return new Promise(resolve => chrome.storage.local.set({ [SYNC_BASE_KEY]: { fileUrl, children } }, resolve));
}

// Compression proxies rewrite the ETag of the response they compress (nginx makes
// it weak: W/"x"; Apache appends -gzip or -br), while the server compares If-Match
// with the original one. Restores the original.
function originalEtag(etag) {
    if (!etag) return null;
    return etag.replace(/^W\//, '').replace(/-(gzip|br)"$/, '"');
}

// Returns { exists, tree, etag }. tree is null when the file is missing, or when
// it isn't a bookmark tree (e.g. a broken hand edit): an export then replaces it.
async function fetchRemoteTree(fileUrl, authHeader) {
    const response = await fetch(fileUrl, {
        method: 'GET',
        credentials: 'omit',
        cache: 'no-store',
        headers: { 'Authorization': authHeader }
    });

    if (response.status === 404) return { exists: false, tree: null, etag: null };
    if (!response.ok) throw new Error(`HTTP Error: ${response.status}`);

    const etag = originalEtag(response.headers ? response.headers.get('ETag') : null);
    let data = null;
    try {
        data = await response.json();
    } catch (error) {
        console.warn("Remote file is not valid JSON:", error);
    }
    const valid = data && typeof data === 'object' && Array.isArray(data.children);
    return { exists: true, tree: valid ? normalizeNode(data) : null, etag };
}

// Makes the local sync folder match targetNodes: creates what is missing, updates
// titles, archives what is no longer there, then reorders.
async function applyTreeToLocal(syncFolderId, targetNodes) {
    const syncFolderInfo = await new Promise(resolve => chrome.bookmarks.get(syncFolderId, resolve));
    const rootParentId = syncFolderInfo[0].parentId;
    const rootIndex = syncFolderInfo[0].index;

    let addedCount = 0;
    let renamedCount = 0;
    const skipped = new Set(); // Target nodes the browser refused to create

    const getChildrenAsync = (parentId) => {
        return new Promise(resolve => chrome.bookmarks.getChildren(parentId, resolve));
    };

    // The browser refuses entries that aren't valid URLs (e.g. a hand-edited JSON).
    // Resolves to null in that case so one bad entry doesn't abort the whole import.
    const createNodeAsync = (details, targetNode) => {
        return new Promise(resolve => chrome.bookmarks.create(details, (node) => {
            if (chrome.runtime.lastError || !node) {
                console.warn(`Skipped "${details.title}":`, chrome.runtime.lastError);
                skipped.add(targetNode);
                return resolve(null);
            }
            resolve(node);
        }));
    };

    // Matching uses a "claimed" set rather than plain find()/some() so that
    // duplicate URLs/titles at the same level each match a distinct node
    // instead of every remote entry collapsing onto the first local match.
    async function syncNodes(remoteNodes, localParentId) {
        const localChildren = await getChildrenAsync(localParentId);
        const safeRemoteNodes = remoteNodes || [];
        const claimedIds = new Set();
        const matches = (local, remote) => remote.url ? local.url === remote.url : (!local.url && local.title === remote.title);

        for (const remoteNode of safeRemoteNodes) {
            const localMatch = localChildren.find(local => !claimedIds.has(local.id) && matches(local, remoteNode));

            if (remoteNode.url) {
                if (localMatch) {
                    claimedIds.add(localMatch.id);
                    if (localMatch.title !== remoteNode.title) {
                        await new Promise(resolve => chrome.bookmarks.update(localMatch.id, { title: remoteNode.title }, resolve));
                        renamedCount++;
                    }
                } else {
                    const created = await createNodeAsync({ parentId: localParentId, title: remoteNode.title, url: remoteNode.url }, remoteNode);
                    if (created) {
                        claimedIds.add(created.id);
                        addedCount++;
                    }
                }
            } else {
                let targetFolderId;
                if (localMatch) {
                    targetFolderId = localMatch.id;
                    claimedIds.add(localMatch.id);
                } else {
                    const newFolder = await createNodeAsync({ parentId: localParentId, title: remoteNode.title }, remoteNode);
                    if (!newFolder) continue;
                    targetFolderId = newFolder.id;
                    claimedIds.add(targetFolderId);
                }
                await syncNodes(remoteNode.children || [], targetFolderId);
            }
        }

        const toArchive = localChildren.filter(local => !claimedIds.has(local.id));
        if (toArchive.length > 0) {
            const archiveFolderId = await getOrCreateArchiveFolder(rootParentId, rootIndex + 1);
            for (const localNode of toArchive) {
                await new Promise(resolve => {
                    chrome.bookmarks.move(localNode.id, { parentId: archiveFolderId }, resolve);
                });
                console.log(`🗑️ Archived missing item: ${localNode.title}`);
            }
        }

        const freshLocalChildren = await getChildrenAsync(localParentId);
        const usedForOrder = new Set();
        let position = 0; // Not the remote index: skipped nodes must not leave gaps

        for (const remoteNode of safeRemoteNodes) {
            const targetLocalNode = freshLocalChildren.find(local => !usedForOrder.has(local.id) && matches(local, remoteNode));

            if (targetLocalNode) {
                usedForOrder.add(targetLocalNode.id);
                const index = position++;
                await new Promise(resolve => {
                    chrome.bookmarks.move(targetLocalNode.id, { parentId: localParentId, index }, resolve);
                });
            }
        }
    }

    await syncNodes(targetNodes, syncFolderId);
    return { addedCount, renamedCount, skippedCount: skipped.size, skipped };
}

// ==========================================
// SYNC LOGIC: EXPORT (PUSH)
// ==========================================

async function pushBookmarksToServer(sendResponse = () => {}) {
    if (isSyncing) return sendResponse({ status: "locked", message: "Sync already in progress." });
    isSyncing = true;

    chrome.storage.local.get(['serverUrl', 'username', 'password', 'extensionId'], async (result) => {
        if (!result.serverUrl || !result.username || !result.password || !result.extensionId) {
            isSyncing = false;
            return sendResponse({ status: "error", message: "Missing credentials." });
        }

        const { serverUrl, username, password, extensionId } = result;
        const credentials = username + ':' + password;
        const authHeader = 'Basic ' + toBase64Utf8(credentials);
        const baseUrl = serverUrl.endsWith('/') ? serverUrl : serverUrl + '/';
        const fileUrl = baseUrl + 'bookmarks_sync.json';

        let myLockFile = null;

        try {
            const lock = await acquireLock(baseUrl, authHeader, extensionId);
            if (!lock.lockFile) return sendResponse({ status: lock.status, message: lock.message });
            myLockFile = lock.lockFile;

            const syncFolderId = await getOrCreateSyncFolder();
            if (!syncFolderId) throw new Error("Could not create Sync Folder.");

            const local = normalizeNode(await getBookmarksTreeAsync(syncFolderId));
            const remote = await fetchRemoteTree(fileUrl, authHeader);
            const savedBase = await loadSyncBase(fileUrl);

            // Another device exported since our last sync: merge its changes instead
            // of overwriting them. Without a base the server wins, as on import.
            let uploadChildren = local.children;
            let skipped = null;
            const remoteChanged = remote.tree && !(savedBase && sameTree(remote.tree.children, savedBase));
            if (remoteChanged) {
                uploadChildren = mergeChildren(savedBase || local.children, local.children, remote.tree.children);
                if (!sameTree(uploadChildren, local.children)) {
                    ({ skipped } = await applyTreeToLocal(syncFolderId, uploadChildren));
                }
                // The merge is applied locally: if the upload fails, the remote we read
                // is the base, so its items aren't mistaken for local additions next time
                await saveSyncBase(fileUrl, withoutSkipped(remote.tree.children, skipped));
            }

            const putFile = (conditionHeader) => fetch(fileUrl, {
                method: 'PUT',
                credentials: 'omit',
                body: JSON.stringify({ title: local.title, children: uploadChildren }, null, 2),
                headers: {
                    'Authorization': authHeader,
                    'Content-Type': 'application/json',
                    ...conditionHeader
                }
            });

            // Fails with 412 if the file changed since we read it
            let response = await putFile(remote.exists
                ? (remote.etag ? { 'If-Match': remote.etag } : {})
                : { 'If-None-Match': '*' });

            // Unchanged ETag: the server just can't match it (rewritten some other way
            // by a proxy), it isn't a concurrent write. Fall back to the lock alone.
            if (response.status === 412 && remote.etag) {
                const recheck = await fetchRemoteTree(fileUrl, authHeader);
                if (recheck.etag === remote.etag) {
                    console.warn("If-Match not supported for this ETag, uploading without it.");
                    response = await putFile({});
                }
            }

            if (response.status === 412) {
                return sendResponse({ status: "locked", message: "Remote file changed, try again." });
            }
            if (!response.ok) throw new Error(`HTTP Error: ${response.status}`);

            await saveSyncBase(fileUrl, withoutSkipped(uploadChildren, skipped));

            console.log("🚀 Export successful!");
            const mergedNote = remoteChanged ? " (merged with remote changes)" : "";
            sendResponse({ status: "success", message: `Export successful!${mergedNote}` });

        } catch (error) {
            console.error("PUSH Error:", error);
            sendResponse({ status: "error", message: "Export failed." });
        } finally {
            await removeLock(baseUrl, authHeader, myLockFile);
            isSyncing = false;
        }
    });
}

// ==========================================
// SYNC LOGIC: IMPORT (PULL) & MERGE
// ==========================================

async function pullBookmarksFromServer(sendResponse = () => {}) {
    if (isSyncing) return sendResponse({ status: "locked", message: "Sync already in progress." });
    isSyncing = true;

    chrome.storage.local.get(['serverUrl', 'username', 'password', 'extensionId'], async (result) => {
        if (!result.serverUrl || !result.username || !result.password || !result.extensionId) {
            isSyncing = false;
            return sendResponse({ status: "error", message: "Missing credentials." });
        }

        const { serverUrl, username, password, extensionId } = result;
        const credentials = username + ':' + password;
        const authHeader = 'Basic ' + toBase64Utf8(credentials);
        const baseUrl = serverUrl.endsWith('/') ? serverUrl : serverUrl + '/';
        const fileUrl = baseUrl + 'bookmarks_sync.json';

        const lock = await acquireLock(baseUrl, authHeader, extensionId);
        if (!lock.lockFile) {
            isSyncing = false;
            return sendResponse({ status: lock.status, message: lock.message });
        }
        const myLockFile = lock.lockFile;

        try {
            const remote = await fetchRemoteTree(fileUrl, authHeader);

            if (!remote.tree) {
                isSyncing = false;
                const message = remote.exists ? "Invalid remote file. Export to replace it." : "No file found.";
                return sendResponse({ status: "error", message });
            }

            const syncFolderId = await getOrCreateSyncFolder();
            if (!syncFolderId) throw new Error("Could not find Sync Folder.");

            // Local changes not exported yet are kept, not archived: only what was
            // deleted on the other side since our last sync goes to the archive
            const local = normalizeNode(await getBookmarksTreeAsync(syncFolderId));
            // Without a base (first import, or a new server) the server wins, as before:
            // a union would bring back what other devices deleted
            const base = (await loadSyncBase(fileUrl)) || local.children;
            const target = mergeChildren(base, local.children, remote.tree.children);

            const { addedCount, renamedCount, skippedCount, skipped } = await applyTreeToLocal(syncFolderId, target);
            await saveSyncBase(fileUrl, withoutSkipped(remote.tree.children, skipped));

            isSyncing = false;
            const notes = [];
            if (renamedCount > 0) notes.push(`${renamedCount} renamed`);
            if (skippedCount > 0) notes.push(`${skippedCount} skipped`);
            const notesText = notes.length > 0 ? ` (${notes.join(', ')})` : '';
            const itemWord = addedCount === 1 ? "item" : "items";
            sendResponse({ status: "success", message: `${addedCount} ${itemWord} imported!${notesText}` });

            // Kept local changes still have to reach the server
            if (!sameTree(target, remote.tree.children)) scheduleAutomaticPush();

        } catch (error) {
            console.error("PULL Error:", error);
            isSyncing = false;
            sendResponse({ status: "error", message: "Import crashed." });
        } finally {
            pendingLockRemoval = setTimeout(async () => {
                pendingLockRemoval = null;
                await removeLock(baseUrl, authHeader, myLockFile);
            }, 2000);
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

function armAutomaticPush() {
    if (syncTimeout) clearTimeout(syncTimeout);

    syncTimeout = setTimeout(async () => {
        syncTimeout = null;
        // Auto-sync may have been turned off since this export was scheduled
        const { autoSyncEnabled } = await new Promise(resolve => chrome.storage.local.get(['autoSyncEnabled'], resolve));
        if (autoSyncEnabled === false) return;

        // A held lock (local sync or another device) must delay this export, not drop it
        pushBookmarksToServer((response) => {
            if (response.status !== "locked") return;

            chrome.storage.local.get(['autoSyncEnabled'], (result) => {
                if (result.autoSyncEnabled !== false) armAutomaticPush();
            });
        });
    }, 5000);
}

function scheduleAutomaticPush() {
    chrome.storage.local.get(['autoSyncEnabled'], (result) => {
        if (result.autoSyncEnabled === false) return;
        if (isSyncing) return; // Ignores the bookmark events caused by an import

        armAutomaticPush();
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
            // Cancels an export already scheduled by a recent bookmark change
            if (syncTimeout) {
                clearTimeout(syncTimeout);
                syncTimeout = null;
            }
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
// Updating from a version without a sync base: the folder as it is now (in sync,
// barring changes from the last few seconds) becomes the base, so deletions made
// right after the update aren't undone by the next merge
async function seedSyncBaseAfterUpdate() {
    const { serverUrl } = await new Promise(resolve => chrome.storage.local.get(['serverUrl'], resolve));
    if (!serverUrl) return;
    const baseUrl = serverUrl.endsWith('/') ? serverUrl : serverUrl + '/';
    const fileUrl = baseUrl + 'bookmarks_sync.json';
    if (await loadSyncBase(fileUrl)) return;

    const folder = await new Promise(resolve => chrome.bookmarks.search({ title: SYNC_FOLDER_NAME }, (results) => {
        resolve(results.find(r => !r.url));
    }));
    if (!folder) return;

    const local = normalizeNode(await getBookmarksTreeAsync(folder.id));
    await saveSyncBase(fileUrl, local.children);
}

chrome.runtime.onInstalled.addListener((details) => {
    chrome.alarms.create("dailyCleanup", { periodInMinutes: 1440 });

    if (details && details.reason === 'update') seedSyncBaseAfterUpdate();

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