---
name: release-extension
description: Prepare and publish a release of the nextcloud_bookmark_sync browser extension - version bump PR, tag, zip, GitHub release, release notes and store submission sheets (Chrome Web Store, Firefox Add-ons). Use when the user asks to release, publish or ship a new version of the extension. Argument - the version X.Y.Z (ask if missing).
---

# Release of the nextcloud_bookmark_sync extension

Run from the root of this repository. Its `CLAUDE.md` holds the project rules and the release checklist: read it first, it wins over this file if they differ. This skill adds the order of work, the checks, and where the documents go.

Rules that never bend:
- `main` only accepts pull requests: branch, `gh pr create`, `gh pr merge N --squash --delete-branch`. Never push to `main`, never `--admin`.
- Merging, pushing a tag, publishing the GitHub release and every store submission need the user's explicit go, one by one. The user submits to the stores themselves in the dashboards: you only prepare the files.
- Everything written for a release or a store is in English (notes, descriptions, submission sheets). Chat replies stay in the user's language.
- Write files with the editor tools (Write, Edit), never through a shell string: backticks, `$` and backslashes get mangled.
- Commit messages and PR bodies end with the attribution lines given in the conversation's system reminder.
- Never print or copy a real password. Notes to the store reviewers carry the placeholder `<APP-PASSWORD>`, which the user fills in; if a file with a real one turns up, mask long tokens before showing it (`sed -E 's/[A-Za-z0-9-]{20,}/<MASKED>/g'`).

## 1. Before starting
- On `main`, clean, up to date (`git pull --ff-only`). CI on `main` is green (unit tests and end-to-end).
- List what is released: `git log --oneline <previous tag>..HEAD`, and `git diff <previous tag> HEAD --stat`.
- If the sync logic changed (merge, base, lock, conditional upload, folder handling, `applyTreeToLocal`), ask whether the pre-merge checklist of `CLAUDE.md` was done for it on the **final** state, not on intermediate commits: one `reviewer` pass on the full diff since the last release, one second review by another vendor's model on that same full diff, a manual check in Firefox. If a fix landed after those reviews, the diff has changed: say so and ask whether to review again. Do not go on without a yes.
- Documentation: run the `doc-checker` agent on `git diff <previous tag> HEAD` with the repository path and the documents to check (README, `privacy-policy.md`, `_locales/`). Check each finding in the code and fix the documentation (through a PR) before the bump. A new local record, permission or network request must be in the privacy policy.

## 2. Version bump PR
1. Branch `release/X.Y.Z`; change `"version"` in `manifest.json` only (it is the only place: other mentions of old versions are history).
2. `node --test`; commit `chore: Bump version to X.Y.Z`; push; PR with a short body; wait for the `test` and `e2e` checks (`gh pr checks N --watch`).
3. Ask for the go to merge.

## 3. Tag
After the merge: `git switch main && git pull --ff-only`; annotated tag `vX.Y.Z` on the merge commit with a one-line summary (write the message to a file and use `-F`); push the tag; check with `git ls-remote --tags origin vX.Y.Z`.

## 4. Package
1. `node tools/package.js vX.Y.Z` builds `dist/nextcloud_bookmark_sync-X.Y.Z.zip`.
2. Load it in English and French: `E2E_BROWSER=msedge node tests/e2e/package.e2e.js` (Windows, installed Edge; elsewhere leave `E2E_BROWSER` unset to use Playwright's Chromium, as CI does). Both must pass.
3. Permissions: `git diff <previous tag> vX.Y.Z -- manifest.json`. Say explicitly whether a permission changed: a new permission means a longer review and a changed privacy section in the stores.
4. Copy the zip to the user's release documents folder (outside the repository: ask where it is, the maintainer uses `~/Developments/`) and compute its SHA-256 (`sha256sum`).
5. Store screenshots only if the popup changed in a visible way: `node tools/store-screenshots.js en` and `fr`.

## 5. Documents (all in English, in the release documents folder, outside the repository)
- `release-X.Y.Z-github.md`: Fixed / Improved / Verified, from the commit log and the PR descriptions. Claim only what was verified: the number of tests comes from CI, a manual test is listed only if it was done, and say when a step was run by hand.
- `amo-release-notes-X.Y.Z.txt`: the same sections, condensed. AMO's "Release notes" field takes at most 3,000 characters: measure in characters, not bytes (`node -e` with `[...text].length`). No link, no "›", no "&". Not the full GitHub text and not a one-line summary.
- `store-description.txt`: one common description for both stores, version-free, written within AMO's limits (no link, no bracketed URL, no "›", "and" instead of "&"). Touch it only if the user asks. The setup guide link goes in the stores' Homepage or Support field.
- `amo-reviewer-notes-X.Y.Z.txt`: copy the structure of the previous notes, update the "New in" paragraph, keep `<APP-PASSWORD>`. Under 3,000 characters.
- `chrome-submission-X.Y.Z.md` and `amo-submission-X.Y.Z.md`: files and hashes, what changed (permissions first), the steps in each dashboard, what to paste where. Chrome's dashboard has no release notes field: Package tab "Upload New Package", Store listing tab for the description and the Homepage or Support URL, then "Submit for Review". For AMO: upload the new version, no source code to submit (no build step), release notes and notes to reviewers on the version.

## 6. Publishing
- GitHub release, only with the go: `gh release create vX.Y.Z dist/nextcloud_bookmark_sync-X.Y.Z.zip --title "X.Y.Z" --notes-file <release-X.Y.Z-github.md> --latest --verify-tag`; then `gh release view vX.Y.Z` to check it is not a draft and the zip is attached.
- Stores: hand over the two submission sheets and stop. Ask the user to tell you when each submission is done.

## 7. After the submissions
- AMO: `curl -s "https://addons.mozilla.org/api/v5/addons/addon/nextcloud-bookmark-sync/?lang=en-US"`: `current_version.version` and `current_version.file.status` (`public` once approved). The public description differs only by AMO's own rendering (it strips U+FE0F and wraps 4-space indented lines in a code block): compare after ignoring those.
- Chrome: the public page is cached and updates some time after the approval. Fetch `https://chromewebstore.google.com/detail/nextcloud-bookmark-sync/khfpengpkhgddoglikfbmbacpgokjnpo?hl=en` and look for the new version and for phrases of the new description.
- Update the release state in the project's memory file, and remind the user of loose ends: revoke the reviewers' app password when it is no longer needed.

## Known pitfalls
- A tag on the bump commit, never before the merge.
- The Edge test of an update cannot replay the browser's update event for an unpacked extension (it keeps the old service worker); call the update handler by hand and say so in the notes.
- With a self-signed certificate, Chrome and Edge extensions answer "Server unreachable" even after accepting the exception in a tab (seen on Edge); use a certificate the system trusts, or launch a throwaway Edge profile with `--ignore-certificate-errors` for local tests.
- After a reboot, Docker Desktop must be started before the end-to-end server: `docker start nbs-nc nbs-caddy` brings the test Nextcloud back without reinstalling it (`bash tests/e2e/server.sh start` recreates it).
