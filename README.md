# 🔄 Nextcloud Bookmark Sync

**Nextcloud Bookmark Sync** is a privacy-first, cross-browser extension that synchronizes your bookmarks using your own Nextcloud server via WebDAV.

Say goodbye to Big Tech's cloud services. Keep your bookmarks perfectly synced across Brave, Chrome, Edge, and Firefox without your data ever leaving your control.

## ✨ Features

* **🔒 100% Private & Sovereign:** No third-party servers, no analytics, no tracking. Your bookmarks travel exclusively between your local browser and your Nextcloud instance.
* **🤖 Automated Background Sync:** Detects local bookmark changes and automatically pushes them to your server. Pulls updates in the background based on your preferred frequency.
* **🗑️ Smart Archive System:** Deleted bookmarks are never truly lost. They are safely moved to a "🗑️ Bookmark Archives" folder, which intelligently positions itself right next to your sync folder.
* **♻️ Auto-Cleanup Retention:** Archives are neatly organized into sub-folders by date (`YYYY-MM-DD`). A daily background task automatically cleans up archives older than your custom retention limit (1 to 30 days).
* **🎯 Exact Ordering & Strict Matching:** Bookmarks are matched purely by URL across different browser engines (solving local ID mismatch issues). Their exact visual order is also perfectly replicated everywhere.
* **🛡️ Smart Collision Protection:** Uses a custom Mutex lock mechanism (`.lock` files) via WebDAV to ensure your data is never corrupted, even if two browsers try to sync at the exact same millisecond.
* **⚡ Native Integration:** Creates a dedicated "🔄 Bookmark Sync" folder right in your Bookmarks Bar for easy, isolated access.

## 📋 Prerequisites

Before using this extension, you will need:

1. A running **Nextcloud** instance.
2. Your Nextcloud WebDAV URL (usually `https://[your-server]/remote.php/dav/files/[your-username]/`).
3. An **App Password** generated from your Nextcloud Security settings (Do not use your main Nextcloud password!).

## 🚀 Installation

*Note: Official links to the Chrome Web Store and Mozilla Add-ons will be added here once the extension is published.*

**Manual Installation (Developer Mode):**

1. Download or clone this repository to your computer.
2. **Chrome / Brave / Edge:**
   * Go to `chrome://extensions/` (or `brave://extensions/`).
   * Enable **Developer mode** in the top right corner.
   * Click **Load unpacked** and select the folder containing the extension files.
3. **Firefox:**
   * Go to `about:debugging#/runtime/this-firefox`.
   * Click **Load Temporary Add-on...** and select the `manifest.json` file from the folder.

## ⚙️ Configuration & Usage

1. Click on the **Nextcloud Bookmark Sync** icon in your browser toolbar.
2. You can quickly pause or resume background syncing using the **Auto-sync toggle** on the main screen.
3. Click the **Gear icon** (⚙️) to open the Settings view and fill in your details:
   * **Target Folder URL:** Your Nextcloud WebDAV path.
   * **Username:** Your Nextcloud username.
   * **App Password:** The app password you generated in Nextcloud.
   * **Auto-Sync Frequency:** Choose how often the background script should check for updates.
   * **Archive Retention:** Use the cross-browser slider to set how long deleted items should be kept before permanent deletion (1 to 30 days).
4. *Settings are auto-saved as you type.* Click **← Back to Sync**.
5. Click **Export to Nextcloud** to push your current bookmarks to the server for the first time.
6. Install the extension on your other browsers/computers, enter the exact same credentials, and click **Import from Nextcloud** to pull the data.

*After the initial setup, the extension will handle syncing automatically in the background.*

## 🛠️ How it Works (Under the Hood)

* **Push (Export):** When you add, delete, edit, or move a bookmark inside the `🔄 Bookmark Sync` folder, a 5-second debounce timer starts. Once the timer finishes, the extension locks the remote file and uploads a fresh `bookmarks_sync.json` via a `PUT` request.
* **Pull (Import):** The background service worker wakes up every X minutes (via `chrome.alarms`), checks for a lock, and downloads the JSON file via a `GET` request. It then executes a rigorous 3-step merge:
  1. **Add** missing items locally.
  2. **Archive** local items that were deleted on the server.
  3. **Reorder** all elements to exactly match the server's layout.

## 🤝 Contributing

Contributions, issues, and feature requests are highly encouraged!
If you find a bug or have an idea for an improvement, feel free to open an issue or submit a pull request. Let's build a better, decentralized sync tool together.

## 📄 License

This project is licensed under the **GNU General Public License v3.0 (GPL-3.0)**.

This means you are free to use, modify, and distribute this software. However, any derivative work or modified versions of this extension must also be completely open-source and distributed under the exact same GPLv3 license. See the [LICENSE](LICENSE) file for more details.
