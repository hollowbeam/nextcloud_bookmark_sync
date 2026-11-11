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

const PENDING_EXPORT_ALARM = "pendingExport";

let isSyncing = false;
let syncTimeout = null;
let changedDuringSync = false; // A change in the sync folder while a sync ran

// ==========================================
// MESSAGES
// ==========================================
// Shown in the popup, in the browser's language (_locales/): they must say what to
// fix, not just that something failed.

function t(key, ...substitutions) {
    const text = chrome.i18n && chrome.i18n.getMessage(key, substitutions.map(String));
    return text || key;
}

const SETUP_HINT_URL = "https://<server>/remote.php/dav/files/<user>/<folder>/";
const NETWORK_ERROR_MESSAGE = t('errUnreachable');
const BUSY_MESSAGE = t('busy');
const NO_ACCESS_MESSAGE = t('errNoAccess');

function describeHttpStatus(status) {
    if (status === 401) return t('errWrongPassword');
    if (status === 403) return t('errAccessDenied');
    // 404 on the folder, 409 when writing into a folder that doesn't exist
    if (status === 404 || status === 409) return t('errFolderNotFound');
    if (status === 405 || status === 501) return t('errNotWebDav', SETUP_HINT_URL);
    if (status === 507) return t('errStorageFull');
    // Nextcloud's brute-force protection, after several wrong passwords
    if (status === 429) return t('errTooManyLogins');
    if (status >= 500) return t('errServer', status);
    return t('errUnexpected', status);
}

// What a sync changed, e.g. "2 added, 1 archived · changes sent", or "Up to date."
function syncSummary(counts, sent) {
    const parts = [];
    if (counts.added > 0) parts.push(t('countAdded', counts.added));
    if (counts.archived > 0) parts.push(t('countArchived', counts.archived));
    if (counts.renamed > 0) parts.push(t('countRenamed', counts.renamed));
    if (counts.skipped > 0) parts.push(t('countSkipped', counts.skipped));
    if (parts.length === 0) return sent ? t('changesSentOnly') : t('upToDate');
    const text = parts.join(', ');
    const local = text.charAt(0).toUpperCase() + text.slice(1);
    return sent ? `${local} · ${t('changesSent')}` : `${local}.`;
}

const NO_CHANGES = { added: 0, archived: 0, renamed: 0, skipped: 0 };

// An error whose message can be shown as is. locked: transient, the sync is retried.
class SyncError extends Error {
    constructor(userMessage, { locked = false } = {}) {
        super(userMessage);
        this.userMessage = userMessage;
        this.locked = locked;
    }
}

function userMessageFor(error, fallback) {
    return error && error.userMessage ? error.userMessage : fallback;
}

// The response for a failed sync: "locked" ones are retried, not reported
function failureResponse(error, fallback) {
    if (error && error.locked) return { status: "locked", message: error.userMessage };
    return { status: "error", message: userMessageFor(error, fallback) };
}

// fetch() rejects on network, DNS or certificate failures, and in Chrome when the
// host permission is missing; only these rejections mean "unreachable"
async function davFetch(url, options) {
    try {
        return await fetch(url, options);
    } catch (error) {
        console.error("Request failed:", error);
        throw new SyncError(NETWORK_ERROR_MESSAGE);
    }
}

// The host permission is granted from the popup (it needs a click). Background
// syncs can't ask for it, so they say so instead of failing as "unreachable".
async function hasServerAccess(serverUrl) {
    if (!chrome.permissions || !chrome.permissions.contains) return true;
    let hostname;
    try {
        hostname = new URL(serverUrl).hostname;
    } catch {
        return true; // Reported by the request itself
    }
    return new Promise(resolve => chrome.permissions.contains({ origins: [`https://${hostname}/*`] }, resolve));
}

// Before any sync with the current settings (none recorded: first setup, or settings
// just changed), no access is normal: the user hasn't clicked Test connection or Sync
// now yet. Not flagged on the icon then; afterwards (e.g. access revoked), it is.
function noAccessResponse(lastSync) {
    return { status: "error", message: NO_ACCESS_MESSAGE, quiet: !lastSync };
}

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
        if (!response.ok) return { error: describeHttpStatus(response.status) };

        // An unreadable lock file (empty, hand-edited) is ignored: otherwise it would
        // block every device for good, since it never reaches the staleness check
        let lock = null;
        try {
            lock = await response.json();
        } catch (error) {
            console.warn("Ignoring unreadable lock file:", error);
            return [];
        }
        if (!lock || typeof lock.owner !== 'string' || !lock.owner || !lock.timestamp) return [];
        if (Date.now() - lock.timestamp > LOCK_STALE_MS) return []; // Stale, ignore it

        return [lock.owner];
    } catch (error) {
        console.error("Lock check failed:", error);
        return { error: NETWORK_ERROR_MESSAGE };
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

        // Nextcloud's own file locking: busy right now, worth retrying
        if (response.status === 423) return { busy: true };
        if (!response.ok) return { error: describeHttpStatus(response.status) };
        return { lockFile: LOCK_FILE_NAME };
    } catch (error) {
        console.error("Lock creation failed:", error);
        return { error: NETWORK_ERROR_MESSAGE };
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
                headers: { 'Authorization': authHeader },
                signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(15000) : undefined
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
    if (activeLocks.error) return { status: "error", message: activeLocks.error };

    const otherLocks = activeLocks.filter(lock => !lock.startsWith(extensionId));
    if (otherLocks.length > 0) return { status: "locked", message: BUSY_MESSAGE };

    const created = await createLock(baseUrl, authHeader, extensionId);
    if (created.busy) return { status: "locked", message: BUSY_MESSAGE };
    if (created.error) return { status: "error", message: created.error };
    return { lockFile: created.lockFile };
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
            void chrome.runtime.lastError; // Removed meanwhile: callers fail (inside their try)
            resolve(results && results[0]);
        });
    });
}

