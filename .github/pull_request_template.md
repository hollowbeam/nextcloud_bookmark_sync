## What and why

## Checks
Delete the lines that do not apply.

- [ ] Unit and end-to-end tests pass (CI); every fix has a test that fails without it
- [ ] User-visible text is in `_locales/en` and `_locales/fr`, with the same keys
- [ ] The documentation matches the change: README, `privacy-policy.md` (any new local data, permission or network request), `_locales/`
- [ ] Sync logic touched (merge, base, lock, conditional upload, folder handling): designed with the `architect` first; `reviewer` on the full diff since the last release and again on the final state; one second review by another vendor's model; manual check in Firefox
- [ ] Release PR only: the version bump in `manifest.json` alone; tag after the merge; notes in English
