# 2. Architecture

## Layers

```
┌───────────────────────────────────────────────────────────────────────┐
│ AID app (AAPS, Trio, Loop)                                            │
│   algorithm (oref, Loop) · UI · treatment storage · Nightscout sync   │
├───────────────────────────────────────────────────────────────────────┤
│ App adapter (Kotlin / Swift, per app)                                 │
│   PumpManager / PumpSync mapping · rounding policy · unit conversion  │
├───────────────────────────────────────────────────────────────────────┤
│ Host runtime (Kotlin / Swift, per platform; Rust for tests/firmware)  │
│   BLE central · keychain/keystore · storage · RNG · timers · clock    │
├────────────────────────── FFI binding ────────────────────────────────┤
│ Driver crate (Rust, per device family)       pump-ypso, cgm-…, …      │
│   protocol · framing · crypto · counters · engine · simulator (sim)   │
├───────────────────────────────────────────────────────────────────────┤
│ Shared contract (Rust)                       pump-shared              │
│   Driver / Engine traits · Action / Completion · Command / Outcome    │
│   data model · Limits · TherapyState machine · SimDevice              │
└───────────────────────────────────────────────────────────────────────┘
```

Dependencies only point down. A driver never depends on another driver, a host, or an app.

## The sans-IO model

A driver engine never touches the radio, the disk, the clock or the random number generator. It is a state machine that:

1. accepts **commands** from the app (`submit`, `stop`);
2. emits **actions** for the host to perform (`poll_action`): a BLE operation, a storage read or write, a key wrap, a key agreement, random bytes;
3. accepts **completions** for those actions (`handle_completion`), **notifications** from the device (`handle_notification`), **time** (`handle_timeout`, `handle_wall_clock`) and **link loss** (`handle_link_lost`);
4. emits **events** for the app (`poll_event`): command started, progress, finished with an `Outcome`, device info, state changes, therapy changes, log lines;
5. tells the host when it next wants to be woken (`poll_timeout`).

```
            submit(Command) ──────────────►┌──────────┐
                                           │          │── poll_action() ──► Action ──► host performs it
 handle_completion(OpId, Completion) ─────►│  Engine  │
 handle_notification / timeout / clock ───►│          │── poll_event() ───► Event ───► adapter / app
                                           └──────────┘── poll_timeout() ─► when to wake next
```

Why sans-IO:

- **Portability.** BLE, storage and crypto APIs differ on every platform; the protocol does not.
- **Determinism.** Given the same inputs, an engine produces the same outputs. Tests replay exact transcripts.
- **Testability.** The harness ([11](11-simulators.md)) plays the host: it answers actions from a simulated device, injects faults at any step, and controls virtual time.
- **Safety review.** All protocol decisions live in one crate that can be audited without platform noise.

## Who owns what

| Concern | Owner | Notes |
|---|---|---|
| Packet layout, framing, CRC, opcodes, encryption, counters, nonces | Driver | Including state derived from earlier packets ([07](07-platform-boundary.md#auxiliary-inputs)) |
| Command sequencing, retries that are safe, timeouts between protocol steps | Driver | Uses `poll_timeout`; never sleeps |
| Decoding history, status, limits, capabilities into the shared model | Driver | |
| Device simulator for that protocol | Driver, `sim` feature | [11](11-simulators.md) |
| BLE scanning, connecting, GATT I/O, bonding, MTU, background execution | Host | Driven by `BleOp`; scanning uses `DriverInfo.ble` / `Driver::matches` |
| Persistent storage, secure key storage, key wrapping | Host | Driven by `Action::Store/Load/Erase/Wrap/Unwrap`; the `Class` tells the host how to store it |
| Randomness, key agreement against server keys | Host | `Action::Random`, `Action::KeyAgree` |
| Monotonic time and wall-clock time | Host | `handle_timeout`, `handle_wall_clock` |
| Unit conversion to app types, rounding to the grid, app records | Adapter | [13](13-app-integration.md) |
| What to deliver and when | App | Never the driver |

## One host, many drivers

The host runtime is written once per platform and works for every driver, because every driver speaks the same `Action`/`Completion` vocabulary. Adding a device to an app means: add the driver crate to the binding, register it in the driver list, and write (or extend) the app adapter. No new BLE code.
