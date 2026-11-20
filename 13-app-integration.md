# 13. App integration: bindings and thin wrappers

The goal is that the existing drivers in AAPS and Trio become thin wrappers around the Rust drivers. This chapter describes the target shape.

## Three pieces on the app side

| Piece | Language | Written | Contents |
|---|---|---|---|
| **Bindings** | Rust + generated Kotlin/Swift | Once for all drivers | Exposes `Driver`, `Engine`, `Command`, `Event`, `Action`, `Completion` and the data model across FFI |
| **Host runtime** | Kotlin (Android), Swift (iOS) | Once per platform | Performs `Action`s: BLE (Android BLE / CoreBluetooth), storage, keystore/keychain, RNG, timers; runs the host loop ([04](04-driver-contract.md#host-loop)) |
| **App adapter** | Kotlin (AAPS), Swift (Trio/Loop) | Once per app, mostly device-independent | Implements the app's pump interface on top of `Engine` |

Only the adapter knows the app. Only the host runtime knows the OS. Neither knows any device protocol.

## Bindings (Proposal)

[UniFFI](https://github.com/mozilla/uniffi-rs) is the likely choice: it generates Kotlin and Swift from Rust and is used in production by Mozilla and others. The current contract needs a thin FFI-friendly layer on top, because:

- `&'static DriverInfo` and `Box<dyn Engine>` must become handle objects;
- `Action`/`Completion` with `Vec<u8>` and `Secret` must become records (and `Secret` must still be zeroised on the Rust side);
- generics such as `Bounds<T>` must be monomorphised per unit.

The binding crate is a single library that statically links every driver the app ships, with a `drivers()` registry. Each app chooses which drivers and which features (`delivery`) to include at build time.

Rules:

- The bindings MUST NOT add logic. If something is needed by both Kotlin and Swift, it belongs in Rust.
- The host loop runs on one serial queue/thread per engine. The engine is not `Sync` and MUST NOT be called concurrently.

## App adapters

The per-app mapping tables already exist in `pump-shared`:

- [AndroidAPS](https://github.com/u-osaid/pump-shared/blob/main/.docs/integration/aaps.md)
- [Loop](https://github.com/u-osaid/pump-shared/blob/main/.docs/integration/loop.md)
- [Trio](https://github.com/u-osaid/pump-shared/blob/main/.docs/integration/trio.md) (on top of Loop)

Key adapter duties, all app-specific and therefore not in the driver:

| Duty | AAPS | Loop | Trio |
|---|---|---|---|
| Unit conversion | `mU / 1000.0` → `Double` | `mU / 1000.0` → `Double` | `Decimal(mU) / 1000`, never via `Double` |
| Glucose units | mmol/L ↔ mg/dL (`u16`) at the UI edge, once | same | same |
| Rounding before `submit` | `Bounds::nearest` | `Bounds::floor` | `Bounds::floor` |
| Temp basal style | Percent or absolute, per pump | Absolute only; convert with the active profile | Absolute, stored |
| `Outcome::Unknown` | `PumpEnactResult(success = false)`, no retry | `uncertainDelivery`, no retry | as Loop |
| History identity | `pumpId = sequence`, `pumpSerial = serial` | `syncIdentifier = sync_id` | as Loop |

## Migrating an existing driver

1. **Port the protocol to Rust** as a driver crate, with vectors captured from the existing app driver and the real device.
2. **Run both side by side in tests**: replay the existing driver's captured sessions against the Rust simulator and engine.
3. **Write the adapter** inside the app, behind a build flag, keeping the old driver.
4. **Bench and pilot** with the Rust driver in non-delivery mode first (status, history), then delivery.
5. **Remove the old protocol code** from the app; keep the adapter.

## What app teams get

- Device protocol bugs are fixed once, in one place, and every app picks up the fix by bumping a version.
- A new device becomes available in every app once its driver exists; each app writes no device code.
- Every driver comes with a simulator, so app CI can run against a simulated pump without hardware.