// ==========================================
// FOLDER MANAGEMENT (SYNC & ARCHIVE)
// ==========================================

// Several folders can carry the name, e.g. when the browser's own sync (Chrome Sync,
// Firefox Sync) merges a folder recreated on two devices. The oldest one is always the
// synced folder, so the choice doesn't change from one sync to the next. The number of
// extra folders, and which one is synced, are recorded for the popup to tell the user:
// browsers don't show when a folder was created, so "the oldest" alone can't be found.
function pickSyncFolder(results) {
    const folders = (results || []).filter(r => !r.url && r.title === SYNC_FOLDER_NAME);
    folders.sort((a, b) => ((a.dateAdded || 0) - (b.dateAdded || 0)) || String(a.id).localeCompare(String(b.id)));
    const extra = Math.max(folders.length - 1, 0);
    const syncedId = extra > 0 ? folders[0].id : null;
    // Bookmark events then follow the folder actually synced, even if it changed
    cachedSyncFolderId = folders[0] ? folders[0].id : null;
    chrome.storage.local.get(['duplicateSyncFolders', 'syncedFolderId'], (stored) => {
        if ((stored.duplicateSyncFolders || 0) !== extra || (stored.syncedFolderId || null) !== syncedId) {
            chrome.storage.local.set({ duplicateSyncFolders: extra, syncedFolderId: syncedId });
        }
    });
    return folders[0] || null;
}

// Get or Create the main Sync Folder (Cross-browser safe)
// Returns { id, created }. created: the folder didn't exist (first use, or the user
// deleted or renamed it). Its emptiness then says nothing about what to delete.
async function getOrCreateSyncFolder() {
    return new Promise((resolve) => {
        chrome.bookmarks.search({ title: SYNC_FOLDER_NAME }, (results) => {
            const folder = pickSyncFolder(results);
            if (folder) return resolve({ id: folder.id, created: false });

            // In the bookmarks bar: its id is '1' in Chrome, Brave and Edge, and
            // 'toolbar_____' in Firefox. Without a parent, the browser picks one
            // (Firefox: Other Bookmarks), as a last resort.
            const parents = ['1', 'toolbar_____', undefined];
            const tryCreate = (index) => {
                const parentId = parents[index];
                const details = parentId ? { parentId, title: SYNC_FOLDER_NAME } : { title: SYNC_FOLDER_NAME };
                chrome.bookmarks.create(details, (newFolder) => {
                    if (chrome.runtime.lastError || !newFolder) {
                        if (index + 1 < parents.length) return tryCreate(index + 1);
                        return resolve({ id: null, created: true });
                    }
                    // The old base described the folder that is gone. Dropped right away, so
                    // that a sync failing after this point still restores the folder next time
                    // instead of reading it as "everything deleted" (the created flag would be lost)
                    chrome.storage.local.remove(SYNC_BASE_KEY, () => resolve({ id: newFolder.id, created: true }));
                });
            };
            tryCreate(0);
        });
    });
}

