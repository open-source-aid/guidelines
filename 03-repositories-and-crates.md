# 3. Repositories and crates

## Repository types

| Type | Name pattern | Contains | Example |
|---|---|---|---|
| Shared contract | `<kind>-shared` | Traits, types, state machines, the data model; no device code | `pump-shared` |
| Pump driver | `pump-<manufacturer>[-<model>]` | One device family's protocol, engine and simulator | `pump-ypso` |
| CGM driver | `cgm-<manufacturer>[-<model>]` | Same, for a CGM | `cgm-dexcom-g7` (future) |
| Uploader | `uploader-<service>` | Upload and download of data to a remote service, sans-IO over HTTP | `uploader-nightscout` (future) |
| Simulator host | `simulator` | Device-agnostic BLE peripheral bridge and firmware that hosts any device simulator | `simulator` |
| Device simulator (optional) | `simulator-<manufacturer>` | Only when a simulator is too large for, or independent of, its driver ([11](11-simulators.md#where-a-device-simulator-lives)) | |
| Test tooling | `tester` | Harness, real-BLE central, scenario runner | `tester` |
| Bindings (Proposal) | `bindings` | FFI layer that exposes all drivers to Kotlin and Swift ([13](13-app-integration.md)) | |

Rules:

- One device family per driver repository. A family is a set of models that share one protocol; models within it are `Variant`s, not separate repositories.
- The repository name and the crate name MUST match.
- Uploaders are named after the service, not a manufacturer.

## Shared crates

**Current.** `pump-shared` holds everything: the generic host contract (`Engine`, `Action`, `BleOp`, `Slot`, `Secret`) and the pump-specific model (`Command`, `TherapyState`, `Limits`). `Kind::Cgm` exists, but there is no CGM data model yet.

**Proposal.** Before the first CGM driver, split by concern:

| Crate | Contents |
|---|---|
| `device-shared` (name to decide) | `Engine`-style host contract: `Action`, `Completion`, `BleOp`, `Notification`, `Slot`, `Class`, `Secret`, `KeyRef`, `Timestamp`, `UtcTime`, `DriverInfo`, `SimDevice`, `API_VERSION` |
| `pump-shared` | Pump commands, outcomes, therapy state machine, limits, history; re-exports `device-shared` |
| `cgm-shared` | Glucose readings, sensor/transmitter state, calibration, warm-up, trend |
| `uploader-shared` | Upload records and an HTTP-shaped action set |
| `proto-util` (optional) | Codec helpers several drivers need: CRC variants, little-endian readers, frame reassembly, AES/ChaCha wrappers |

A utility moves into a shared crate when a **second** driver needs it, not before. Shared utilities MUST have no knowledge of any specific device.

## Driver crate layout

Follow the reference driver. Modules are split by responsibility so each can be tested on its own:

```
pump-<manufacturer>/
├── Cargo.toml
├── LICENSE                    AGPL-3.0-or-later
├── NOTICE.md                  derivation, third-party code, trademarks
├── .docs/                     protocol notes, open bench questions (to-confirm.md)
├── .github/workflows/ci.yml
├── src/
│   ├── lib.rs                 #![no_std] (unless std), #![forbid(unsafe_code)], public re-exports
│   ├── driver.rs              static DriverInfo, impl Driver
│   ├── protocol/              pure, stateless: uuids, characteristic, framing, crypto, units, errors
│   ├── counters.rs            nonce / counter / epoch policy (if the protocol has one)
│   ├── engine/                the Engine: link setup, commands, delivery, history, storage, IO glue
│   └── sim/                   #[cfg(feature = "sim")] device simulator implementing SimDevice
└── tests/
    ├── crypto_vectors.rs      known-answer vectors from real captures
    ├── engine.rs              engine against scripted completions
    ├── e2e.rs                 engine against the simulator through tester-harness, with fault sweeps
    └── sim/                   simulator behaviour on its own
```

- `protocol/` MUST be pure functions and plain data. No engine state, no I/O.
- `engine/` is the only place that holds session state.
- `sim/` MUST NOT be compiled without the `sim` feature, so simulator code never ships in an app.

## Feature flags

| Feature | Meaning | Rule |
|---|---|---|
| `std` (default) | Builds with `std` | Everything MUST also build with `--no-default-features` |
| `sim` | Builds the device simulator | Off in app builds |
| `delivery` | Enables commands that deliver insulin (`Bolus`, `TempBasal`, `ExtendedBolus`, `SetBasalProfile`, …) | Off by default. Stop paths MUST NOT be behind it ([08](08-safety.md)) |
| Protocol variants | e.g. `opn` for YpsoPump without CryptoService | Named after the variant |

Enabled features are reported at runtime through `DriverInfo.features`, and the accepted commands through `DriverInfo.commands`, so a host can see exactly what was compiled in.
