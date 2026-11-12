# 🔄 Nextcloud Bookmark Sync

**Nextcloud Bookmark Sync** is a privacy-first, cross-browser extension that synchronizes your bookmarks using your own Nextcloud server via WebDAV.

Say goodbye to Big Tech's cloud services. Keep your bookmarks perfectly synced across Brave, Chrome, Edge, and Firefox without your data ever leaving your control.

## ✨ Features

* **🔒 100% Private & Sovereign:** No third-party servers, no analytics, no tracking. Your bookmarks travel exclusively between your local browser and your Nextcloud instance.
* **🤖 Automated Background Sync:** Detects local bookmark changes and automatically pushes them to your server. Pulls updates in the background based on your preferred frequency, and a minute after the browser starts, so a switch of computer shows the latest bookmarks right away.
* **🗑️ Smart Archive System:** Deleted bookmarks are never truly lost. They are safely moved to a "🗑️ Bookmark Archives" folder, which is created right next to your sync folder. Move it wherever you like afterwards: it stays there.
* **♻️ Auto-Cleanup Retention:** Archives are neatly organized into sub-folders by date (`YYYY-MM-DD`). A daily background task automatically cleans up archives older than your custom retention limit (1 to 30 days, counted in whole days). Once the last dated sub-folder is gone, the empty archive folder is removed too (only when it is still next to your sync folder), and created again by the next archiving.
* **🎯 Exact Ordering & Strict Matching:** Bookmarks are matched purely by URL across different browser engines (solving local ID mismatch issues). Their exact visual order is also perfectly replicated everywhere.
* **🛡️ Collision Protection:** Uses a lock file (`bookmarks_sync.lock`) via WebDAV so that a device backs off with a "locked" status if another device is already syncing, and automatic syncs are retried afterwards. It's a best-effort lock (not an atomic distributed mutex) with a 5-minute staleness timeout, so a crashed device can never leave sync permanently blocked.
* **🔀 Concurrent Changes Merged:** Each device remembers the folder as of its last sync. If another device synced in the meantime, changes from both sides are merged (additions kept, deletions and renames applied) instead of the last export replacing the other's. The upload is conditional (`If-Match` on the file's ETag), so a write that slips in between is detected and retried rather than overwritten.
* **🖱️ One Button:** **Sync now** merges both ways in one go and tells you what changed ("2 added, 1 archived · changes sent"). The popup follows your browser's language (English and French) and its light or dark theme.
* **🩺 Clear Diagnostics:** A **Test connection** button and precise error messages (wrong password, folder not found, not a WebDAV URL, server unreachable). The last sync result is shown in the popup, and a failed automatic sync is flagged on the toolbar icon.
* **⚡ Native Integration:** Creates a dedicated "🔄 Bookmark Sync" folder right in your bookmarks bar (Chrome, Brave, Edge and Firefox) for easy, isolated access. You can move it anywhere afterwards: it is found by its name.

## 📋 Prerequisites

Before using this extension, you will need:

