# Privacy Policy for Nextcloud Bookmark Sync

Effective Date: November 12, 2026

Nextcloud Bookmark Sync ("the Extension") was built from the ground up with a strict privacy-first philosophy. This policy explains how your data is handled.

1. No Data Collection by the Developer
The developer of this Extension does not collect, store, access, or transmit any of your personal data, browsing history, or bookmarks. We do not operate any intermediary servers.

2. How Your Data is Handled
All configurations—including your Nextcloud WebDAV URL, username, and app password—are stored exclusively on your local device using the browser's extension storage. Since version 1.6.0, the Extension also keeps there a copy of the synced folder as of the last successful sync (bookmark titles, URLs and folder structure only), used to merge changes from several devices. This copy never leaves your device.

The Extension also keeps a few small technical records in the same storage: the outcome and time of the last sync, the local id of the synced folder, the number of folders with the same name that were found (to warn you about duplicates), and a random identifier of this browser. These stay on your device, except the random identifier, which is written in a lock file on your own Nextcloud server so that two devices do not sync at once. It contains no personal information.

3. Data Transmission
Synchronization occurs directly and securely (via HTTPS) between your local browser and the specific Nextcloud server you configure in the settings. Your bookmarks are never routed through any third-party services.

4. Analytics and Tracking
This Extension contains absolutely no tracking codes, analytics software, or telemetry of any kind.

5. Changes to This Policy
If we update this policy, the changes will be reflected on this page. However, our core commitment to zero data collection will never change.

Contact:
If you have any questions about this privacy policy or the extension's code, please contact the developer at: <https://github.com/hollowbeam/nextcloud_bookmark_sync/issues>
