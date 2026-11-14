# Incremental runs and the lock file

locale-ai only translates what's missing or changed. Untouched translations are kept, so re-running `translate` on an up-to-date project is a no-op. For the short version, see the [README](../README.md#keeping-translations-in-sync).

## `locale-ai.lock.json`

A small lock file remembers, *per target locale*, a hash of each source string and of the output last written for it. Translating `es` never marks a never-touched `fr` as up to date.

- **Where it lives**: next to your config file if you have one, otherwise next to the locale files themselves — never wherever you happened to run the command from.
- **Commit it**, like a package lock. That's what makes the history consistent across machines and CI, and what lets `locale-ai check` fail CI on a stale translation.
- **Merge-friendly format**: a flat, one-line-per-key JSON file with short hashes, so a 5,000-key, 4-locale project stays small and two translators editing different keys touch different lines. An unresolved merge conflict (stray `<<<<<<<` markers) is an error, not silently discarded.

## What happens on each run

| You changed… | Next `translate` run | `check` |
|---|---|---|
| Nothing | No-op | Passes |
| Added a source key | Translates just that key, for every locale | Fails (missing key) until translated |
| Edited a source string | Re-translates that key, for every locale — it isn't enough for the target to already hold *some* text | Fails (stale) until translated |
| Removed a source key | Drops it from the targets and the lock | Warns about the orphaned target key, without failing |
| Hand-edited a target string | Keeps your edit, never overwrites it, and reports it for review on every run | Passes |
| Hand-edited a target **and** edited its source | Keeps your edit and reports a **conflict**, not auto-resolved either way | Fails (stale) |

## Approving hand edits

Once you've reviewed a hand edit, approve it so it stops being reported:

```bash
locale-ai accept --to fr cart.title        # one key
locale-ai accept --to fr,de                # every flagged key in fr and de
```

`accept` only updates the lock's own record of what it last wrote. It never changes the locale file.

## Starting over

`translate --overwrite` bypasses all of the above and re-translates everything, hand edits included.
