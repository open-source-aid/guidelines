# 12. Versioning and releases

## Two version numbers

| Version | Where | Changes when |
|---|---|---|
| **Contract version** `API_VERSION: u16` | `pump-shared` (later `device-shared`) | The host-facing contract changes incompatibly: a variant added to an exhaustive enum (`Action`, `Completion`, `BleOp`), a trait method changed, a unit changed meaning |
| **Crate version** (semver) | Every `Cargo.toml` | Every release, following semver |

Every driver reports both: `DriverInfo.version` (its crate version) and `DriverInfo.api_version` (the contract it was built against). Hosts MUST refuse a driver whose `is_compatible()` is false, rather than run it against a contract it does not understand.

## What counts as breaking

| Change | Contract version | Crate semver |
|---|---|---|
| New variant in `Action`, `Completion`, `BleOp` (exhaustive) | Bump | Major |
| New method on `Engine` or `Driver` without a default | Bump | Major |
| Changed unit or meaning of a field | Bump | Major |
| New variant in a `#[non_exhaustive]` enum (`Command`, `Event`, `HistoryEvent`, `Refusal`, …) | No | Minor |
| New optional field in a non-exhaustive struct, new helper function | No | Minor |
| Bug fix with no API change | No | Patch |
| New device variant or command support in a driver | No | Minor (driver) |
| Protocol fix in a driver | No | Patch (driver), with a changelog entry describing the device-visible effect |

Before 1.0, minor versions may break (`0.x` semver), but the contract version MUST still be bumped on every incompatible contract change.

## Dependency pinning

**Current:** crates depend on each other by git branch (`branch = "main"`). That is fine for early development but means a push to `pump-shared` can break every driver at once.

**Proposal for 1.0:**

1. Tag releases (`v0.2.0`) in every repository and depend on tags (`tag = "v0.2.0"`) or, later, on crates.io versions.
2. Keep `Cargo.lock` committed in drivers' CI and in bindings.
3. Run the cross-repository `tester` job against `pump-shared@main` nightly, so contract changes are seen before release.

## Releases

Each release MUST have:

- a `CHANGELOG.md` entry, separating **device-visible behaviour changes** (what a pump will now receive differently) from API changes;
- CI green on the tagged commit;
- for drivers, the list of `.docs/to-confirm.md` items still open.

Apps pin exact driver versions. Updating a driver in an app is an explicit, reviewed change.