// The date folder of today's archive, inside the archive folder. The archive folder
// is created next to the sync folder; once it exists it stays where the user put it.
async function getOrCreateArchiveFolder(targetParentId, targetIndex) {
    const today = new Date().toISOString().split('T')[0]; // Format: YYYY-MM-DD

    // 1. The main archive folder: found anywhere, or created next to the sync folder
    const mainArchiveId = await new Promise((resolve) => {
        chrome.bookmarks.search({ title: ARCHIVE_FOLDER_NAME }, (results) => {
            const folder = results.find(r => !r.url);
            if (folder) return resolve(folder.id);

            chrome.bookmarks.create({ parentId: targetParentId, index: targetIndex, title: ARCHIVE_FOLDER_NAME }, (newFolder) => {
                if (chrome.runtime.lastError || !newFolder) {
                    console.warn("Archive folder created in the browser's default place:", chrome.runtime.lastError);
                    chrome.bookmarks.create({ title: ARCHIVE_FOLDER_NAME }, (fallback) => {
                        void chrome.runtime.lastError;
                        resolve(fallback ? fallback.id : null);
                    });
                } else {
                    resolve(newFolder.id);
                }
            });
        });
    });

    // 2. Ensure a sub-folder for today's date exists inside the main Archive.
    // null if the archive folder is gone meanwhile (e.g. removed by the browser's own sync)
    if (!mainArchiveId) return null;
    return new Promise(resolve => {
        chrome.bookmarks.getChildren(mainArchiveId, (children) => {
            void chrome.runtime.lastError;
            if (!children) return resolve(null);
            const dateFolder = children.find(c => !c.url && c.title === today);
            if (dateFolder) return resolve(dateFolder.id);

            chrome.bookmarks.create({ parentId: mainArchiveId, title: today }, (f) => {
                void chrome.runtime.lastError; // Archive folder gone meanwhile: the caller retries
                resolve(f ? f.id : null);
            });
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

function isArchiveFolder(node) {
    return !node.url && node.title === ARCHIVE_FOLDER_NAME;
}

function withoutArchiveFolder(nodes) {
    return nodes.filter(node => !isArchiveFolder(node));
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

// The base is tied to the remote file and to the local folder: after a server change,
// or when another folder becomes the synced one (e.g. an older duplicate brought by
// the browser's own sync), comparing with it would read differences as deletions.
// A base without a folder id (written by 1.7.0 or older) is accepted.
function loadSyncBase(fileUrl, folderId) {
    return new Promise(resolve => chrome.storage.local.get([SYNC_BASE_KEY], (result) => {
        const saved = result[SYNC_BASE_KEY];
        if (!saved || saved.fileUrl !== fileUrl) return resolve(null);
        if (saved.folderId && folderId && saved.folderId !== folderId) return resolve(null);
        resolve(saved.children);
    }));
}

function saveSyncBase(fileUrl, children, folderId) {
    return new Promise(resolve => chrome.storage.local.set({ [SYNC_BASE_KEY]: { fileUrl, folderId, children } }, resolve));
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
    const response = await davFetch(fileUrl, {
        method: 'GET',
        credentials: 'omit',
        cache: 'no-store',
        headers: { 'Authorization': authHeader }
    });

    if (response.status === 404) return { exists: false, tree: null, etag: null };
    // Nextcloud's own file locking: another device is reading or writing it
    if (response.status === 423) throw new SyncError(BUSY_MESSAGE, { locked: true });
    if (!response.ok) throw new SyncError(describeHttpStatus(response.status));

    const etag = originalEtag(response.headers ? response.headers.get('ETag') : null);
    let data = null;
    try {
        data = await response.json();
    } catch (error) {
        console.warn("Remote file is not valid JSON:", error);
    }
    const valid = data && typeof data === 'object' && Array.isArray(data.children);
    // 1.6.0 and later write only titles, URLs and children; older versions upload the
    // browser's raw tree, with ids and dates
    const legacy = Boolean(valid && ('id' in data || 'dateAdded' in data));
    const tree = valid ? normalizeNode(data) : null;
    if (tree) tree.children = withoutArchiveFolder(tree.children);
    return { exists: true, tree, etag, legacy };
}

// Remembers when a file from an old-version device was last seen: such a device
// overwrites without merging, so the popup asks to update it. Only after a file in
// the new format was seen: before that, the old file may be this device's own,
// written before it was updated (it is rewritten in the new format right away).
function noteRemoteFormat(remote) {
    if (!remote.tree) return;
    if (!remote.legacy) {
        chrome.storage.local.set({ newFormatSeen: true });
        return;
    }
    chrome.storage.local.get(['newFormatSeen'], (result) => {
        if (result.newFormatSeen) chrome.storage.local.set({ legacySeenAt: Date.now() });
    });
}

// Makes the local sync folder match targetNodes: creates what is missing, updates
// titles, archives what is no longer there, then reorders.
// Ids of every node of a raw bookmark tree
function collectIds(node, ids = new Set()) {
    ids.add(node.id);
    (node.children || []).forEach(child => collectIds(child, ids));
    return ids;
}

// knownIds: the nodes the merge was computed from. A bookmark the user adds while
// the sync runs isn't in the target, but it isn't a deletion either: it is left in
// place (and sent by the sync that follows), never archived.
async function applyTreeToLocal(syncFolderId, targetNodes, knownIds = null) {
    const syncFolderInfo = await new Promise(resolve => chrome.bookmarks.get(syncFolderId, resolve));
    const rootParentId = syncFolderInfo[0].parentId;
    const rootIndex = syncFolderInfo[0].index;

    let addedCount = 0;
    let renamedCount = 0;
    let archivedCount = 0;
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
        const localChildren = (await getChildrenAsync(localParentId)).filter(node => !isArchiveFolder(node));
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

        const toArchive = localChildren.filter(local => !claimedIds.has(local.id) && (!knownIds || knownIds.has(local.id)));
        if (toArchive.length > 0) {
            // A second try creates the archive folder again if it vanished meanwhile.
            // Failing then (base not saved) replays the whole sync next time.
            const archiveFolderId = await getOrCreateArchiveFolder(rootParentId, rootIndex + 1)
                || await getOrCreateArchiveFolder(rootParentId, rootIndex + 1);
            if (!archiveFolderId) throw new Error("Archive folder unavailable");
            for (const localNode of toArchive) {
                // A failed move must not count as archived, nor let the base be saved
                await new Promise((resolve, reject) => {
                    chrome.bookmarks.move(localNode.id, { parentId: archiveFolderId }, (moved) => {
                        if (chrome.runtime.lastError || !moved) return reject(new Error("Archiving failed"));
                        resolve();
                    });
                });
                archivedCount++;
                console.log(`🗑️ Archived missing item: ${localNode.title}`);
            }
        }

        const freshLocalChildren = (await getChildrenAsync(localParentId)).filter(node => !isArchiveFolder(node));
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
    return {
        counts: { added: addedCount, archived: archivedCount, renamed: renamedCount, skipped: skipped.size },
        skipped,
    };
}

// ==========================================
// SYNC LOGIC: EXPORT (PUSH)
// ==========================================

async function pushBookmarksToServer(sendResponse = () => {}) {
    sendResponse = recordingResponse("sync", sendResponse);
    if (isSyncing) return sendResponse({ status: "locked", message: t('syncInProgress') });
    isSyncing = true;

    chrome.storage.local.get(['serverUrl', 'username', 'password', 'extensionId', 'lastSync'], async (result) => {
        if (!result.serverUrl || !result.username || !result.password || !result.extensionId) {
            isSyncing = false;
            return sendResponse({ status: "error", message: t('notSetUp'), quiet: true });
        }

        const { serverUrl, username, password, extensionId } = result;
        if (!(await hasServerAccess(serverUrl))) {
            isSyncing = false;
            return sendResponse(noAccessResponse(result.lastSync));
        }
        const credentials = username + ':' + password;
        const authHeader = 'Basic ' + toBase64Utf8(credentials);
        const baseUrl = serverUrl.endsWith('/') ? serverUrl : serverUrl + '/';
        const fileUrl = baseUrl + 'bookmarks_sync.json';

        let myLockFile = null;

        try {
            const lock = await acquireLock(baseUrl, authHeader, extensionId);
            if (!lock.lockFile) return sendResponse({ status: lock.status, message: lock.message });
            myLockFile = lock.lockFile;

            const syncFolder = await getOrCreateSyncFolder();
            const syncFolderId = syncFolder.id;
            if (!syncFolderId) throw new SyncError(t('errFolderCreate'));

            const localTree = await getBookmarksTreeAsync(syncFolderId);
            const knownIds = collectIds(localTree);
            const local = normalizeNode(localTree);
            local.children = withoutArchiveFolder(local.children);
            const remote = await fetchRemoteTree(fileUrl, authHeader);
            noteRemoteFormat(remote);
            // A recreated folder is empty because it was deleted or renamed, not because
            // the user deleted every bookmark: without a base, the merge restores them
            const savedBase = syncFolder.created ? null : await loadSyncBase(fileUrl, syncFolderId);

            // Another device exported since our last sync: merge its changes instead
            // of overwriting them. Without a base (fresh install, new server) both
            // sides are kept: an export is meant to send this device's bookmarks.
            // Devices updated from an older version get a base at update time.
            let uploadChildren = local.children;
            let skipped = null;
            let counts = NO_CHANGES;
            const remoteChanged = remote.tree && !(savedBase && sameTree(remote.tree.children, savedBase));
            if (remoteChanged) {
                uploadChildren = mergeChildren(savedBase, local.children, remote.tree.children);
                if (!sameTree(uploadChildren, local.children)) {
                    ({ skipped, counts } = await applyTreeToLocal(syncFolderId, uploadChildren, knownIds));
                }
                // The merge is applied locally: if the upload fails, the remote we read
                // is the base, so its items aren't mistaken for local additions next time
                await saveSyncBase(fileUrl, withoutSkipped(remote.tree.children, skipped), syncFolderId);
            }

            // Nothing new for the server: no upload, so no new ETag for other devices
            // to download, and less contention on the file. A file from an old-version
            // device is still rewritten, so it no longer reads as one.
            if (remote.tree && !remote.legacy && sameTree(uploadChildren, remote.tree.children)) {
                await saveSyncBase(fileUrl, withoutSkipped(uploadChildren, skipped), syncFolderId);
                return sendResponse({ status: "success", message: syncSummary(counts, false) });
            }

            const putFile = (conditionHeader) => davFetch(fileUrl, {
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
                return sendResponse({ status: "locked", message: t('remoteChanged') });
            }
            if (response.status === 423) throw new SyncError(BUSY_MESSAGE, { locked: true });
            if (!response.ok) throw new SyncError(describeHttpStatus(response.status));

            await saveSyncBase(fileUrl, withoutSkipped(uploadChildren, skipped), syncFolderId);
            chrome.storage.local.set({ newFormatSeen: true });

            console.log("🚀 Sync successful!");
            sendResponse({ status: "success", message: syncSummary(counts, true) });

        } catch (error) {
            console.error("PUSH Error:", error);
            sendResponse(failureResponse(error, t('errSyncFailed')));
        } finally {
            await removeLock(baseUrl, authHeader, myLockFile);
            endSync();
        }
    });
}

// ==========================================
// SYNC LOGIC: IMPORT (PULL) & MERGE
// ==========================================

async function pullBookmarksFromServer(sendResponse = () => {}) {
    sendResponse = recordingResponse("import", sendResponse);
    if (isSyncing) return sendResponse({ status: "locked", message: t('syncInProgress') });
    isSyncing = true;

    chrome.storage.local.get(['serverUrl', 'username', 'password', 'extensionId', 'lastSync'], async (result) => {
        if (!result.serverUrl || !result.username || !result.password || !result.extensionId) {
            isSyncing = false;
            return sendResponse({ status: "error", message: t('notSetUp'), quiet: true });
        }

        const { serverUrl, username, password, extensionId } = result;
        if (!(await hasServerAccess(serverUrl))) {
            isSyncing = false;
            return sendResponse(noAccessResponse(result.lastSync));
        }
        const credentials = username + ':' + password;
        const authHeader = 'Basic ' + toBase64Utf8(credentials);
        const baseUrl = serverUrl.endsWith('/') ? serverUrl : serverUrl + '/';
        const fileUrl = baseUrl + 'bookmarks_sync.json';

        let myLockFile = null;
        let exportNeeded = false;

        try {
            const lock = await acquireLock(baseUrl, authHeader, extensionId);
            if (!lock.lockFile) return sendResponse({ status: lock.status, message: lock.message });
            myLockFile = lock.lockFile;

            const remote = await fetchRemoteTree(fileUrl, authHeader);
            noteRemoteFormat(remote);

            if (!remote.tree) {
                const message = remote.exists ? t('invalidRemoteFile') : t('noRemoteFile');
                // Normal before the first export: told in the popup, not flagged on the icon
                return sendResponse({ status: "error", message, quiet: !remote.exists });
            }

            const syncFolder = await getOrCreateSyncFolder();
            const syncFolderId = syncFolder.id;
            if (!syncFolderId) throw new SyncError(t('errFolderCreate'));

            // Local changes not exported yet are kept, not archived: only what was
            // deleted on the other side since our last sync goes to the archive
            const localTree = await getBookmarksTreeAsync(syncFolderId);
            const knownIds = collectIds(localTree);
            const local = normalizeNode(localTree);
            local.children = withoutArchiveFolder(local.children);
            // Without a base (first import, a new server, or a folder deleted or renamed
            // and recreated empty) the server wins: the folder is restored from it, and a
            // stale folder (e.g. brought back by the browser's own sync) doesn't bring
            // back what other devices deleted
            const savedBase = syncFolder.created ? null : await loadSyncBase(fileUrl, syncFolderId);
            const target = mergeChildren(savedBase || local.children, local.children, remote.tree.children);

            const { counts, skipped } = await applyTreeToLocal(syncFolderId, target, knownIds);
            await saveSyncBase(fileUrl, withoutSkipped(remote.tree.children, skipped), syncFolderId);

            // Kept local changes still have to reach the server
            exportNeeded = !sameTree(target, remote.tree.children) || remote.legacy;
            const nothingApplied = !counts.added && !counts.archived && !counts.renamed && !counts.skipped;
            const message = nothingApplied && exportNeeded ? t('localChangesPending') : syncSummary(counts, false);
            sendResponse({ status: "success", message });

        } catch (error) {
            console.error("PULL Error:", error);
            sendResponse(failureResponse(error, t('errImportFailed')));
        } finally {
            // The lock goes before the sync ends: a sync starting in between would
            // otherwise have its fresh lock deleted. This also gives the bookmark
            // events caused by the import time to arrive while isSyncing is set.
            await removeLock(baseUrl, authHeader, myLockFile);
            endSync(exportNeeded);
        }
    });
}

// ==========================================
// ARCHIVE CLEANUP ROUTINE
// ==========================================

// Date folders are named after the UTC day (YYYY-MM-DD) their items were archived:
// compared as days, so an item is kept at least retentionDays full days. The archive
// folder itself is removed once empty, if next to the sync folder (created again
// there by the next archiving).
async function cleanOldArchives() {
    const { retentionDays } = await new Promise(resolve => chrome.storage.local.get(['retentionDays'], resolve));
    const cutoff = new Date(Date.now() - (retentionDays || 30) * 86400000).toISOString().split('T')[0];

    const results = await new Promise(resolve => chrome.bookmarks.search({ title: ARCHIVE_FOLDER_NAME }, resolve));
    const mainArchive = (results || []).find(r => !r.url);
    if (!mainArchive) return;

    const children = await new Promise(resolve => chrome.bookmarks.getChildren(mainArchive.id, (nodes) => {
        void chrome.runtime.lastError; // Removed meanwhile
        resolve(nodes || []);
    }));
    let remaining = children.length;
    for (const folder of children) {
        if (folder.url || !/^\d{4}-\d{2}-\d{2}$/.test(folder.title) || folder.title >= cutoff) continue;
        const removed = await new Promise(resolve => chrome.bookmarks.removeTree(folder.id, () => resolve(!chrome.runtime.lastError)));
        if (removed) remaining--;
        console.log(`♻️ Deleted old archive folder: ${folder.title}`);
    }

    // Only where it is created by default, next to the sync folder: moved elsewhere by
    // the user, it stays (it would come back next to the sync folder).
    // remove(), not removeTree(): the browser refuses it if the folder isn't empty after all.
    // Not during a sync: it may be about to archive into this folder.
    if (remaining > 0) return;
    const syncFolderId = await findSyncFolderId();
    const syncFolder = syncFolderId && await new Promise(resolve => chrome.bookmarks.get(syncFolderId, (nodes) => {
        void chrome.runtime.lastError;
        resolve(nodes && nodes[0]);
    }));
    if (syncFolder && syncFolder.parentId === mainArchive.parentId && !isSyncing) {
        chrome.bookmarks.remove(mainArchive.id, () => void chrome.runtime.lastError);
    }
}

// ==========================================
// AUTOMATIC TRIGGER & DEBOUNCING
// ==========================================

// Runs a scheduled automatic export
async function runAutomaticPush() {
    // Auto-sync may have been turned off since this export was scheduled
    const { autoSyncEnabled } = await new Promise(resolve => chrome.storage.local.get(['autoSyncEnabled'], resolve));
    if (autoSyncEnabled === false) {
        chrome.alarms.clear(PENDING_EXPORT_ALARM);
        return;
    }

    pushBookmarksToServer((response) => {
        // A held lock (local sync or another device) must delay this export, not drop it
        if (response.status === "locked") {
            armAutomaticPush();
        } else {
            chrome.alarms.clear(PENDING_EXPORT_ALARM);
        }
    });
}

function armAutomaticPush() {
    if (syncTimeout) clearTimeout(syncTimeout);
    // The browser may stop the service worker before the timer fires; an alarm
    // survives that and wakes it up, so the export still happens (a minute later)
    chrome.alarms.create(PENDING_EXPORT_ALARM, { delayInMinutes: 1 });
    syncTimeout = setTimeout(() => {
        syncTimeout = null;
        runAutomaticPush();
    }, 5000);
}

function scheduleAutomaticPush() {
    // Checked before the async read too: an import may finish before its callback runs
    if (isSyncing) return;
    chrome.storage.local.get(['autoSyncEnabled'], (result) => {
        if (result.autoSyncEnabled === false) return;
        if (isSyncing) return; // Ignores the bookmark events caused by an import

        armAutomaticPush();
    });
}

// The sync folder's id, without creating it (unlike getOrCreateSyncFolder).
// Cached: bookmark events can come by thousands (HTML import, browser sync), and a
// search walks every bookmark; the cache is checked with a cheap get().
let cachedSyncFolderId = null;
let syncFolderSearch = null; // In flight, shared by events arriving together

async function findSyncFolderId() {
    if (cachedSyncFolderId) {
        const nodes = await new Promise(resolve => chrome.bookmarks.get(cachedSyncFolderId, (result) => {
            void chrome.runtime.lastError; // Removed meanwhile
            resolve(result);
        }));
        if (nodes && nodes[0] && !nodes[0].url && nodes[0].title === SYNC_FOLDER_NAME) return cachedSyncFolderId;
        cachedSyncFolderId = null;
    }
    if (!syncFolderSearch) {
        syncFolderSearch = new Promise(resolve => chrome.bookmarks.search({ title: SYNC_FOLDER_NAME }, (results) => {
            const folder = pickSyncFolder(results);
            cachedSyncFolderId = folder ? folder.id : null;
            syncFolderSearch = null;
            resolve(cachedSyncFolderId);
        }));
    }
    return syncFolderSearch;
}

async function isInsideSyncFolder(id) {
    const syncFolderId = await findSyncFolderId();
    let current = id;
    for (let depth = 0; syncFolderId && current && depth < 100; depth++) {
        if (current === syncFolderId) return true;
        const nodes = await new Promise(resolve => chrome.bookmarks.get(current, (result) => {
            void chrome.runtime.lastError; // A node removed meanwhile: not ours to sync
            resolve(result);
        }));
        if (!nodes || !nodes[0]) return false;
        if (isArchiveFolder(nodes[0])) return false; // Archived items are never synced
        current = nodes[0].parentId;
    }
    return false;
}

// Bookmark events from the whole browser: only changes inside the sync folder
// schedule an export. ids are the nodes whose ancestry decides (the parent for a
// created or removed bookmark, both parents for a move).
function onBookmarkEvent(...ids) {
    Promise.all(ids.filter(Boolean).map(isInsideSyncFolder)).then((inside) => {
        if (!inside.some(Boolean)) return;
        // During a sync, the change may be the sync's own or the user's: remembered,
        // and exported once the sync ends (an export with nothing new uploads nothing)
        if (isSyncing) {
            changedDuringSync = true;
        } else {
            scheduleAutomaticPush();
        }
    });
}

// Ends a sync: clears the flag, then exports changes made while it ran
function endSync(exportNeeded = false) {
    isSyncing = false;
    const changed = changedDuringSync;
    changedDuringSync = false;
    if (exportNeeded || changed) scheduleAutomaticPush();
}

// ==========================================
// SYNC STATUS & CONNECTION TEST
// ==========================================

// Keeps the outcome of the last export or import, shown in the popup, and flags a
// failure on the toolbar icon: automatic syncs would otherwise fail silently
function recordSyncResult(kind, response) {
    if (!response || response.status === "locked" || response.quiet) return; // Transient, or not a failure to flag
    const ok = response.status === "success";
    chrome.storage.local.set({ lastSync: { kind, ok, message: response.message, time: Date.now() } });

    setFailureBadge(!ok);
}

function setFailureBadge(failed) {
    if (!chrome.action) return;
    chrome.action.setBadgeText({ text: failed ? "!" : "" });
    if (failed) chrome.action.setBadgeBackgroundColor({ color: "#c0392b" });
}

// A failure recorded with the old settings no longer says anything useful
if (chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        if (changes.serverUrl || changes.username || changes.password) {
            chrome.storage.local.remove('lastSync');
            setFailureBadge(false);
        }
    });
}

// Neither the badge nor the alarms are guaranteed to survive a browser restart
// (Firefox drops alarms): the badge is restored from the record, the alarms are
// created again. The automatic import then runs a minute after startup (time for the
// network to come up), so bookmarks added on another computer show up right away.
if (chrome.runtime.onStartup) {
    chrome.runtime.onStartup.addListener(() => {
        chrome.storage.local.get(['lastSync'], (result) => setFailureBadge(Boolean(result.lastSync && !result.lastSync.ok)));
        createAlarms({ delayInMinutes: 1 });
    });
}

function recordingResponse(kind, sendResponse) {
    return (response) => {
        recordSyncResult(kind, response);
        sendResponse(response);
    };
}

// Checks the settings typed in the popup (not yet saved) with a WebDAV PROPFIND on
// the folder, and says precisely what is wrong
async function testConnection({ serverUrl, username, password }) {
    if (!serverUrl || !username || !password) {
        return { status: "error", message: t('testFillIn') };
    }

    const baseUrl = serverUrl.endsWith('/') ? serverUrl : serverUrl + '/';
    const authHeader = 'Basic ' + toBase64Utf8(username + ':' + password);

    let response;
    try {
        response = await fetch(baseUrl, {
            method: 'PROPFIND',
            credentials: 'omit',
            headers: { 'Authorization': authHeader, 'Depth': '1', 'Content-Type': 'application/xml' },
            // oc:permissions is Nextcloud's: it tells whether we can write there
            body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">'
                + '<d:prop><d:resourcetype/><oc:permissions/></d:prop></d:propfind>'
        });
    } catch (error) {
        console.error("Connection test failed:", error);
        return { status: "error", message: NETWORK_ERROR_MESSAGE };
    }

    if (response.status !== 207) {
        // A web page rather than WebDAV, e.g. the Nextcloud login or files page
        if (response.ok) return { status: "error", message: t('errNotWebDav', SETUP_HINT_URL) };
        return { status: "error", message: describeHttpStatus(response.status) };
    }

    let body;
    try {
        body = await response.text();
    } catch (error) {
        console.error("Connection test failed:", error);
        return { status: "error", message: NETWORK_ERROR_MESSAGE };
    }
    // One block per resource: the folder itself (listed first by Nextcloud, but
    // WebDAV doesn't require it, so it is found by its href), then its children
    const blocks = body.split(/<\/(?:[a-z0-9]+:)?response>/i);
    const hrefPath = (block) => {
        const match = block.match(/<(?:[a-z0-9]+:)?href>([^<]*)</i);
        if (!match) return null;
        try {
            return decodeURIComponent(new URL(match[1], baseUrl).pathname).replace(/\/$/, '');
        } catch {
            return null;
        }
    };
    const folderPath = decodeURIComponent(new URL(baseUrl).pathname).replace(/\/$/, '');
    const folderBlock = blocks.find(block => hrefPath(block) === folderPath) || body;
    if (!/<([a-z0-9]+:)?collection\s*\/>/i.test(folderBlock)) {
        return { status: "error", message: t('testFileUrl') };
    }

    // An <href> ending with the file name, not e.g. old_bookmarks_sync.json or a .bak
    const fileBlock = blocks.find(block => /\/bookmarks_sync\.json\s*<\//.test(block));
    const hasFile = Boolean(fileBlock);

    // Nextcloud permission letters: C = create files in a folder, W = write a file.
    // Every sync creates the lock file (C on the folder), and the bookmarks file is
    // created (C) or rewritten (W on it). Absent on other WebDAV servers: not checked.
    const permissionsOf = (block) => {
        const match = block && block.match(/<(?:[a-z0-9]+:)?permissions>([^<]*)</i);
        return match ? match[1] : null;
    };
    const folderRights = permissionsOf(folderBlock);
    if (folderRights !== null && !folderRights.includes('C')) {
        return { status: "error", message: t('testNoCreate') };
    }
    const fileRights = permissionsOf(fileBlock);
    if (hasFile && fileRights !== null && !fileRights.includes('W')) {
        return { status: "error", message: t('testFileReadOnly') };
    }

    return {
        status: "success",
        message: hasFile ? t('testConnectedFile') : t('testConnectedNoFile')
    };
}

// ==========================================
// EVENT LISTENERS
// ==========================================

// Listen to messages from popup.js
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "test_connection") {
        testConnection(request)
            .then(sendResponse)
            .catch(() => sendResponse({ status: "error", message: NETWORK_ERROR_MESSAGE }));
        return true;
    } else if (request.action === "sync_now" || request.action === "push_bookmarks") {
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
            chrome.alarms.clear(PENDING_EXPORT_ALARM);
        }
        sendResponse({ status: "success" });
    } else if (request.action === "update_alarm") {
        // FIXED: Added missing listener for syncFrequency changes
        chrome.alarms.clear("autoPullAlarm", () => {
            chrome.storage.local.get(['autoSyncEnabled'], (result) => {
                // Paused: the alarm is created again when automatic sync is turned on
                if (request.frequency && result.autoSyncEnabled !== false) {
                    chrome.alarms.create("autoPullAlarm", { periodInMinutes: request.frequency });
                }
            });
        });
        sendResponse({ status: "success" });
    }
});

// Updating from a version without a sync base: the folder as it is now (in sync,
// barring changes from the last few seconds) becomes the base, so deletions made
// right after the update aren't undone by the next merge.
// Updating from a version whose base has no folder id (1.7.0 or older): with a single
// folder, the base is tagged with it. With several, which one the base describes can't
// be told (a duplicate may have arrived since the last sync), so the base is dropped:
// the next import lets the server win and an export keeps both sides, nothing is
// deleted from the server.
async function seedSyncBaseAfterUpdate() {
    const { serverUrl, [SYNC_BASE_KEY]: saved } = await new Promise(resolve => chrome.storage.local.get(['serverUrl', SYNC_BASE_KEY], resolve));
    if (!serverUrl) return;
    const baseUrl = serverUrl.endsWith('/') ? serverUrl : serverUrl + '/';
    const fileUrl = baseUrl + 'bookmarks_sync.json';

    const results = await new Promise(resolve => chrome.bookmarks.search({ title: SYNC_FOLDER_NAME }, resolve));
    if (saved && saved.fileUrl === fileUrl) {
        if (saved.folderId) return;
        const folders = (results || []).filter(r => !r.url && r.title === SYNC_FOLDER_NAME);
        if (folders.length > 1) await new Promise(resolve => chrome.storage.local.remove(SYNC_BASE_KEY, resolve));
        else if (folders.length === 1) await saveSyncBase(fileUrl, saved.children, folders[0].id);
        return;
    }

    const folder = pickSyncFolder(results);
    if (!folder) return;
    const local = normalizeNode(await getBookmarksTreeAsync(folder.id));
    if (!local) return; // The folder vanished meanwhile: the next sync sets the base
    await saveSyncBase(fileUrl, withoutArchiveFolder(local.children), folder.id);
}

// The archive cleanup, and the automatic import unless automatic sync is paused.
// firstRun: e.g. { delayInMinutes: 1 } to run them soon instead of after a full period.
let alarmsScheduled = false; // Set at once: ensureAlarms must not override createAlarms

function createAlarms(firstRun = {}) {
    alarmsScheduled = true;
    chrome.alarms.create("dailyCleanup", { ...firstRun, periodInMinutes: 1440 });
    chrome.storage.local.get(['syncFrequency', 'autoSyncEnabled'], (result) => {
        if (result.autoSyncEnabled !== false) {
            const freq = parseInt(result.syncFrequency) || 15;
            chrome.alarms.create("autoPullAlarm", { ...firstRun, periodInMinutes: freq });
        }
    });
}

// Every time the service worker starts: creates the alarms that are missing, and only
// those (an existing one keeps its schedule). Chrome recommends it, since alarms of
// versions before Chrome 150 can be lost unpredictably; Firefox drops them at restart.
// The frequency and the pause are read from the storage, where the popup saves them
// before telling us, so this can't bring back an old value.
function ensureAlarms() {
    chrome.storage.local.get(['syncFrequency', 'autoSyncEnabled'], (result) => {
        const createIfMissing = (name, info) => chrome.alarms.get(name, (alarm) => {
            void chrome.runtime.lastError;
            // The browser answers get() with the state before a create() sent after it:
            // creating here could replace the alarm with a first run soon (startup, install)
            if (!alarm && !alarmsScheduled) chrome.alarms.create(name, info);
        });
        createIfMissing("dailyCleanup", { periodInMinutes: 1440 });
        if (result.autoSyncEnabled !== false) {
            createIfMissing("autoPullAlarm", { periodInMinutes: parseInt(result.syncFrequency) || 15 });
        }
    });
}
ensureAlarms();

chrome.runtime.onInstalled.addListener((details) => {
    if (details && details.reason === 'update') seedSyncBaseAfterUpdate();
    // With a first run soon too: a browser or extension update applied at startup
    // fires this after onStartup, and must not push the startup import back
    createAlarms({ delayInMinutes: 1 });
});

// Listen to alarms
chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === "autoPullAlarm") {
        chrome.storage.local.get(['autoSyncEnabled'], (result) => {
            if (result.autoSyncEnabled !== false) {
                pullBookmarksFromServer();
            }
        });
    } else if (alarm.name === PENDING_EXPORT_ALARM) {
        // Backup for an automatic export lost when the service worker was stopped.
        // A pending timer or a running sync means the worker is alive: they handle it.
        if (syncTimeout || isSyncing) return;
        runAutomaticPush();
    } else if (alarm.name === "dailyCleanup") {
        cleanOldArchives();
    }
});