1. A running **Nextcloud** instance.
2. A folder in Nextcloud Files for the bookmarks file, and its WebDAV URL (see the [Setup Guide](#setup-guide)).
3. An **App Password** generated from your Nextcloud Security settings (Do not use your main Nextcloud password!).

## 📱 Mobile

The extension is for desktop browsers only. On phones and tablets, browsers either don't run extensions (Chrome for Android) or don't give them access to bookmarks (Firefox for Android has no `bookmarks` API, see [Mozilla bug 1796597](https://bugzilla.mozilla.org/show_bug.cgi?id=1796597)), so there is nothing the extension could sync. On mobile, use your browser's own bookmark sync.

## 🚀 Installation

**From the stores (recommended):**

* **Chrome / Brave / Edge:** [Chrome Web Store](https://chromewebstore.google.com/detail/nextcloud-bookmark-sync/khfpengpkhgddoglikfbmbacpgokjnpo)
* **Firefox:** [Firefox Add-ons](https://addons.mozilla.org/firefox/addon/nextcloud-bookmark-sync/)

**Manual Installation (Developer Mode):**

1. Download or clone this repository to your computer.
2. **Chrome / Brave / Edge:**
   * Go to `chrome://extensions/` (or `brave://extensions/`).
   * Enable **Developer mode** in the top right corner.
   * Click **Load unpacked** and select the folder containing the extension files.
3. **Firefox:**
   * Go to `about:debugging#/runtime/this-firefox`.
   * Click **Load Temporary Add-on...** and select the `manifest.json` file from the folder.

## Setup Guide

The extension syncs only the bookmarks inside its **"🔄 Bookmark Sync"** folder, and stores them as a single file, `bookmarks_sync.json`, in a folder of your **Nextcloud Files**. It does not use the Nextcloud Bookmarks app.

1. **Create a folder in Nextcloud Files**, for example `Bookmarks`. The extension writes its file there.
2. **Create an app password:** in Nextcloud, open **Settings › Security**, and under *Devices & sessions* create a new app password (name it e.g. "Bookmark Sync"). Don't use your main password.
3. **Find the folder's WebDAV URL:** in Nextcloud Files, open **Files settings** (bottom left). It shows your WebDAV address, usually `https://[your-server]/remote.php/dav/files/[your-username]/`. Add your folder name at the end: `https://[your-server]/remote.php/dav/files/[your-username]/Bookmarks/`. It must start with `https://`.
4. **Fill in the settings:** click the extension icon, then the **gear icon** (⚙️), and enter the folder URL, your Nextcloud username and the app password. Settings are saved as you type.
5. **Click "Test connection".** It tells you exactly what's wrong if something is: wrong username or app password, folder not found or read-only, not a WebDAV URL, server unreachable. The first time, the browser asks for access to your Nextcloud domain: accept it.
6. **Click ← Back, then "Sync now".** The bookmarks of the "🔄 Bookmark Sync" folder are sent to Nextcloud.
7. **On your other browsers and computers**, install the extension, enter the same settings, and click **"Sync now"**: each device keeps its own bookmarks and gets the others'.

After that, syncing is automatic: changes are sent a few seconds after you make them, and other devices' changes are fetched in the background at the frequency you choose. The **Automatic sync** switch on the main screen pauses or resumes it.

The main screen shows what the last sync did and when. If an automatic sync fails, a red **!** appears on the extension icon; open the popup to see why, with a link to the settings. Before your first sync with the current settings, the missing permission described below is not flagged this way: it is expected.

Other settings:
* **Automatic sync frequency:** how often other devices' changes are fetched in the background.
* **Archive retention:** how long deleted items stay in the archive before permanent deletion (1 to 30 days).
* **Advanced › Import only:** applies the server's changes to this browser without sending this browser's changes.

> **Note:** The extension only ever requests access to the one Nextcloud domain you configure (not to every website), when you first click **Test connection** or **Sync now**. Accept the prompt so the automatic background sync can reach your server afterwards. In Firefox and Edge, the popup closes while the prompt is shown: nothing is lost (the settings are saved as you type), and the next click on the button goes through.

> **Self-signed certificate:** the server must have a certificate the browser trusts. Firefox lets you accept the exception for a self-signed certificate once, and the extension then works. In Chrome, Brave and Edge, accepting it in a tab is not enough for the extension's own requests: the test answers "Server unreachable" (seen on Edge). Use a certificate your system trusts, for example one from Let's Encrypt.

## 🛠️ How it Works (Under the Hood)

* **Sync base:** After each successful sync, the extension stores the folder content it agreed on with the server (titles, URLs and structure only) in the browser's local extension storage. Comparing the local folder and the server file against this base tells an addition on one side apart from a deletion on the other.
  * A bookmark is identified by its URL, a folder by its title; renaming a folder counts as deleting it and adding a new one.
  * The base is tied to the server URL and to the local folder it describes (the folder's id is stored with it).
  * **Without a base** (first sync on a device, or a new server URL), **Sync now** keeps both sides, while the background import lets the server win (local-only items go to the archive), so a stale folder brought back by the browser's own sync doesn't resurrect what other devices deleted.
  * **Folder deleted or renamed:** the next sync recreates the `🔄 Bookmark Sync` folder and restores its content from the server, rather than reading the empty folder as "everything was deleted".
  * **Several folders with that name** (for example after the browser's own sync merged a folder recreated on two devices): the oldest one is always the synced folder. The popup tells you where it is and how many bookmarks it holds, and asks you to move what you need into it and delete the others.
  * **Another folder becomes the synced one** (an older duplicate shows up, or you delete the synced folder): the base of the previous folder is not used for it, since what the new folder lacks would read as deleted. The background import lets the server win, and **Sync now** keeps both sides. Nothing is deleted, but bookmarks removed on other devices may come back.
  * **Updating:** from 1.5.1 or earlier, the folder as it is at update time becomes the base, so deletions made after the update hold; from 1.7.0, the existing base is tied to the sync folder if there is only one, and dropped if several folders carry the name (which one the base describes can't be told), so that nothing is deleted from the server.
* **Sync (Sync now, and automatic after a change):** When you add, delete, edit, or move a bookmark inside the `🔄 Bookmark Sync` folder, a 5-second debounce timer starts (changes elsewhere in your bookmarks are ignored). If the browser stops the extension's background worker before the timer fires, a backup alarm runs the sync a minute later. Once the timer finishes, the extension locks the remote file and downloads it. If it is unchanged since the base, the local folder is uploaded as is; otherwise both sides are merged, the merge is applied locally, and the merged result is uploaded. The `PUT` carries `If-Match` with the ETag just read (`If-None-Match: *` for the very first sync); a `412` response means another device wrote in between, and the sync is retried. When the server already has exactly this content, nothing is uploaded.
* **Background import (and Import only):** The background service worker wakes up every X minutes (via `chrome.alarms`) and a minute after the browser starts. The alarms are created again whenever the background starts, if missing, since Firefox drops them when it restarts. It checks for a lock, downloads the JSON file via a `GET` request, merges it with the local folder against the base, and applies the result in 3 steps:
  1. **Add** missing items locally and apply renames. An entry the browser refuses (not a valid URL, e.g. after a hand edit of the JSON) is skipped and counted in the result message instead of aborting the sync. It stays on the server for the devices that accept it.
  2. **Archive** local items that were deleted on another device.
  3. **Reorder** all elements to match the server's layout (or keep the local order if only this device reordered); additions keep their place before their next sibling.

  Local changes not sent yet are kept rather than archived, and a sync is scheduled afterwards to send them. The result message counts what was added, archived, renamed or skipped.
* **Devices on older versions** (1.5.1 and earlier) still upload their whole folder without merging, and mirror the server on import. Update every device to get the full protection. Their file format is recognizable, so the popup warns for a week after one of them wrote the file.
* **Cross-browser background page:** `manifest.json` declares both `service_worker` and `scripts` under `background`. Chrome/Brave/Edge use the `service_worker` entry; Firefox, whose Manifest V3 background model doesn't run a real service worker, falls back to `scripts`. Both point at the same `background.js`.

## 🤝 Contributing

Contributions, issues, and feature requests are highly encouraged!
If you find a bug or have an idea for an improvement, feel free to open an issue or submit a pull request. Let's build a better, decentralized sync tool together.

Before submitting a pull request, run the unit tests (Node.js 22 or later, no dependencies): `node --test`. They load `background.js` and `popup.js` with mocked browser and WebDAV APIs.

The end-to-end tests run the real extension in Chromium against a real Nextcloud (Docker) behind an HTTPS proxy that compresses responses, like many real setups:

```
npm ci
npx playwright install chromium     # or use an installed Edge: E2E_BROWSER=msedge
bash tests/e2e/server.sh start      # Nextcloud on https://localhost:8443 (about a minute)
node tests/e2e/sync.e2e.js          # connection test, errors, one device, two devices merging
node tools/package.js               # dist/nextcloud_bookmark_sync-<version>.zip, the store package
node tests/e2e/package.e2e.js       # loads that zip, in English and French
bash tests/e2e/server.sh stop
```

Both suites run automatically on every pull request. `node tools/store-screenshots.js en` (or `fr`) renders the store screenshots into `dist/screenshots/`.

## 📄 License

This project is licensed under the **GNU General Public License v3.0 (GPL-3.0)**.

This means you are free to use, modify, and distribute this software. However, any derivative work or modified versions of this extension must also be completely open-source and distributed under the exact same GPLv3 license. See the [LICENSE](LICENSE) file for more details.
