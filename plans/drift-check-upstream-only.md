---
status: done
depends: [slug-history-config]
specs:
  - specs/behaviors/storage.md
pr: 203
---

# Plan: drift check tolerates configs that are only in the data repo

## Scope

The sheet-config drift check (from [`slug-history-config`](slug-history-config.md))
failed whenever `codeforphilly-data#empty` had a config the app doesn't
vendor. Sheets land in the data repo before the app opens them, so the
`events` / `event-rsvps` configs turned CI red everywhere. Upstream-only
files now warn; vendored files must still match exactly.

## Implements

- [behaviors/storage.md](../specs/behaviors/storage.md): the config-ownership
  paragraph says what fails and what warns.

## Validation

- [x] Against the live `empty` (with the events configs): exits 0 with two
      warnings
- [x] A vendored config that differs still fails (the pre-push state of
      #199 was exactly that; folded into #203 from #206 so both land with the contract)
- [x] `type-check` + `lint` clean

## Notes

None.

## Follow-ups

None.
