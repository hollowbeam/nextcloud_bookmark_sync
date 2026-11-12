# Nextcloud Bookmark Sync

Browser extension (Chrome, Brave, Edge, Firefox; Manifest V3) that syncs the bookmark folder "🔄 Bookmark Sync" through a single JSON file on the user's Nextcloud, over WebDAV. No build step, no runtime dependencies: `background.js`, `popup.html`, `popup.js`, `manifest.json`, `_locales/`.

## Product principles
- Keep it simple: one dedicated folder, one "Sync now" button. Prefer what users ask for over new features. Choosing the folder to sync was designed and dropped; don't bring it back unless users request it.
- Never lose bookmarks. Deletions go to the archive folder, a sync must never empty the server by mistake, and any change to the merge, the base or the lock is high stakes.

## Git and GitHub
- `main` only accepts pull requests; the `test` and `e2e` checks must pass. Work on a branch, open a PR with `gh pr create`, merge with `gh pr merge N --squash --delete-branch`. Never push to `main`, never use `--admin`.
- The version bump goes through its own PR (`release/X.Y.Z`); releases are annotated tags `vX.Y.Z`.

## Tests
- Unit: `node --test` (`tests/sync.test.js`, background and popup in a Node vm with mocked browser and WebDAV APIs). Every fix gets a test that fails without it: check by running the new test against the previous commit.
- End-to-end: `bash tests/e2e/server.sh start` (Nextcloud in Docker behind an HTTPS gzip proxy), then `node tests/e2e/sync.e2e.js`. On Windows, use the installed Edge: `E2E_BROWSER=msedge`. Stop with `bash tests/e2e/server.sh stop`.
- User-facing text lives in `_locales/en` and `_locales/fr` (same keys in both; `t()` in the code). The tests read the English messages.

## Sensitive areas
Merge, base (it records which folder it describes), lock, conditional upload, folder handling (sync folder, duplicates, archive folder), `applyTreeToLocal`. Even a small change there starts with the `architect` agent, before any code: the 1.7.1 polish, thought of as five small points, produced two review findings on its own code (an archive cleanup contradicting another change, a race with a sync).

## Before merging a change to the sync logic
1. Unit and end-to-end tests pass, locally and in CI.
2. The `reviewer` agent on the full diff since the last release (not only the last commit): a bug can sit in an earlier unreleased PR (the 1.7.1 review found one from #11). Check each finding in the code; test those marked « à confirmer » before fixing them. Browser behaviour (`bookmarks`, `alarms`, `permissions`, Chrome against Firefox) can't be checked by the agents: check it in the official documentation, with the source.
3. A second review by another vendor's model (Gemini via `agy`, see the `/second-review` skill), its findings checked the same way. Keep its report in `C:\Users\shini\Developments\second-reviews\`, not only in `%TEMP%`.
4. Manual check in Firefox, since CI only runs Chromium.

## Release
1. Bump `manifest.json` in a `release/X.Y.Z` PR, merge, tag `vX.Y.Z` on the merge commit.
2. `node tools/package.js vX.Y.Z` builds `dist/nextcloud_bookmark_sync-X.Y.Z.zip` (with `_locales/`: without it the extension doesn't load), then `node tests/e2e/package.e2e.js` loads that zip in English and French.
3. Store screenshots if the popup changed: `node tools/store-screenshots.js en` and `fr` (1280x800, `dist/screenshots/`).
4. GitHub release with the zip; store notes stay out of the GitHub notes. Release notes, GitHub and stores, are written in English only.
5. Stores: one version-free description for both, written within AMO's limits: no link, no bracketed URL and no "›" (saving hangs without an error), and "and" rather than "&" (AMO shows `&amp;`). The setup guide link goes in the store's Homepage or Support field, not in the text.

## Working here
- Edit files with the editor tools or a script file, never by passing text through a shell command: backticks, `$` and backslashes get executed or mangled.
