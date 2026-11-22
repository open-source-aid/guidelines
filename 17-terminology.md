# Appendix: Terminology

Technical terms used in this guideline and in the `open-source-aid` repositories. Diabetes and dosing terms (IOB, COB, ISF, …) are left out. Type names in `code` are from `pump-shared` unless another crate is named.

## Variants, feature flags and related terms

These are easy to mix up because each answers a different question at a different time.

| Term | Question it answers | Decided | Who decides | Where it lives |
|---|---|---|---|---|
| **Device family** | Which protocol does this driver speak? | When the crate is written | Driver author | One driver crate per family (`pump-ypso`, `pump-dana`) |
| **Variant** | Which model or protocol generation within the family is this device? | At run time, per device | The driver, from the advertisement or the handshake | `DriverInfo.variants`; returned by `Driver::matches`, passed to `Driver::new_engine` |
| **Feature flag** (Cargo feature) | Which code is compiled into this build? | At build time, per app build | Whoever builds the app (or the test) | `[features]` in `Cargo.toml`; reported at run time in `DriverInfo.features` |
| **Commands** | Which commands does this build of the driver accept? | At build time, follows from feature flags | Feature flags | `DriverInfo.commands` |
| **Capabilities** | What can this particular device do through its interface? | At run time, after connecting | The device (read by the driver) | `Capabilities`, and the `Option`s in `Limits` |
| **Limits** | Which values does the device accept right now? | At run time, may change | The device and its configuration | `Limits` (`Bounds<T>` per quantity) |
| **Configuration** | Which settings are stored on the device? | Whenever the user or app changes them | User or app | Read and written with commands; changes appear in history |

**Variant** in more detail. A `Variant` (`id`, `name`) names one member of a device family that the same driver supports, where the members differ enough that the engine must behave differently: a different model, firmware generation or security scheme. The host never chooses it. `Driver::matches(advertisement)` returns the variant for a device it recognises, and the host passes it to `Driver::new_engine(variant, config)`. A driver may also refine it during the handshake when the advertisement cannot tell the generations apart.

