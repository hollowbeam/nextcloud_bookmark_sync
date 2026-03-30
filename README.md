# 🔄 Nextcloud Bookmark Sync

**Nextcloud Bookmark Sync** is a privacy-first, cross-browser extension that synchronizes your bookmarks using your own Nextcloud server via WebDAV.

Say goodbye to Big Tech's cloud services. Keep your bookmarks perfectly synced across Brave, Chrome, Edge, and Firefox without your data ever leaving your control.

## ✨ Features

* **🔒 100% Private & Sovereign:** No third-party servers, no analytics, no tracking. Your bookmarks travel exclusively between your local browser and your Nextcloud instance.
* **🤖 Automated Background Sync:** Detects local bookmark changes and automatically pushes them to your server. Pulls updates in the background based on your preferred frequency (5, 15, or 30 minutes).
* **🗂️ Preserves Folder Structure:** Your nested bookmark folders are fully respected and rebuilt accurately across all your devices.
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
2. Click the **Gear icon** (⚙️) to open the Settings view.
3. Fill in your credentials:
   * **Target Folder URL:** Your Nextcloud WebDAV path.
   * **Username:** Your Nextcloud username.
   * **App Password:** The app password you generated in Nextcloud.
   * **Auto-Sync Frequency:** Choose how often the background script should check for updates.
4. *Settings are auto-saved as you type.* Click **← Back to Sync**.
5. Click **Export to Nextcloud** to push your current bookmarks to the server for the first time.
6. Install the extension on your other browsers/computers, enter the exact same credentials, and click **Import from Nextcloud** to pull the data.

*After the initial setup, the extension will handle syncing automatically in the background.*

## 🛠️ How it Works (Under the Hood)

* **Push (Export):** When you add, delete, or move a bookmark inside the `🔄 Bookmark Sync` folder, a 5-second debounce timer starts. Once the timer finishes, the extension locks the remote file and uploads a fresh `bookmarks_sync.json` via a `PUT` request.
* **Pull (Import):** The background service worker wakes up every X minutes (via `chrome.alarms`), checks for a lock, downloads the JSON file via a `GET` request, and carefully merges new URLs and folders into your local tree without creating duplicates.

## 🤝 Contributing

Contributions, issues, and feature requests are highly encouraged!
If you find a bug or have an idea for an improvement, feel free to open an issue or submit a pull request. Let's build a better, decentralized sync tool together.

## 📄 License

This project is licensed under the **GNU General Public License v3.0 (GPL-3.0)**.

This means you are free to use, modify, and distribute this software. However, any derivative work or modified versions of this extension must also be completely open-source and distributed under the exact same GPLv3 license. See the [LICENSE](LICENSE) file for more details.
