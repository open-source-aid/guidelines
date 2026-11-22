# OS-AID Unified Driver Guideline

**Status:** Draft for group review · **Applies to:** pump, CGM, uploader and simulator crates under `open-source-aid` · **Contract version:** `pump_shared::API_VERSION = 1`

## Why this exists

Every open-source AID app (AndroidAPS, Trio, Loop, …) carries its own copy of each device driver. The same protocol gets reverse-engineered, reimplemented and debugged two or three times, in Kotlin, Swift and sometimes Java, and each copy has its own bugs. This guideline describes one shared base instead:

- **Drivers are written once, in Rust**, as platform-free libraries.
- **Apps keep thin wrappers.** The existing drivers in Trio and AAPS become adapters around the Rust driver. The adapters do only what is platform-specific (the BLE stack, the keychain, the clock, the UI) or app-specific (mapping to `PumpManager`, `PumpSync`, …).
- **Every driver can be simulated and tested** in process, in CI, and over real BLE against a hardware simulator.

**Read it as one page:** https://open-source-aid.github.io/guidelines/ (built from this repository on every push to `main`).

## How to read this

The words **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT** and **MAY** follow [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119). Text marked **Proposal** is not yet agreed. Text marked **Current** describes what the repositories already do.

| # | File | Contents |
|---|---|---|
| 1 | [01-principles.md](01-principles.md) | Goals, non-goals, requirements, and why Rust |
| 2 | [02-architecture.md](02-architecture.md) | Layers, the sans-IO model, who owns what |
| 3 | [03-repositories-and-crates.md](03-repositories-and-crates.md) | Repository types, naming, crate layout, feature flags |
| 4 | [04-driver-contract.md](04-driver-contract.md) | `Driver`, `Engine`, actions, events, commands, outcomes |
| 5 | [05-state-machines.md](05-state-machines.md) | Engine, link and therapy state machines; synchronous execution |
| 6 | [06-data-model.md](06-data-model.md) | Units, configuration vs capabilities vs limits, history |
| 7 | [07-platform-boundary.md](07-platform-boundary.md) | What is driver-specific and what is platform-specific; auxiliary inputs |
| 8 | [08-safety.md](08-safety.md) | Insulin-delivery safety rules every driver follows |
| 9 | [09-dependencies-and-licensing.md](09-dependencies-and-licensing.md) | Allowed dependencies, `no_std`, licences, notices |
| 10 | [10-testing-and-ci.md](10-testing-and-ci.md) | Unit, vector, engine, end-to-end and hardware tests; coverage; CI |
| 11 | [11-simulators.md](11-simulators.md) | Device simulators, the universal harness, controls and generators |
| 12 | [12-versioning-and-releases.md](12-versioning-and-releases.md) | API versioning, semver, dependency pinning |
| 13 | [13-app-integration.md](13-app-integration.md) | Bindings and thin wrappers for AAPS, Trio and Loop |
| 14 | [14-open-questions.md](14-open-questions.md) | Decisions the group still has to make |
| 15 | [15-new-driver-checklist.md](15-new-driver-checklist.md) | Checklist for a new driver or a review |
| 16 | [16-case-study-dana.md](16-case-study-dana.md) | Worked example: the Dana drivers in AAPS and Trio mapped onto this guideline |
| A | [17-terminology.md](17-terminology.md) | Appendix: terminology, including variants vs feature flags vs capabilities |

## Reference repositories

| Repository | Role |
|---|---|
| [`pump-shared`](https://github.com/open-source-aid/pump-shared) | The shared contract: types, `Driver` / `Engine` traits, therapy state machine, data model ([`.docs`](https://github.com/open-source-aid/pump-shared/tree/main/.docs)) |
| [`pump-ypso`](https://github.com/open-source-aid/pump-yspo) | Reference driver: YpsoPump protocol, engine and simulator |
| [`simulator`](https://github.com/open-source-aid/simulator) | Device-agnostic BLE peripheral bridge and nRF52840 firmware that hosts any device simulator |
| [`tester`](https://github.com/open-source-aid/tester) | In-process harness, real-BLE central, and the `tester` scenario runner |

## Terminology

All technical terms (variant, feature flag, capabilities, limits, engine, host, adapter, sans-IO, slot, stop path, …) are defined in the [terminology appendix](17-terminology.md).

## Contributing

Edit the Markdown and open a pull request. The `pages` workflow builds the page on every pull request to catch broken output, and publishes it when the change lands on `main`. To preview locally:

```sh
cd site && npm ci && npm run build   # writes _site/index.html
```

Agents working on any open-source-aid crate should follow [CLAUDE.md](https://github.com/open-source-aid/guidelines/blob/main/CLAUDE.md), which summarises the rules in this guideline.