- `pump-ypso` has the variants `ypso` (YpsoPump with its CryptoService) and `ypso-opn` (an older YpsoPump without it, driven in clear text).
- A Dana driver would have `dana-rs`, `dana-rs-v3` and `dana-i`: one protocol, three security schemes ([16](16-case-study-dana.md#1-variants-map-onto-one-driver)).

**How feature flags relate to variants.** A feature flag can decide whether a variant is **compiled in at all**; the variant then decides how a **particular device** is driven. In `pump-ypso` the `ypso-opn` variant only exists when the crate is built with the `opn` feature, so an app that never wants to drive a clear-text pump leaves `opn` off and that code is not in the binary. Likewise the `delivery` feature decides whether insulin-delivering commands exist in a build at all, for every variant; it is not a property of any device.

| Example | Kind | Effect |
|---|---|---|
| `delivery` | Feature flag | Bolus, temp basal, extended bolus and basal profile writes are compiled in. Without it they are refused with `Refusal::NotBuilt`. Stop paths are always compiled |
| `opn` | Feature flag | The `ypso-opn` variant is compiled in |
| `sim` | Feature flag | The driver's device simulator is compiled in (tests and firmware only) |
| `std` | Feature flag | Builds with the Rust standard library; without it the crate is `no_std` |
| `ypso` / `ypso-opn` | Variant | Which YpsoPump generation this device is |
| "can extended bolus", "keeps history" | Capability | What this device supports |
| max bolus 25 U, basal step 0.01 U/h | Limits | What this device accepts now |

`Feature` (the struct in `DriverInfo.features`) is the run-time report of feature flags: `{ name: "delivery", enabled: true }`. It lets a host see what was compiled in without reading the build files.

## Architecture and contract

| Term | Meaning |
|---|---|
| **Shared contract** | The traits, types and rules every driver and host agree on; today the crate `pump-shared` |
| **Driver** | A crate that implements one device family's protocol, and the `Driver` trait it exposes as a single `static DRIVER` |
| **`DriverInfo`** | A compile-time description of a driver: identity, contract version, advertisement matching rules, every GATT characteristic it uses, variants, commands, feature flags and storage slots |
| **Engine** | One driver instance for one device (`Box<dyn Engine>`): a synchronous state machine that takes commands and inputs and produces actions and events |
| **Host** | The code that runs an engine on a platform and performs its actions: Bluetooth, storage, keystore, randomness, clocks. Written once per platform (Kotlin, Swift; Rust in tests and firmware) |
| **Adapter** | App-specific code that maps engine events and types onto an app's pump interface (AAPS `PumpSync`, LoopKit `PumpManager`) |
| **Binding** | The generated foreign-function layer that exposes the Rust contract to Kotlin and Swift (proposed: UniFFI) |
| **Sans-IO** | A design where the library never performs input/output itself. It asks the host to (actions) and is told the results (completions) |
| **Action** | A request from the engine to the host: `Ble`, `Store`, `Load`, `Erase`, `Wrap`, `Unwrap`, `KeyAgree`, `Random` |
| **Completion** | The host's answer to an action, matched by **`OpId`** |
| **Event** | Output from the engine to the app: `Started`, `Progress`, `Finished`, `DeviceInfo`, `StateChanged`, `TherapyChanged`, `Log` |
| **Command** | A device operation the app submits (`Status`, `Bolus`, `TempBasal`, …), identified by a **`CommandId`** |
| **Outcome** | How a command ended: `Completed`, `Approximated` (done, not exactly as asked), `Refused` (nothing sent), `Unknown` (sent, result unknown; never retried), `Failed` |
| **`Refusal`** / **`Failure`** | Why a command was refused before anything was sent / why it failed in a way known not to have taken effect |
| **Stop path** | A command that stops or reduces delivery (cancel temp basal, cancel extended bolus, suspend, 100 % temp basal, `stop()`). Never refused for a missing feature or a device state |
| **Delivery command** | A command that can deliver insulin; behind the `delivery` feature flag |
| **`EngineState`** | The engine's lifecycle: `Loading`, `Unpaired`, `Pairing`, `Paired`, `KeyRejected` |
| **Therapy state machine** | `TherapyState` with four independent regions (mode, basal, bolus, extended), changed only through **`Transition`**s defined in the shared crate; `TherapyMachine::guard` refuses commands that make no sense in the current state |
| **`Config`** | What the host tells an engine at creation: device address and UTC offset |
| **`Kind`** | `Pump` or `Cgm` |
| **Contract version** | `API_VERSION`, bumped on any incompatible change to the host-facing contract. A host refuses a driver whose `DriverInfo::is_compatible()` is false |

## Storage and secrets

| Term | Meaning |
|---|---|
| **`Slot`** | A named storage location an engine reads and writes through the host: `Session`, `PendingSession`, `Counters`, `NonceState`, `Driver(n)` |
| **`Class`** | How the host must store a slot: `Secret` (keystore or keychain), `Monotonic` (must never go backwards, stored before use), `Plain` |
| **`Secret`** | Bytes that are zeroed when dropped and never shown by `Debug` |
| **`KeyRef`** | The name of a key the host holds (for example an offline-pairing server key), so the engine can use it without seeing it |
| **Session** | The keys and state from pairing with a device that let the engine talk to it again later |
| **Counters / nonces** | Values the protocol requires never to repeat; persisted as `Class::Monotonic` |

## Data model

| Term | Meaning |
|---|---|
| **`InsulinAmount`** | Insulin in milli-units, `u32` (`1_500` = 1.5 U) |
| **`BasalRate`** | Milli-units per hour, `u32` |
| **`Percent`** | `u16`, 100 = neutral |
| **`TempBasalRate`** | `Percent(..)` or `Absolute(BasalRate)` |
| **`MgDl`** | Glucose, `u16` mg/dL; the only glucose unit in the contract |
| **`Timestamp`** | Host monotonic time in milliseconds; drives timeouts |
| **`UtcTime`** | Wall-clock time, Unix milliseconds |
| **`PumpTime`** | The device's own local clock, as it shows it |
| **`Bounds<T>`** | `min`, `max` and a list of **`Tier`**s (`from`, `step`): the grid of allowed values. `allows`, `floor`, `nearest`, `values` |
| **`Sequence`** | The device's own number for a history entry |
| **`sync_id`** | `"<serial>-<sequence>"`: a stable key for deduplicating history across reads and apps |
| **`raw`** | The bytes of a history entry or report exactly as read from the device |
| **`#[non_exhaustive]`** | A Rust attribute on data enums: new variants can be added without breaking apps. Host-contract enums (`Action`, `Completion`, `BleOp`) are deliberately exhaustive, so a new one must be handled |

## Bluetooth

| Term | Meaning |
|---|---|
| **Central / peripheral** | The side that scans and connects (phone, tester) / the side that advertises and serves (pump, simulator board) |
| **Advertisement / scan response** | The small broadcast packets a peripheral sends; the name and service UUIDs used to recognise it (`BleMatch`, `Advertisement`) |
| **GATT** | The attribute database a peripheral exposes: **services** containing **characteristics**, each with a **handle** |
| **`GattChar`** | One characteristic a driver uses: service UUID, characteristic UUID, and whether it notifies |
| **Notification / indication** | A value pushed by the peripheral; an indication waits for an acknowledgement (`NotifyKind`) |
| **CCCD** | Client Characteristic Configuration Descriptor: the attribute a central writes to subscribe to notifications or indications |
| **ATT error code** | The one-byte error a peripheral returns for a read or write (`0x0A` attribute not found, pump-specific codes `0x80`–`0x9F`, `0xFD` wrong CCCD configuration) |
| **MTU** | The largest Bluetooth attribute packet on a connection; longer values are read in parts at an **offset** (a **long read**) |
| **Deferred read** | A read the peripheral answers at request time with a freshly computed value, instead of a stored one; the simulators need it |
| **Bonding vs device pairing** | Bonding is the operating system's Bluetooth pairing. Device pairing is the pump's own key exchange (passkeys, codes on the pump screen) done by the driver. A device may need one, the other or both |
| **GATT cache** | Phones and Macs remember a device's GATT table per address; a changed table at the same address leads to stale handles |

## Testing and simulation

| Term | Meaning |
|---|---|
| **`SimDevice`** | The device side of a protocol: answers `BleOp`s like the real device would. Lives in the driver crate behind the `sim` feature (`YpsoSim`) |
| **`Simulator`** (`simulator-bridge`) | A `SimDevice` that can also run on a board: advertised name and service, GATT table, and console knobs |
| **Bridge** | `simulator-bridge`: turns Bluetooth peripheral events into `SimDevice` calls, independent of the chip |
| **Board** | A microcontroller running the bridge and a simulator (XIAO nRF52840, ESP32-S3) |
| **Console / knob** | The board's serial command line (`battery 20`, `alarm occlusion`, `advance 60`), used to change the simulated device's state from the outside |
| **Harness** (`tester-harness`) | Runs an engine against a `SimDevice` in process, with virtual time, fault injection and invariant checks |
| **Fault** | An injected failure: `BleTimeout`, `BleDisconnected`, `BleStatus(code)`, `HostFails` |
| **Fault sweep** | Running a scenario once per step with a fault injected at that step |
| **Violation** | A broken invariant the harness detects: a resent timed-out write, a rejected completion, an engine that never settles, an undeclared subscription |
| **Scenario** | One named test in `tester` (for example "bolus delivered with progress"), run against `--target sim` (in process) or `--target ble` (a board over Bluetooth) |
| **Mode** | `opn` (clear text) or `encrypted`; which YpsoPump security the run uses |
| **Transcript** | The recorded sequence of actions, completions and notifications of a run |
| **Name guard** | The rule that the tester only connects to a peripheral whose name ends in the simulator serial (`3735928559`), so it can never reach a real pump |
| **Known-answer vector** | A fixed input with the exact output a real device or reference implementation produces |
| **Symmetric bug** | A bug shared by the driver and its simulator (for example the same wrong codec), so tests pass anyway |
| **Coverage (lines, regions, functions)** | The share of source lines, code branches and functions that ran during tests, measured with `cargo llvm-cov` |
| **Mutation testing** | Deliberately changing the code (`cargo mutants`) to check that some test fails |
| **Bench test** | A check on a real device that settles an open question in `.docs/to-confirm.md` |

## Hardware and tooling

| Term | Meaning |
|---|---|
| **nRF52840** | Nordic Semiconductor Bluetooth chip (Arm Cortex-M4F) on the Seeed XIAO board |
| **SoftDevice** | Nordic's Bluetooth stack, used by the nRF52840 firmware through `nrf-softdevice` |
| **ESP32-S3** | Espressif Bluetooth and WiFi chip (Xtensa CPU); the ESP32-S3-WROOM is the module on DevKitC-style boards |
| **TrouBLE** | A Rust Bluetooth host stack (`trouble-host`), used by the ESP32-S3 firmware |
| **esp-hal / esp-radio / esp-rtos** | Espressif's Rust hardware layer, radio driver (Bluetooth controller) and scheduler with Embassy support |
| **Embassy** | A Rust async framework for microcontrollers; used inside firmware only, never in drivers |
| **USB-OTG / USB Serial/JTAG** | The ESP32-S3's built-in USB port; used for logs. Opening it from macOS can reset the chip into download mode |
| **USB-UART** | The board port behind a USB-serial bridge chip, connected to UART0; used for flashing and the console |
| **Download mode** | The chip's ROM bootloader waiting for new firmware instead of running the app |
| **`espflash` / UF2** | The ESP32 flashing tool / the drag-and-drop firmware format used by the XIAO's bootloader |
| **Xtensa / RISC-V** | CPU architectures. The ESP32-S3 is Xtensa and needs Espressif's Rust toolchain (`espup`); the ESP32-C3 and C6 are RISC-V and build with stable Rust |
| **`no_std` / `alloc`** | Rust without the standard library (no OS), but with heap allocation; what makes drivers platform independent |
| **`thumbv7em-none-eabihf`** | A bare-metal Arm target; CI builds every driver for it to prove it has no OS dependency |
| **Crate / workspace** | A Rust library or binary / a set of crates built together |
| **`xtask`** | A small Rust program in a repository for project tasks (here: generating the therapy diagrams) |
| **MSRV** | Minimum supported Rust version (`rust-version` in `Cargo.toml`) |
| **MCP** | Model Context Protocol: a standard way for AI agents to call tools; proposed as the agent interface to the tester |
| **TUI** | Terminal user interface |

## Document conventions

| Term | Meaning |
|---|---|
| **MUST / SHOULD / MAY** | Requirement levels as defined in RFC 2119 |
| **Current** | Describes what the repositories already do |
| **Proposal** | Not yet agreed by the group |
| **S1–S18** | Safety rules ([08](08-safety.md)) |
| **E1–E10** | Engine rules ([04](04-driver-contract.md#rules-for-engines)) |
| **R1–R11** | Requirements ([01](01-principles.md#requirements)) |
| **Q1–Q17** | Open questions ([14](14-open-questions.md)) |