// ==========================================
// EVENT LISTENERS (Cross-Browser Safe)
// ==========================================

if (chrome.bookmarks.onCreated) {
    chrome.bookmarks.onCreated.addListener((id, node) => onBookmarkEvent(node && node.parentId));
}
if (chrome.bookmarks.onRemoved) {
    chrome.bookmarks.onRemoved.addListener((id, removeInfo) => {
        // A sync folder removed (e.g. a duplicate): searched again, which also
        // updates the duplicate count shown in the popup
        const node = removeInfo && removeInfo.node;
        if (node && !node.url && node.title === SYNC_FOLDER_NAME) {
            cachedSyncFolderId = null;
            // The synced folder may be the one removed: the surviving one is exported
            // (both sides kept), not overwritten by the next import. With none left,
            // nothing is scheduled: the folder isn't recreated right after its removal.
            findSyncFolderId().then(survivor => { if (survivor) onBookmarkEvent(survivor); });
        }
        onBookmarkEvent(removeInfo && removeInfo.parentId);
    });
}
if (chrome.bookmarks.onChanged) {
    chrome.bookmarks.onChanged.addListener((id) => onBookmarkEvent(id));
}
if (chrome.bookmarks.onMoved) {
    chrome.bookmarks.onMoved.addListener((id, moveInfo) => onBookmarkEvent(moveInfo && moveInfo.parentId, moveInfo && moveInfo.oldParentId));
}
if (chrome.bookmarks.onChildrenReordered) {
    chrome.bookmarks.onChildrenReordered.addListener((id) => onBookmarkEvent(id));
}