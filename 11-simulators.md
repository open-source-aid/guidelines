# 11. Simulators and the universal harness

Every driver MUST be simulatable. A simulator is the device side of the protocol: it answers the same BLE operations the real device would, with the same bytes, encryption and quirks.

## The pieces

```
                 in-process tests                         over-the-air tests
┌──────────────┐   Action   ┌──────────────┐      ┌──────────────┐   real BLE   ┌──────────────────┐
│ Engine       │──────────► │ tester-      │      │ Engine       │─────────────►│ nRF52840 board   │
│ (driver)     │◄────────── │ harness      │      │ + tester-ble │◄─────────────│ simulator-bridge │
└──────────────┘ Completion │  + SimDevice │      └──────────────┘              │  + SimDevice     │
                            └──────────────┘                                    └──────────────────┘
                     virtual time, faults,                         USB serial console: knobs
                     invariants                                    (battery, reservoir, alarms…)
```

| Component | Repository | Role |
|---|---|---|
| `SimDevice` trait | `pump-shared` (`sim` feature) | The device-side contract: `handle(op, now) -> BleResult`, `key_agree`, `poll_notification(now)` |
| Device simulator | Driver crate, `sim` feature (for example `pump_ypso::sim::YpsoSim`) | Implements `SimDevice` for one protocol |
| `Simulator` trait | `simulator` (`simulator-bridge`) | Adds what a BLE peripheral needs: advertised `name`, advertised service, GATT `services()`, and `apply(Command, now)` for console knobs |
| `Bridge` | `simulator` | Maps GATT peripheral events (connect, read, write, CCCD) to `SimDevice` calls; polls notifications every 50 ms |
| Firmware | `simulator/crates/nrf52840` | Runs any `Simulator` on a Seeed XIAO nRF52840 |
| `Harness` | `tester` (`tester-harness`) | Runs an engine against a `SimDevice` in process: virtual time, store, fault injection, invariants, transcript |
| `tester` CLI | `tester` | One scenario list, run `--target sim` (in process) or `--target ble` (hardware) |

## Hardware targets

The hardware simulator is split so that only a thin firmware layer depends on the chip:

| Layer | Chip-specific? | Size today |
|---|---|---|
| Device simulator (`YpsoSim`, …) | No, `no_std` in the driver crate | |
| `simulator-bridge`: GATT events → `SimDevice`, console, GATT tables | No, `no_std`, tested on the host at 100 % | |
| Firmware crate: BLE stack, serial console, LED, panic report | **Yes** | about 590 lines (`crates/nrf52840`), about 400 (`crates/esp32s3`) |

**Current:** `crates/nrf52840` targets the **Seeed XIAO nRF52840** (Nordic nRF52840, Arm Cortex-M4F), using Nordic's S140 SoftDevice BLE stack through `nrf-softdevice` and Embassy. The nRF52840 is a Nordic chip, not an ESP32. An ESP32-S3 build now exists as a spike (below).

### ESP32-S3 (spike done, 19 Nov 2026)

ESP32 boards are cheaper and easier to get, so the group wants them as the main target. Because the bridge does not depend on the chip, the port is a second firmware crate, not a rewrite:

```
simulator/crates/
├── bridge/      unchanged
├── nrf52840/    nRF52840 build (Nordic SoftDevice)
└── esp32s3/     ESP32-S3 build: esp-hal + esp-rtos (Embassy) + esp-radio BLE controller + TrouBLE host
```

**Result.** The spike ran on an ESP32-S3-WROOM DevKitC-style board (chip revision v0.2, 16 MB flash) with the `tester` scenarios over real Bluetooth from a Mac:

| Run | Pass | Fail | Skip |
|---|---|---|---|
| Clear-text pump (`opn`, `--mode opn`) | 27 | 0 | 7 |
| Encrypted pump (`--mode encrypted`) | 21 | 10 | 3 |
| Encrypted pump, in process (`--target sim`, for comparison) | 41 | 0 | 0 |

