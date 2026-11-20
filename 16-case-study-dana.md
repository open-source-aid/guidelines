# 16. Case study: Dana

The Dana pumps (Sooil DanaR, DanaRS, Dana-i) are a good worked example because the same protocol is implemented today in **two production apps**, independently, and the two copies disagree. This chapter walks through both, shows how each part maps onto the guideline, and sketches a `pump-dana` crate.

Sources read:

| App | Path | Language | Licence |
|---|---|---|---|
| AndroidAPS | `AndroidAPS/pump/dana/` (`common`, `danar`, `danars`, plus `emulator` modules) | Kotlin | AGPL-3.0 |
| Trio / Loop | `Trio/DanaKit/` (a port of [danars-js](https://github.com/bastiaanv/danars-js)) | Swift | MIT |

So the DanaRS protocol exists at least three times: Kotlin, Swift and JavaScript. The encryption alone is about 690 lines in AAPS (`BleEncryption.kt`) and about 880 lines in DanaKit (`DanaKit/Encryption/*.swift`).

## 1. Variants map onto one driver

| Model / generation | Transport | Security | AAPS | DanaKit |
|---|---|---|---|---|
| DanaR, DanaRv2, DanaR Korean | Bluetooth Classic (RFCOMM serial) | — | `danar` module | not supported |
| DanaRS (v1) | BLE | Pump password, time info | `danars` | yes |
| DanaRS v3 | BLE | Pairing key + random pairing key typed in from the pump screen; rolling sync key | `danars` (`ENCRYPTION_RSv3`) | yes |
| Dana-i | BLE 5 | 6-digit key sent during the handshake, OS bonding | `danars` (`ENCRYPTION_BLE5`) | yes |

In the guideline this is **one crate, `pump-dana`**, with each BLE generation as a `Variant` (`dana-rs`, `dana-rs-v3`, `dana-i`). The encryption type is detected from the `PUMP_CHECK` reply, so it is engine state, not configuration.

DanaR uses Bluetooth Classic, which the current `BleOp` set does not cover. See [Q13](14-open-questions.md#q13-transports-other-than-ble-gatt).

## 2. The auxiliary-input problem, concretely

The group's example ("DanaRS uses the last packet's last payload byte to build the next payload") is the v3 **random sync key**. Both apps implement it the same way:

1. **Seed.** The last byte of the decrypted `PUMP_CHECK` reply is saved as the sync key. AAPS: `BLEComm.kt` around line 512 writes it to `preferences` (`V3RandomSyncKey`). DanaKit: `PeripheralManager.swift` around line 453 writes it to `pumpManager.state.randomSyncKey`.
2. **Derive.** `setPairingKeys(pairingKey, randomPairingKey, randomSyncKey)` turns the saved byte into the working key (`decryptionRandomSyncKey`), or derives a fresh one from the pairing key if none is saved (`initialRandomSyncKey`).
3. **Chain.** In `encryptSecondLevelPacket`, every output byte becomes the new sync key (`randomSyncKey = array[i]`), so every byte of every packet depends on all the bytes before it. Decryption does the same on the receive side.
4. **Persist.** The key has to be correct across reconnects, so both apps store it in their own app storage, and AAPS deletes it on some disconnect paths.

### How it maps to the contract

| Piece | Today (both apps) | In `pump-dana` |
|---|---|---|
| Seed byte | App code reads the reply and writes app preferences/state | Engine reads it from the `BleResult::Data` / `Notification` it already receives |
| Chaining | Mutable field in the encryption class | Private engine state |
| Persistence | `preferences` (AAPS), `PumpManagerState` raw value (DanaKit) | `Action::Store { slot: Slot::Session, class: Class::Secret }` **before** the next write that depends on it (E6) |
| Pairing key, random pairing key, BLE5 key | App preferences / state | `Slot::Session`, `Class::Secret` |
| Device name (used in first-level encoding) | Passed in by the app on every packet | Taken from the advertisement at `Pair` and stored with the session |

The result: **nothing about the rolling byte appears in the interface.** No app can get it wrong, because no app sees it. This is the general rule in [07](07-platform-boundary.md#auxiliary-inputs): input derived from the link is engine state.

### The input that does need the interface: pairing codes

DanaRS v3 pairing needs input from the user in the middle of the handshake. The pump shows two codes on its screen and the user types them into the app:

- AAPS: `PairingStep.WAITING_FOR_PIN`, then `DanaRSPairWizardViewModel.submitPin()` checks `pin1` (12 hex digits) and `pin2` (8 hex digits, the last two a checksum) and calls `bleComm.finishV3Pairing()`.
- DanaKit: `promptPincode(nil)` completes with `.requestedPincode`, then `finishV3Pairing(pairingKey, randomPairingKey)`.
- The older v1 flow has two more mid-flow steps: `WAITING_FOR_PAIRING_CONFIRM` (press OK on the pump) and `WAITING_FOR_PASSWORD`.

Both apps implement the checksum validation separately, in UI code. With the proposed `Event::InputRequired` ([Q1](14-open-questions.md#q1-a-unified-interface-for-auxiliary-inputs)):

```
engine ─► Event::InputRequired { kind: DisplayedCodes { fields: [12 hex, 8 hex] } }
app    ─► shows its own UI
app    ─► engine.provide_input(Input::Codes(["0A1B…", "…"]))
engine ─► validates the checksum itself; on failure emits InputRequired again with an error
       ─► otherwise derives keys, emits Action::Store for the session, continues the handshake
```

`ConfirmOnDevice` (press OK on the pump) becomes an `InputRequired` kind with no fields, so the app can show "Confirm on your pump". The checksum, key derivation and storage are written once, in the driver.

## 3. Limits: the same pump, two different answers

Dana pumps only accept a temp basal as a **percentage of the scheduled rate**, with special rules per duration. The two apps convert an absolute rate from the algorithm into a Dana command differently:

| Question | AndroidAPS (`DanaRSPlugin.kt`, `PumpType.DANA_RS`) | DanaKit (`DanaKitPumpManager.swift`) |
|---|---|---|
| Absolute → percent | Below 0.10 U/h → 0 %; otherwise truncated, then rounded **up** to 10 % below 100 % and **down** to 10 % at or above 100 % | `round(absolute / scheduled × 100)`, 1 % resolution |
| Scheduled rate used | `danaPump.currentBasal` (from the pump) | The phone's local clock, picking one of 24 hourly segments |
| Maximum percent | 500 % (special APS command); `maxTempPercent` 200 for normal temp basals | 500 % |
| Duration | High temps use the APS command at a fixed 15 min, low temps 30 min, whatever duration was asked (0 % for more than 30 min uses the hourly command) | Rounded **down** to whole hours, 30 min or 15 min; above 200 % forced to 15 min; below 15 min refused |
| Scheduled basal range shown to the algorithm | `baseBasalMinValue` 0.04, step 0.01 | Was a static 0.00–3.00 U/h table (fixed to 0.04–3.30 in `dana-scheduled-basal-rate-range-pr.md`) |

The same request from the algorithm therefore produces a different command on the same pump depending on the app. Trio's notes show what this costs:

- `dana-supportedBasalRates-issue.md`: the static table was used by oref as the **temp-basal ceiling**, capping every Dana temp basal at about 3 U/h whatever the scheduled basal.
- `trio-dana-temp-basal-ceiling-pr.md`: the fix adds `pumpManager as? DanaKitPumpManager` in `APSManager.swift`. The algorithm layer now has to know about one specific driver, which is exactly what R1 (isolation) is meant to prevent.

### How the guideline handles it

1. **The driver reports what the device accepts**, in `Limits`:

   | Field | Dana value |
   |---|---|
   | `basal` | `Bounds { min: 40, max: 3300, tiers: [{ from: 0, step: 10 }] }` mU/h (0.04–3.30 U/h) |
   | `temp_basal_percent` | `Some(Bounds { min: 0, max: 500, … })`, step per the device (10 % or 1 %, see below) |
   | `temp_basal_absolute` | `None`: the pump has no absolute temp basal |
   | `temp_basal_duration` | Tiers `{ from: 15 min, step: 15 min }`, `{ from: 30 min, step: 30 min }`, `{ from: 60 min, step: 60 min }`, max 24 h: allows exactly 15 min, 30 min and whole hours |

2. **The adapter converts.** Loop and Trio only speak absolute rates, so the adapter converts with `BasalRate::percent_of(scheduled)` from the active profile and works out the ceiling from `temp_basal_percent.max`. No `as? DanaKitPumpManager` is needed, and the same adapter code works for any other percent-only pump.

3. **The driver never silently changes a request.** DanaKit turns a 2 h, 250 % request into a 15 min temp basal and only logs it. Under the contract that is either `Refused(OutOfLimits)` (nothing sent) or, if the group wants the driver to fall back, `Approximated(..)` carrying both the request and what was set. Either way the caller is told.

4. **Device facts live in the driver; policy lives in the adapter.** The 500 % / 15-minute APS command and the rule that basal below 0.10 U/h is delivered once an hour are facts about the pump. Rounding up below 100 % and down above it is an AAPS policy choice.

Two things the shared model cannot express yet:

- **Coupled limits.** Above 200 % is only allowed with a 15-minute duration. `Limits` has independent ranges for percent and duration. See [Q14](14-open-questions.md#q14-coupled-limits).
- **Percent step.** AAPS sends 10 % steps and DanaKit sends 1 %. Which one the pump really honours belongs in `pump-dana/.docs/to-confirm.md` with a bench test, the same way `pump-ypso` tracks its open questions.

## 4. Safety and testing observations

| Observation | Guideline rule |
|---|---|
| DanaKit logs the pairing key and random pairing key in clear text (`PeripheralManager.swift`, "Setting encryption keys…" and "Storing security keys…"). AAPS wraps them in `secret(..)` | S10: secrets are `Secret`, never logged |
| AAPS's DanaRS emulator (`EmulatorBleTransport.kt`) uses the same `BleEncryption` class on the pump side as the app side. A bug in it is mirrored on both sides and tests still pass | [11](11-simulators.md#where-a-device-simulator-lives): counter with known-answer vectors from real pumps |
| AAPS has commented-out logic to clear pairing keys after an unanswered handshake (`BLEComm.kt` around line 180) | Recovery from a stale session belongs in the engine (`EngineState::KeyRejected`), and the host or user decides whether to re-pair |
| Both apps keep the rolling key in general app storage | `Class::Secret` tells every host to use the keychain or keystore |
| DanaKit has byte-exact encryption tests (`DanaKitTests/Encryption/EncryptTests.swift`, e.g. the `PUMP_CHECK` packet). AAPS has `BleEncryptionTest.kt` and per-packet tests in `danars/src/test/.../comm/` | Reuse both as **known-answer vectors** in `pump-dana/tests/crypto_vectors.rs`. A vector that passes in Kotlin and Swift but not in Rust shows exactly which copy is wrong |
| AAPS already has a full DanaRS pump emulator with history (`PumpEmulator.kt`, `PumpState.kt`, `HistoryEventStore.kt`) | Port its behaviour into `pump-dana/src/sim` as a `SimDevice`, so it runs in `tester` and on the nRF52840 board |

## 5. Sketch of `pump-dana`

```
pump-dana/
├── NOTICE.md            credits AAPS (AGPL-3.0), DanaKit (MIT, Randall Knutson), danars-js
├── .docs/
│   ├── protocol.md      opcodes, packet layout, the three encryption generations
│   └── to-confirm.md    percent step, >200 % rules, sub-0.10 U/h behaviour, …
├── src/
│   ├── driver.rs        DriverInfo: variants dana-rs, dana-rs-v3, dana-i; slots Session/Secret
│   ├── protocol/
│   │   ├── packet.rs    start/end markers, length, CRC (generateCrc)
│   │   ├── crypto/
│   │   │   ├── first.rs     device-name, time, password, passkey encoding
│   │   │   ├── rsv3.rs      second level + rolling sync key
│   │   │   └── ble5.rs      second level with the BLE5 key matrix
│   │   └── opcodes.rs   BASAL_*, BOLUS_*, APS_*, HISTORY_*, NOTIFY_*
│   ├── engine/
│   │   ├── handshake.rs PUMP_CHECK → (password | passkey | pairing codes | BLE5) → TIME_INFORMATION
│   │   ├── commands.rs  Command → opcode sequence; percent/duration selection
│   │   ├── history.rs   APS history events → HistoryEvent
│   │   └── store.rs     session slot layout and versioning
│   └── sim/             DanaRS SimDevice (from the AAPS emulator's behaviour)
└── tests/
    ├── crypto_vectors.rs   vectors from DanaKit and AAPS tests, plus real captures
    ├── engine.rs
    └── e2e.rs              tester-harness sweeps
```

## 6. Migration path

1. **Vectors first.** Collect every byte-exact vector from both apps' tests, add captures from a real DanaRS v3 and a Dana-i, and make `protocol/` pass all of them.
2. **Read-only engine.** Handshake, status, history, basal profile. Run it in AAPS and Trio side by side with the existing driver and compare decoded status and history.
3. **Simulator.** Port the AAPS emulator's behaviour, add the scenarios to `tester`, and run them on the nRF52840 board.
4. **Stop paths, then delivery** behind the `delivery` feature, with the open limits questions settled on the bench.
5. **Thin wrappers.** Replace `BLEComm.kt` / `BleEncryption.kt` / `DanaRSPlugin` internals and `PeripheralManager.swift` / `DanaKitEncryption` / `DanaKitPumpManager` internals with the binding. Keep each app's pairing UI and `PumpSync` / `PumpManager` mapping.
