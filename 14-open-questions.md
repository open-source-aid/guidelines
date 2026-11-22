# 14. Open questions

Decisions the group still has to make. Each has a proposal to react to.

## Q1. A unified interface for auxiliary inputs

*Example: DanaRS uses the last packet's last payload byte to build the next payload.*

**Proposal** ([07](07-platform-boundary.md#auxiliary-inputs)): classify by source. Link-derived values (DanaRS rolling byte, counters) are private engine state, persisted through storage slots when they must survive a restart; they never appear in the interface. Host services use existing actions. User input known up front is a command parameter. User input needed mid-flow gets a new shared pair: `Event::InputRequired { kind }` and `Engine::provide_input(input)`.

To decide: the `InputKind` list (PIN, passkey, transmitter ID, sensor code, confirmation), and whether `provide_input` is a new `Engine` method (contract version bump) or a `Command`.

## Q2. Where to draw the line between platform and driver

**Proposal** ([07](07-platform-boundary.md#the-rule)): the three-question rule. If two apps would write the same logic for a device, it is driver code. If it calls an OS API, it is host code. If it depends on an app's model, it is adapter code.

To decide: reconnect policy and background behaviour. Today they are entirely host-side; some devices (for example ones that drop the link after N seconds idle) may need the driver to say "keep alive" or "reconnect in N ms".

## Q3. Internal state machine style

The public API is a synchronous state machine either way. The question is whether drivers may use private `async` internally (as `pump-ypso` does) or must use explicit state enums.

**Proposal** ([05](05-state-machines.md#internal-style-explicit-enum-or-private-async)): allow both, with conditions on the `async` style (no runtime, safety state outside futures, clean drop). Revisit if formal verification of the protocol machine becomes a goal, since explicit enums are much easier to model-check.

## Q4. Coverage target (decided: 100 %)

The group first named 90 %+. Since `pump-shared`, `pump-ypso`, `simulator-bridge` and `tester` already pass a 100 % gate, the target is raised to **100 % of lines, regions and functions** for every crate, with hardware-bound code excluded only behind a documented feature. Mutation testing is added so the gate measures checked behaviour, not just executed lines ([10](10-testing-and-ci.md#coverage)).

Still open: whether mutation testing blocks merges or only reports, and the allowed surviving-mutant threshold.

## Q5. Splitting `pump-shared`

`pump-shared` contains both the generic host contract and the pump model. CGMs and uploaders need the first but not the second.

**Proposal** ([03](03-repositories-and-crates.md#shared-crates)): split into `device-shared` + `pump-shared` + `cgm-shared` (+ `uploader-shared`) before the first CGM driver. Names to decide.

## Q6. Uploader shape

Uploaders (Nightscout, Tidepool, …) are not BLE devices. Should they use the same `Engine` trait with an `Http` action, or a separate, simpler contract?

**Proposal:** same sans-IO pattern with an HTTP-shaped action, separate trait (`Uploader`), sharing `Action`/`Completion` mechanics from `device-shared`. Open: is a shared uploader worth it, given each app already has its own upload pipeline and record model?

## Q7. Bindings technology and ownership

**Proposal** ([13](13-app-integration.md#bindings-proposal)): UniFFI, one `bindings` repository, maintained by the open-source-aid group. Open: who maintains the Kotlin and Swift host runtimes, and do they live in open-source-aid or in each app?

## Q8. Licence compatibility

Drivers are AGPL-3.0-or-later. Confirm with each target app (AAPS, Trio, Loop) that linking them is compatible with that app's licence and distribution (including App Store distribution for iOS). Get a proper legal opinion; `NOTICE.md` files are drafts.

## Q9. Configuration commands not yet shared

Device settings such as bolus speed, display settings or alarm thresholds are not in `Command`. Options: (a) add each to the shared `Command` when a second device has it; (b) a generic `ReadSetting` / `WriteSetting { id, value }` with a driver-declared setting table in `DriverInfo`.

**Proposal:** (a) for anything that affects delivery, (b) for everything else, so apps can show device settings without device-specific UI code.

## Q10. Device simulator placement

**Proposal** ([11](11-simulators.md#where-a-device-simulator-lives)): keep simulators in the driver crate behind `sim`, and counter the symmetric-bug risk with real-device vectors. The `simulator-<manufacturer>` repository type stays available for independently written simulators.

## Q11. Name of the generic shared crate

Choose the final name for the generic shared crate (`device-shared`, `osaid-core`, …).

## Q12. Formal verification scope

Which functions, if any, MUST have proofs (for example with Kani) rather than tests? **Proposal:** none mandatory at first; start with frame reassembly, counter policy and `Bounds` arithmetic as pilots ([10](10-testing-and-ci.md#formal-verification)).

## Q13. Transports other than BLE GATT

DanaR, DanaRv2 and DanaR Korean use Bluetooth Classic (RFCOMM serial), and other older pumps use RileyLink-style radio bridges. `BleOp` only covers BLE GATT.

**Proposal:** add a `Stream` transport (`Open`, `Send(bytes)`, `Received(bytes)`, `Close`) as a separate `Action` variant (contract version bump), rather than forcing serial protocols into fake GATT characteristics. Decide whether these devices are in scope at all.

## Q14. Coupled limits

Dana allows a temp basal above 200 % only with a 15-minute duration ([16](16-case-study-dana.md#3-limits-the-same-pump-two-different-answers)). `Limits` describes percent and duration as independent ranges, so it cannot express this.

Options: (a) a list of `TempBasalRule { percent: Bounds, durations: Bounds }`, of which a request must match one; (b) keep independent ranges and let the driver refuse combinations with `OutOfLimits`, exposing a `check(command) -> Result<(), Refusal>` helper so adapters can ask before submitting. **Proposal:** (b) now, since it needs no new types; (a) if a second pump needs it.

## Q15. Simulator hardware target

The ESP32-S3 spike ([11](11-simulators.md#esp32-s3-spike-done-19-nov-2026)) passes the full clear-text `tester` suite over Bluetooth, and 21 of 31 applicable encrypted scenarios. **Proposal:** make the ESP32-S3 the default board once the encrypted-mode failures are explained, and keep the nRF52840 build as long as anyone uses it. To decide: whether CI should build both firmware crates, and whether boards should be standardised (one DevKitC-style ESP32-S3 model) so the port wiring in the docs stays true.

## Q16. How strict should secret handling be (S10)?

S10 in [08](08-safety.md#cryptography-and-counters) says keys and session material are `Secret` (zeroised, hidden from `Debug`), stored with `Class::Secret`, and never logged. Since the group writes the apps, is that necessary? The safety concern here is **preventing hijacking** (someone else commanding the pump), not protecting data inside the app.

**Cost.** `Secret` is a `Zeroizing<Vec<u8>>` with a redacted `Debug`. At run time it costs one zero-fill of the key bytes when the value is dropped (about 32 byte writes for a 32-byte key), no extra memory, and one small `no_std` dependency (`zeroize`, already in `pump-shared`). In code it costs an `.expose()` call wherever the bytes are needed.

**What each part protects against:**

| Part of S10 | Hijacking path it closes |
|---|---|
| Never log keys | Logs leave the app: support chats, bug reports, crash reporters, log uploads. A session or pairing key plus Bluetooth range may be enough to impersonate the app, depending on the pump. (DanaKit logs Dana pairing keys in clear text today; AAPS masks them, see [16](16-case-study-dana.md#4-safety-and-testing-observations).) |
| Store keys through `Class::Secret` (keystore/keychain) | Keys copied out through phone backups or other device-level access |
| Zero bytes after use | Reading app memory on a compromised (for example rooted) device. Weak on its own, but free |
| `Debug` shows no key bytes | Keys printed by accident through `{:?}` in logs or panic messages |

**The case for plain-text access.** Having the key in clear text is sometimes useful. Candidate use cases to collect opinions on:

- decrypting a Bluetooth sniffer capture (for example in Wireshark) while reverse-engineering or debugging a protocol;
- moving an existing pairing from one app to another (AAPS to Trio, or between phones) without pairing the pump again;
- reproducing a field bug from a user's report;
- bench work against a test pump or the simulator, whose keys are fixed and public anyway.

**Proposal.** Keep S10 as good practice, since it costs almost nothing. If a use case above is confirmed, add one explicit, deliberate path for it instead of relaxing logging. For example: an export command or a `debug-secrets` build feature that is never in release builds, that only the user can trigger, and that warns them. Simulator keys may always be logged, because they protect nothing.

**To decide:** which plain-text use cases are real, and whether any of them justifies an export path in release builds.

## Q17. Interactive and agent-driven over-the-air testing

**Proposal** ([11](11-simulators.md#control-tooling-usb-console-tui-and-mcp-proposal)): turn `tester` into a long-lived service controlled over USB, with an MCP server over stdio first (for agents) and a TUI second. A web UI stays optional because of the extra front end, tooling and HTTP security it brings.

To decide: the exact MCP tool set; the JSON format of the board's `status` reply (shared across pump and CGM simulators); whether the MCP server may run against `--target ble` without a person present; and whether a web UI is wanted at all.

## Q18. A recoverable sensor state in cgm-shared

Some sensors report a temporary issue: readings pause and the sensor recovers by itself (the Sibionics app says to wait up to three hours and not to remove it). `SensorState` has only `Failed(code)`, which apps treat as final, so a driver today can only flag the readings (`DEVICE_FLAGGED`) and the app shows nothing more specific than signal loss.

**Proposal:** add `SensorState::Paused { since, code }` (name open): no readings are usable while it lasts, the app tells the user to wait rather than replace the sensor, and it ends by itself. That is an incompatible contract change, so `CGM_API_VERSION` goes to 3.

To decide: the name and fields, whether apps should alert on it like signal loss, and whether "the official app cannot use the sensor" (Sibionics status 7) belongs here or in `Failed`.

## Q19. mg/dL against the manufacturer's app

[06](06-data-model.md#conversion-and-the-manufacturers-display) says to convert with 18.0182 and round once. The Sibionics app computes mmol/L × 18.016 and rounds down (it reproduces all 1,997 readings of a 7-day mg/dL export), so a driver that follows the rule reads 1 mg/dL higher on about 58 % of readings, never more.

**Proposal:** keep the rule. It is the closer value to the sensor's own mmol/L, and it converts back to exactly that value; rounding down would show 26 of 324 mmol/L values 0.1 low after an app's mg/dL → mmol/L conversion. List the difference as a known deviation in the driver's README.

To decide: whether mg/dL users seeing a 1 mg/dL difference from the manufacturer's app is acceptable, or whether drivers should match each manufacturer's own conversion, and how other manufacturers convert.

