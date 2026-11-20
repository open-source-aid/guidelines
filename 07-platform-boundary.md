# 7. The platform boundary

Where to draw the line between driver code and platform code is the question that decides whether wrappers stay thin. This chapter gives a rule, a table, and a proposal for auxiliary inputs.

## The rule

Ask three questions about any piece of code, in order:

1. **Would two apps on different platforms have to write the same logic for this device?** → **Driver.**
2. **Does it call an operating-system API (radio, keystore, file system, clock, RNG, notifications, background scheduling)?** → **Host**, reached through an `Action`.
3. **Does it depend on one app's data model, algorithm, settings or UI?** → **Adapter** (or the app).

If the answer to 1 is yes, it goes in the driver even if it is awkward. The point of the project is that protocol knowledge exists once.

## Classification

| Item | Driver | Host | Adapter / app |
|---|:-:|:-:|:-:|
| Packet formats, framing, CRC, opcodes | ✔ | | |
| Encryption, key derivation, counters, nonces | ✔ | | |
| Which bytes depend on earlier packets (rolling bytes, sequence numbers, session tokens) | ✔ | | |
| Order of protocol steps, safe retries, protocol timeouts | ✔ | | |
| Decoding status, history, limits, alarms into shared types | ✔ | | |
| Advertisement matching rules (`BleMatch`) | ✔ (declares) | ✔ (scans) | |
| BLE scan, connect, GATT discovery, bonding, MTU, connection priority | | ✔ | |
| Retrying a dropped connection, backoff | | ✔ | |
| Storing bytes, keystore wrap/unwrap | | ✔ | |
| Secure random numbers, wall clock, monotonic clock | | ✔ | |
| Running in the background (Android foreground service, iOS BLE background mode) | | ✔ | |
| Rounding a dose to the device grid | | | ✔ |
| Converting milli-units to `Double`/`Decimal` | | | ✔ |
| Mapping history to `PumpSync`, `NewPumpEvent`, Nightscout | | | ✔ |
| Pairing screens, user prompts, localisation | | | ✔ |
| Deciding to bolus, temp basal, suspend | | | ✔ (algorithm) |
| Emulating a missing feature with device primitives (for example a rate-controlled bolus as micro-boluses on YpsoPump) | ✔ | | |
| Emulating a missing feature with an app policy (for example AAPS emulating suspend with a zero temp basal) | | | ✔ |

The last two rows show the distinction: emulation that is **about the device** is driver code, because every app would otherwise write it; emulation that is **about an app's model** is adapter code.

## Auxiliary inputs

Some protocols need input beyond the command itself. Example: DanaRS builds each new payload using the last payload byte of the previous packet. The question is how a unified interface handles these.

**Proposal: classify the input by where it comes from.** Each source already has, or gets, one place in the contract.

| Source of the input | Example | Mechanism |
|---|---|---|
| **The link itself** (earlier packets, notifications, handshake results) | DanaRS rolling byte, YpsoPump read/write counters, session tokens | **Private engine state.** The engine sees every completion and notification, so it already has the bytes. Nothing new in the interface |
| …and must survive a restart or reconnect | Counters, session keys, last sequence number | Persist with `Action::Store` into a declared slot (`Slot::Counters`, `Slot::NonceState`, `Slot::Session`, or `Slot::Driver(n)`); reload with `Action::Load` at start |
| **The host** (OS services) | Randomness, current time, key agreement with a server key, keystore | Existing `Action`s (`Random`, `KeyAgree`, `Wrap`, …) and `handle_wall_clock` |
| **The user, once** (shown on or entered into the device) | Pairing PIN or passkey shown on the pump screen, a transmitter ID, a sensor code | **Command parameter** where it is known up front (`Pair { address, server_key }`). If it is only needed mid-flow, see below |
| **The user, mid-flow** | Device shows a code only after the connection starts | **Proposal:** `Event::InputRequired { kind }` plus `Engine::provide_input(Input)`. The engine waits in a declared state; `stop()` cancels it |
| **Another device or service** | A CGM value a pump needs for its own display, a cloud token | Out of scope for drivers (R2: no dependencies between drivers). The app passes it as a command parameter if a protocol truly needs it |

The Dana case study walks through both halves of this with real code: the DanaRS v3 rolling sync key (link-derived, engine-private) and the pairing codes shown on the pump screen (user input mid-flow). See [16-case-study-dana.md](16-case-study-dana.md#2-the-auxiliary-input-problem-concretely).

Rules that follow:

- A driver MUST NOT expose protocol internals (rolling bytes, counters) as interface parameters. If an app could get them wrong, they belong inside the engine.
- Any state that changes what goes on the wire MUST be persisted before it is used (E6, E7 in [04](04-driver-contract.md)), so a crash or app restart cannot desynchronise the device.
- New input kinds are added to the shared contract, not invented per driver, so the host and UI code stays common.

## Grey areas

| Item | Recommendation |
|---|---|
| Reconnect policy (when to reconnect after a drop) | Host decides when; the driver states whether it needs a fresh session (`EngineState`) |
| Clock drift correction | Driver reports `drift(offset, now)`; the app decides when to `SyncClock` |
| Time zone | Host passes `utc_offset_secs` in `Config`; the driver only converts |
| Alarm acknowledgement | Driver command if the device supports remote acknowledgement; the app owns user-facing alerts |
| Logging | Driver emits `Event::Log`; host routes it to the platform logger |
