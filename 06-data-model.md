# 6. Data model, configuration and capabilities

The authoritative reference is [`pump-shared/.docs/data-model.md`](https://github.com/u-osaid/pump-shared/blob/main/.docs/data-model.md). This chapter gives the rules a driver author needs and defines the vocabulary the group agreed on.

## Units

| Rule | Detail |
|---|---|
| Integers only | Insulin in milli-units (`InsulinAmount`, `u32`), rates in milli-units per hour (`BasalRate`), percent as `u16` with 100 = neutral |
| Convert at the boundary | A driver converts the device's own units (for example YpsoPump hundredths) in its protocol layer. Nothing above the driver sees a device-specific number |
| Pump-native volume | Amounts are in the device's U100 units. Insulin concentration is the caller's concern |
| Glucose in mg/dL | Every glucose value crossing the driver interface, in either direction, is an integer **mg/dL** (`MgDl(u16)`). See [Glucose](06-data-model.md#glucose) |
| Unknown is `None` | A field the device cannot report is absent, never estimated |
| Raw bytes kept | History entries keep `raw` bytes so they can be re-decoded later and audited |

## Glucose

All glucose values in the contract are **integer mg/dL, `u16`**, wrapped in a newtype (`MgDl(u16)`). This covers CGM readings, calibrations, blood glucose entered on or recorded by a pump, glucose targets a device stores, and simulator generators.

| Rule | Detail |
|---|---|
| Inputs to a driver are mg/dL | A calibration or a BG value sent to a device is given in mg/dL. If the user entered mmol/L, **the app converts** before calling the driver |
| Outputs from a driver are mg/dL | Readings and history are reported in mg/dL. Converting to mmol/L for display is **the app's** job |
| Devices that use mmol/L internally | The driver converts the device's raw value to mg/dL at the protocol boundary, like any other device unit, and keeps the original bytes in `raw`. The device's display-unit setting is reported as configuration, never used to change the unit of the API |
| No sentinel numbers | "Too low to read", "too high to read", warm-up and sensor errors are states (`Option`/enum), not magic values like `0`, `39` or `401` |
| Conversion factor | Where an app or driver must convert, it uses 18.0182 mg/dL per mmol/L (the molar mass of glucose, 180.16 g/mol ÷ 10), rounds to the nearest integer once, and documents it |

Rationale:

- **Memory and size.** A `u16` is 2 bytes; an `f32` is 4 and an `f64` 8. That matters in history buffers, BLE payloads and firmware simulators. A `u16` covers every physiological value (CGMs report about 40–400 mg/dL).
- **No rounding drift.** mg/dL is an integer unit, so a value is exact all the way through the stack. Floating-point mmol/L values cannot represent most readings exactly, and converting back and forth can change the value (for example 5.5 mmol/L → 99.1 mg/dL → 5.50 mmol/L, or 99 vs 100 mg/dL depending on where rounding happens). Converting once, in the app, at the user-interface edge means a value is rounded at most once.
- **One unit everywhere** means comparisons, thresholds and deduplication across apps and drivers behave the same.

## Configuration, capabilities and limits

Three different things that are easy to mix up:

| Concept | Definition | Where it lives | Changes |
|---|---|---|---|
| **Capabilities** | What the device can do through its BLE interface: can it bolus, extended bolus, percent and/or absolute temp basal, does it keep history and daily totals, is it a patch pump, reservoir size, max profile segments | `Capabilities` and the `Option`s in `Limits` (`None` = not supported), plus `DriverInfo.commands` for what the driver implements | Fixed per model/firmware |
| **Limits** | The numeric ranges and step grids the device accepts right now: bolus, basal, temp basal percent/absolute, temp basal duration, extended bolus duration | `Limits`, each a `Bounds<T> { min, max, tiers }` | May change when configuration changes (for example max bolus) |
| **Configuration** | Values persisted on the device that software can set: max bolus, max basal, bolus speed, bolus step, basal profile, clock | Read/written with commands (`SetDeliveryLimits`, `SetBasalProfile`, `SyncClock`, …); changes appear in history (`LimitChanged`, `BasalProfileChanged`, `ClockChanged`) | By the user or the app |

Rules:

- Capabilities and limits SHOULD be **read from the device** when the protocol allows it, and reported in `Event::DeviceInfo` after every connect. Hard-coded values are allowed only when the device cannot report them, and MUST cite their source (manual, firmware, capture) in a comment.
- A driver MUST refuse a value that `Bounds::allows` rejects, with `Refusal::OutOfLimits`. It MUST NOT round. Adapters round with `Bounds::floor` or `Bounds::nearest`, depending on the app's policy.
- Configuration that is not yet in the shared `Command` set (for example bolus speed) SHOULD be proposed as a new shared command if a second device has it. Until then it MAY be a driver-specific API outside the `Engine`, clearly marked as such.
- Driver-local configuration (things the driver, not the device, remembers) uses `Slot::Driver(n)` and is declared in `DriverInfo.slots`.

## Status

`PumpStatus` is a snapshot: therapy state, battery, reservoir, current basal rate, pump clock, `delivery_uncertain`, active alarms. `delivery_uncertain` MUST be set whenever an `Unknown` outcome has not yet been reconciled.

## History

- Each `HistoryEntry` has the device's own `sequence`, `time` (UTC), `pump_time` (as recorded), a normalised `event`, and the `raw` bytes.
- `sync_id(serial) = "<serial>-<sequence>"` is the deduplication key across reads and apps.
- `ReadHistory { after }` returns entries strictly after a sequence, so apps can sync incrementally.
- Events the shared model cannot express are mapped to the closest event and the device detail kept in `raw`; a driver MAY offer a typed decoder for its own raw payloads.

## CGM data model (Proposal)

Not yet defined. Minimum content for `cgm-shared`, to be agreed before the first CGM driver:

| Type | Content |
|---|---|
| `GlucoseReading` | `time: UtcTime`, `value: Option<MgDl>` (`u16` mg/dL, see [Glucose](06-data-model.md#glucose)), `trend: Option<Trend>`, `quality` flags, `sequence`, `raw` |
| `SensorState` | `WarmingUp { until }`, `Active { expires }`, `Expired`, `Failed(code)`, `Unknown` |
| `Calibration` | Value, time, accepted or not |
| Commands | `Status`, `ReadReadings { after }`, `Calibrate`, `StartSensor`, `StopSensor`, `Pair`, `Unpair` |

Backfill (readings missed while disconnected) uses the same `after: Sequence` pattern as pump history.
