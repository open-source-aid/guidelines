# 1. Principles

## Goals

1. **One implementation per device protocol**, shared by every AID app.
2. **Apps keep only the platform-specific parts.** The Rust driver contains everything that would otherwise be written twice.
3. **Every driver is testable without hardware**, in CI, with faults injected at every step.
4. **The same driver binary logic runs on a phone, a desktop test runner and a microcontroller** (the contract is `no_std`).

## Non-goals

- **No dosing logic.** Drivers do not know about OpenAPS/oref, Loop's algorithm, or any other controller. They carry out commands and report what happened.
- **No app data model.** Drivers do not know about Nightscout treatments, AAPS `PumpSync` records or LoopKit `DoseEntry`s. Mapping to those is the adapter's job ([13-app-integration.md](13-app-integration.md)).
- **No UI.** Pairing screens, alerts and strings belong to the app.

## Requirements

| # | Requirement | Level | How it is met |
|---|---|---|---|
| R1 | Total isolation from the dosing algorithm (no oref awareness) | MUST | Drivers depend only on the shared contract; commands are plain device operations (`Bolus`, `TempBasal`, …) |
| R2 | No dependencies on other drivers | MUST | A driver crate depends on `pump-shared` (and future shared crates) only, never on another `pump-*` / `cgm-*` crate |
| R3 | Shared utilities where possible, without duplication | SHOULD | Common logic lives in shared crates ([03](03-repositories-and-crates.md#shared-crates)). Sharing is encouraged, not forced: a driver MAY keep its own version when the shared one does not fit, and SHOULD say why in a comment |
| R4 | Versioned API | MUST | `API_VERSION` constant, semver, `DriverInfo::is_compatible` ([12](12-versioning-and-releases.md)) |
| R5 | Every driver is a state machine | MUST (public API) | The `Engine` trait is a poll-based state machine ([05](05-state-machines.md)) |
| R6 | Drivers are synchronous | MUST (public API) | No `async`, threads, executors or blocking calls cross the API boundary ([05](05-state-machines.md#synchronous-execution)) |
| R7 | Simple | SHOULD | One contract, few types, integer units, no generic frameworks inside drivers |
| R8 | No platform-specific dependencies | MUST | `no_std` + `alloc`; CI builds for `thumbv7em-none-eabihf` as proof ([09](09-dependencies-and-licensing.md)) |
| R9 | Standard or reputable libraries only | MUST | Dependency criteria in [09](09-dependencies-and-licensing.md) |
| R10 | Testable end to end with real or synthetic data, simulatable, hookable into a harness, CI-ready | MUST | [10-testing-and-ci.md](10-testing-and-ci.md), [11-simulators.md](11-simulators.md) |
| R11 | 100 % code coverage | MUST | 100 % of lines, regions and functions in every crate, as the current repositories already enforce; hardware-bound code excluded only behind a documented feature; mutation testing on top ([10](10-testing-and-ci.md#coverage)) |

## Why Rust

| Property | What it buys a driver |
|---|---|
| Memory safety without a garbage collector | No use-after-free or buffer overruns in packet parsers, which handle untrusted radio input. All crates use `#![forbid(unsafe_code)]` |
| Low level and `no_std` | The same crate runs in an Android/iOS app, a desktop tester, and firmware on an nRF52840 (the hardware simulator does exactly that) |
| Performance and predictability | No GC pauses; small, bounded allocations |
| Strong types and exhaustive `match` | Units are distinct types (`InsulinAmount`, `BasalRate`); a new `Action` variant fails to compile in every host until it is handled |
| Crates and features | Clean isolation: a driver is a crate, its simulator a feature, delivery support a feature |
| Verification tooling | Formal and bounded verification is available through external tools such as [Kani](https://github.com/model-checking/kani) (bounded model checking), [Creusot](https://github.com/creusot-rs/creusot), [Prusti](https://github.com/viperproject/prusti-dev) and [Verus](https://github.com/verus-lang/verus). Rust does not prove anything on its own; these tools make proofs practical for small, pure functions such as codecs, CRCs, counter policies and `Bounds` arithmetic ([10](10-testing-and-ci.md#formal-verification)) |
| Bindings | Kotlin and Swift bindings can be generated (for example with UniFFI), so the wrappers stay thin ([13](13-app-integration.md)) |

## Design rules that follow

- **Integers in the smallest unit, no floating point** in any value that describes insulin or time.
- **Glucose is always `u16` mg/dL** across the driver interface. Apps convert to and from mmol/L ([06](06-data-model.md#glucose)).
- **Unknown is `None`**, never a guess.
- **Refuse rather than round.** A driver never changes a requested dose; rounding policy belongs to the app adapter.
- **Report uncertainty.** If a command may or may not have reached the device, the outcome is `Unknown` and it is never retried automatically.
- **Prefer deleting code to adding options.** A setting that only one app needs belongs in that app's adapter.
