# 15. New driver checklist

Use this for a new driver and as the review checklist for a driver pull request.

## Repository

- [ ] Named `pump-<manufacturer>` / `cgm-<manufacturer>` / `uploader-<service>`; crate name matches the repository
- [ ] `LICENSE` (AGPL-3.0-or-later) and `NOTICE.md` (derivation, third-party crates, trademarks)
- [ ] `.docs/` with protocol notes and sources, and `to-confirm.md` listing unconfirmed behaviour with its bench test
- [ ] Layout follows [03](03-repositories-and-crates.md#driver-crate-layout): `protocol/`, `engine/`, `sim/`, `driver.rs`

## Contract

- [ ] One `static DRIVER` implementing `Driver`
- [ ] `DriverInfo` declares every GATT characteristic, every notification, every storage slot and class, every command, every feature
- [ ] `api_version: pump_shared::API_VERSION`
- [ ] `Engine` follows E1–E10 in [04](04-driver-contract.md#rules-for-engines)
- [ ] Therapy state changed only through shared `Transition`s; `LinkLost` and `Observed` applied
- [ ] `Limits` and `Capabilities` read from the device where possible; hard-coded values cite a source
- [ ] Every glucose value in and out is `u16` mg/dL; device mmol/L converted at the protocol boundary, no sentinel values
- [ ] Auxiliary inputs handled per [07](07-platform-boundary.md#auxiliary-inputs); no protocol internals in the interface

## Safety ([08](08-safety.md))

- [ ] Delivery commands behind `delivery`; stop paths not gated
- [ ] No rounding of doses; `OutOfLimits` instead
- [ ] `Unknown` on uncertain delivery, never retried; timed-out writes never resent unchanged
- [ ] Counters/nonces stored before use; secrets as `Secret`, never logged
- [ ] `#![forbid(unsafe_code)]`; no panics on radio input

## Dependencies ([09](09-dependencies-and-licensing.md))

- [ ] `no_std` + `alloc`; builds for `thumbv7em-none-eabihf` with `--no-default-features` and with each feature
- [ ] Depends on shared crates only, never on another driver
- [ ] Each external crate justified, reputable, `no_std`, licence-compatible

## Tests ([10](10-testing-and-ci.md))

- [ ] Unit tests in every module
- [ ] Known-answer vectors from real captures for framing and crypto
- [ ] Engine tests for every command, refusal and outcome
- [ ] Device simulator (`sim` feature) implementing `SimDevice` (and `Simulator` for the board), with its own tests
- [ ] End-to-end tests through `tester-harness` with timeout, disconnect, status and host-failure sweeps at every step
- [ ] Scenarios added to `tester` for `--target sim` and `--target ble`
- [ ] 100 % line, region and function coverage; any exclusion behind a documented feature
- [ ] No surviving mutants (`cargo mutants`) in protocol, crypto, counters, engine or delivery code
- [ ] CI: fmt, clippy `-D warnings`, bare-metal builds, coverage gate

## Release ([12](12-versioning-and-releases.md))

- [ ] `CHANGELOG.md` separates device-visible changes from API changes
- [ ] Tagged release; dependents pin the tag