- Clear-text mode passes every scenario that applies: connect and status, clock read and sync, basal profile, temp basal, bolus with progress and stop, extended bolus, every console knob, restart from storage, and timeout, disconnect and host-failure recovery. The skips are scenarios that only apply to an encrypted pump, plus one that needs pump state the console cannot reach.
- Encrypted mode passes up to and including "pump reboot changes the epoch". From "counter moved by another app" on (a second app's session is swapped in for three reads, then swapped back), every encrypted exchange fails with `Failed(Protocol)`, in later scenarios too. The same scenarios pass in process, so the cause is in the hardware path, but it is **not yet known** whether it is specific to the ESP32 port. Next step: run the encrypted suite against the nRF52840 build for comparison.

**What TrouBLE provides** (`trouble-host` at `da44b34`), covering every requirement the YpsoPump simulator has:

| Requirement | TrouBLE API |
|---|---|
| GATT table built at run time from `Simulator::services()`, custom 128-bit UUIDs | `AttributeTable::add_service` / `add_characteristic` |
| Reads answered at request time from the simulator, including long reads at an offset | `ReadEvent::accept_unprocessed(value)` (slices by the `ReadBlob` offset) |
| Any ATT error code, including the pump's own (`0x8x`) and `0xFD` for a wrong CCCD | `ReadEvent`/`WriteEvent::reject(AttErrorCode::new(code))` |
| Writes passed to the simulator without being stored | `WriteEvent::with_data` + `accept_unprocessed()` |
| CCCD writes checked by the bridge, then recorded so notifications are allowed | `WriteEvent::accept()` after the bridge accepts |
| Notifications and indications (indications wait for the confirmation) | `Characteristic::notify_raw` / `indicate_raw` |

**Lessons from the spike:**

| Problem | Cause | Fix |
|---|---|---|
| Firmware hung at the first `Timer` | Two copies of `embassy-executor-timer-queue` (crates.io and the patched embassy git revision): timers were queued in one and serviced from the other | Patch `embassy-executor-timer-queue` to the same git revision as `embassy-executor`; check `cargo tree -d` |
| Opening the native USB port reset the chip into download mode | macOS raises DTR and RTS when a program opens a serial port, and the ESP32-S3's built-in USB Serial/JTAG treats that as "reset into the bootloader" | Use the board's **USB-UART** port (bridge chip with standard auto-reset wiring) for flashing and for the knob console, and the **USB-OTG** port only for logs and panics |
| Logs broke the console | Log lines on the same UART were read as console replies, shifting every reply by one line | Logs on USB-OTG (`esp-println` feature `jtag-serial`), console alone on UART0 |
| Every request failed with ATT `0x0A` after switching builds | macOS caches a device's GATT table per address; the encrypted build has an extra service, so the cached handles were stale | Give each build variant its own Bluetooth address (or implement Service Changed) |

**Board and wiring.** On DevKitC-style ESP32-S3 boards:

| Port | Connected to | Use |
|---|---|---|
| USB-UART | UART0 through a USB-serial bridge (here a WCH CH343) | Flashing with `espflash` (auto-reset works), the knob console at 115200 baud (`tester --console`) |
| USB-OTG | The chip's built-in USB Serial/JTAG | Logs and panic messages only; do not open it during tests |

Which ESP32 for future boards:

| Chip | BLE | Bluetooth Classic | Notes |
|---|---|---|---|
| **ESP32-S3** | 5.0 | No | Tested; the recommended default |
| ESP32-C3 | 5.0 | No | Cheapest, RISC-V; same TrouBLE stack, untested |
| ESP32-C6 | 5.0 | No | RISC-V, newer; untested |
| ESP32 (original) | 4.2 | **Yes** | Only option that could also simulate Bluetooth Classic pumps such as DanaR ([Q13](14-open-questions.md#q13-transports-other-than-ble-gatt)); Classic support from Rust not checked |

**Tooling.** The ESP32-S3 uses an Xtensa CPU, which needs Espressif's Rust toolchain (`espup install`; it builds with `build-std`). The RISC-V chips (C3, C6) build with stable Rust. Flashing is `espflash flash --port <USB-UART port>`. The `tester` name guard (only connect to names ending in the simulator serial) applies unchanged.

**Still to do before `crates/esp32s3` is merged:** find the cause of the encrypted-mode failures; remove the spike's boot-stage prints; port the panic report and the LED stages; add a CI job that builds the crate with the `esp` toolchain.

## Writing a device simulator

A device simulator MUST:

- implement `SimDevice` (and `Simulator` to run on the board);
- be deterministic given its inputs and `now`;
- reproduce the device's error codes, not just the happy path;
- model time-dependent behaviour (bolus delivery rate, temp basal expiry, basal pulses) from `now`, never from a real clock;
- keep the device's own history so `ReadHistory` can be tested end to end;
- respond to the universal controls below.

## Universal controls

**Current** console knobs, shared across devices by the bridge:

| Knob | Effect |
|---|---|
| `battery <n>` | Set battery level |
| `reservoir <n>` | Set reservoir (device units) |
| `alarm battery\|reservoir\|occlusion` | Raise an alarm and stop delivery |
| `acknowledge` | Clear the active alarm |
| `stop` / `run` | Stop or resume delivery from the device side |
| `reboot` | Reboot the simulated device, drop the link |

**Proposal.** Make these a shared, typed `Control` enum (in the shared crate, `sim` feature) so the same scenario drives any pump simulator, and extend it:

| Control | Applies to |
|---|---|
| `Battery`, `Reboot`, `Alarm(kind)`, `Acknowledge`, `DropLink`, `ClockSkew(secs)` | All devices |
| `Reservoir`, `StopDelivery`, `ResumeDelivery`, `Occlusion` | Pumps |
| `Glucose(generator)`, `SensorState(state)`, `SignalLoss(duration)`, `WarmUp` | CGMs |

A simulator that does not support a control answers `Unsupported`, and the scenario is reported as `skip` with the reason, never silently passed (as `tester` does today).

## Control tooling: USB console, TUI and MCP (Proposal)

Today the over-the-air tests are a one-shot run: `tester run --target ble` connects, runs every scenario, prints `pass`/`FAIL`/`skip` and exits. For interactive testing, and for letting agents drive tests, the same machinery should also run as a long-lived service that is controlled first and foremost over USB.

### Shape

```
                    ┌──────────────────────── host (laptop) ────────────────────────┐
 agent ── stdio ──► │ tester mcp  ─┐                                                │
 you ── terminal ─► │ tester tui  ─┼─► tester core ──── BLE ───────────────────────►│──► board: pump simulator
                    │              │    (engine, storage, scenarios, transcript)    │      (simulator-bridge)
                    │              └───────────────── USB console (USB-UART) ──────►│──► knobs and state
                    └───────────────────────────────────────────────────────────────┘
```

- **One core** in `tester`: the pump driver engine as "the app", its storage, the Bluetooth central, the board console over USB, the scenario list and the transcript. It is the code `tester run` already uses, kept open between commands instead of exiting.
- **USB is the control channel to the board.** Every knob, every state read-back and every reset goes over the board's USB console. Bluetooth is only used for what is under test: the driver talking to the simulated pump.
- **Front ends on top of the core:**

| Front end | For | Transport | Priority |
|---|---|---|---|
| `tester mcp` | Agents | MCP over **stdio**: the agent starts the server as a local process, so no network port is opened | First |
| `tester tui` | People | Terminal UI (for example `ratatui`): live pump state, knob panel, scenario results, Bluetooth transcript | Second |
| Web UI | People who prefer a browser | HTTP | Optional, later. It adds a second front end to maintain, its build tooling, and an HTTP port to secure. Not needed while the TUI and MCP cover the use cases |

The same server also offers `--target sim` (the in-process simulator), so agents can iterate without hardware and switch to over-the-air when it matters.

### MCP tools (first set)

| Group | Tools |
|---|---|
| Session | `connect` (target `sim` or `ble`, simulator name, console port, mode), `disconnect`, `session_status` |
| Board knobs (USB console) | `sim_set_battery`, `sim_set_reservoir`, `sim_alarm`, `sim_acknowledge`, `sim_stop`, `sim_run`, `sim_reboot`, `sim_advance_time` |
| Board state (USB console) | `sim_state`: what the simulated pump itself holds (battery, reservoir, mode, running temp basal and bolus, delivered insulin, clock, active alarms) |
| Driver, as the app | `pump_status`, `pump_read_history`, `pump_read_clock`, `pump_sync_clock`, `pump_bolus`, `pump_temp_basal`, `pump_cancel_temp_basal`, `pump_suspend`, `pump_resume`, `pump_stop` |
| Scenarios | `list_scenarios`, `run_scenario { name }`, `run_all` |
| Debugging | `get_transcript { since }`, `get_events { since }` |

Comparing `pump_status` (what the driver reports) with `sim_state` (what the simulated pump holds) is the core check an agent makes after each step.

### What has to be added

| Change | Where |
|---|---|
| A `status` console command that answers with one JSON line of the simulator's state | `simulator-bridge` console (works on both boards) |
| Device simulators expose that state through a shared trait method | `SimDevice` / `Simulator` |
| Run one scenario by name | `tester` |
| A long-lived session that keeps the engine, storage and link open between calls | `tester` core |
| MCP server over stdio (for example the official Rust SDK, `rmcp`) | `tester mcp` |
| TUI | `tester tui` |

### Safety

Agents will issue delivery commands, so the rules in [08](08-safety.md#testing-hardware) apply with no exceptions:

- the server only connects over Bluetooth to a peripheral whose name ends in the simulator serial (`3735928559`), as `tester` does today;
- delivery commands are refused unless that check has passed;
- every tool call is recorded in the transcript with its result, so an agent's session can be reviewed afterwards;
- MCP runs over stdio only. An HTTP transport, if ever added, binds to localhost and needs authentication.

## Glucose generators (Proposal, for CGM simulators)

CGM simulators need a source of glucose values. Generators live in the shared CGM crate (`sim` feature), not in each simulator, so every CGM simulator and every test uses the same ones:

```rust
pub trait GlucoseGenerator {
    /// Glucose at `t`, or `None` for a gap (sensor error, signal loss).
    fn at(&mut self, t: Timestamp) -> Option<MgDl>;
}
```

| Generator | Use |
|---|---|
| `Constant(v)` | Smoke tests |
| `Ramp { from, to, over }` | Trend arrows, rate-of-change limits |
| `Sine { mean, amplitude, period }` | Long-running stability |
| `Replay(trace)` | Real anonymised traces (CSV of time, value) |
| `Noisy(inner, seed)` | Sensor noise, deterministic by seed |
| `WithGaps(inner, gaps)` | Backfill and missed-reading handling |

Generators MUST be deterministic for a given seed so failures reproduce. Physiological models (meal/insulin response) are out of scope for drivers: they belong to an algorithm test bench, not to a driver simulator.

## Where a device simulator lives

**Current:** in the driver crate, behind the `sim` feature.

| | In the driver crate (`sim` feature) | Separate `simulator-<manufacturer>` repository |
|---|---|---|
| Reuses the driver's codec and crypto | Yes | Only if it depends on the driver |
| Risk of a **symmetric bug** (driver and simulator share the same wrong codec, so tests pass) | Higher | Lower if written independently |
| One PR updates both sides | Yes | No |
| Coverage counted together | Yes | No |

Recommendation: keep simulators in the driver crate by default, and counter the symmetric-bug risk with **known-answer vectors from real devices** (the simulator must reproduce them too) and the bench checklist in `.docs/to-confirm.md`. Use a separate repository only when the simulator is written independently on purpose, or is much larger than the driver.

## Simulating uploaders (Proposal)

Uploaders talk HTTP, not BLE. The same pattern applies: the uploader engine emits `Http { method, url, headers, body }` actions, and a simulated server (a Nightscout double) answers them in the harness, with faults such as timeouts, 401, 429 and 5xx.
