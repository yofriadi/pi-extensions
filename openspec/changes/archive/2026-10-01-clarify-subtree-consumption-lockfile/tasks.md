# Tasks: clarify-subtree-consumption-lockfile

## 1. Spec delta

- [x] 1.1 Amend the `Subtree consumption` requirement: a regenerated root lockfile SHALL be adjudicated before it is committed, and a delta that only removes importers for packages untracked at HEAD is dropped with the reason recorded in the sync change
- [x] 1.2 Amend the same requirement: when a pull stops on conflicts the caller branch stays untouched and the remaining candidate steps are completed by hand in the same detached-candidate shape, with resolutions recorded
- [x] 1.3 Add one scenario per rule: in-flight importers, and a hand-driven conflicting pull

## 2. Verification

- [x] 2.1 `openspec validate clarify-subtree-consumption-lockfile --strict` clean
- [x] 2.2 Confirm the amendment matches what `sync-upstream-2-11-2` actually did (archived tasks 5.2 and 5.3) so the spec and the record agree
- [x] 2.3 Archive the change into `openspec/specs/upstream-sync/spec.md`

## 3. Out of scope

Amending `scripts/update-pi-condense-subtree.sh` in the monorepo (a separate repository and a separate decision), the untracked `pi-cc-ui` / `pi-provider-cline` workspace state that causes the importer delta, and any source or test behavior.
