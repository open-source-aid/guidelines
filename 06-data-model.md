# 6. Data model, configuration and capabilities

The authoritative reference is [`pump-shared/.docs/data-model.md`](https://github.com/open-source-aid/pump-shared/blob/main/.docs/data-model.md). This chapter gives the rules a driver author needs and defines the vocabulary the group agreed on.

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

`cgm-shared` holds the CGM contract (`CGM_API_VERSION = 2`); `cgm-sibionics` is the first driver on it. The types, and the rules below, come from building that driver against a real sensor. Expect them to change as more CGM drivers arrive.

| Type | Content |
|---|---|
| `GlucoseReading` | `time: UtcTime`, `value: Option<MgDl>` (`u16` mg/dL, see [Glucose](06-data-model.md#glucose)), `trend: Option<Trend>`, `rate`, `quality` flags (`WARMUP`, `EXPIRED`, `IMPLAUSIBLE`, `DEVICE_FLAGGED`, `SENSOR_FAILED`), `sequence`, `historical`, `raw` |
| `SensorState` | `WarmingUp { until }`, `Active { expires }`, `Expired`, `Failed(code)`, `SignalLost { since }`, `Unknown`. There is no state for a temporary sensor issue yet ([Q18](14-open-questions.md#q18-a-recoverable-sensor-state-in-cgm-shared)) |
| `Calibration` | Value, time, accepted or not |
| Commands | `Status`, `Pair`, `Unpair`, `ReadReadings { after }`, `StartSensor`, `StopSensor`, `Calibrate`, `Stop` |

Backfill (readings missed while disconnected) uses the same `after: Sequence` pattern as pump history. A reading the driver reports is never silently dropped: it carries `quality` flags, and the adapter decides from them what to forward.

### Capabilities

A driver lists in `CgmDriverInfo.commands` exactly which of `Calibrate`, `StartSensor` and `StopSensor` it supports, and its README says so in words, including "not supported". An app never has to guess whether a CGM can be calibrated or stopped. If the protocol has no calibration, the driver does not fake one on the phone. Start and stop are usually irreversible; the README lists which commands are, and what makes the driver send them. (Current: `cgm-sibionics` supports none of the three as commands; it starts a factory-new sensor inside `Pair` and never sends the known stop command.)

### Sensor health

- **The sensor's own status comes first.** Wherever the protocol carries the sensor's health (a status reply, a field in every record, an advertisement), the driver reads it and reports it: a failure as `Failed(code)` with the code documented, an expiry as `Expired`. Every state the manufacturer's app warns about is reported.
- **Readings during a bad status are flagged.** Each reading carries the flag for its own record's status (`SENSOR_FAILED`, `EXPIRED`, `DEVICE_FLAGGED`), history included. Only live records change the sensor's current state.
- **A final state needs confirmation.** A state that ends a sensor (an app typically persists `Failed` until the sensor is replaced) is entered only after several consecutive new records report it, so one odd record cannot end a working sensor. Resends do not count. Recoverable states act per record. (Current: `cgm-sibionics` waits for three records.)
- **Driver heuristics never end a sensor.** A plausibility check the manufacturer's app does not make may flag readings (`IMPLAUSIBLE`) but does not declare the sensor failed.
- **Per-reading status bits are documented** with what the manufacturer's app does with each, including "ignored".

### Trend

Where the protocol carries the sensor's own trend code, the arrow is that code, so it matches the manufacturer's app; the driver may still derive the rate of change. Only a sensor without a trend code gets a derived arrow. (Current: `cgm-sibionics`; the arrow derived from five-minute deltas disagreed with the official app on about one reading in five.)

### Signal loss

`SignalLost` is the age of the last reading that carried a *value*, not of the last record or notification. Some sensors keep sending records with no result in them when they cannot compute one, and a sensor like that must not look active. Records that never carry a value on a healthy sensor (placeholders between readings, warm-up) are allowed for, so the rule is "time since the last value", never "this record has no value". A separate link watchdog may still drop a link that delivers nothing at all. There is no rate-of-change gate: real glucose moves fast.

### Deviations from the manufacturer's app

A driver may deliberately behave differently from the manufacturer's app, for example by acting on a status the app only reads at connect. Each such difference is listed in the driver's README under "Known limitations and deviations", with the reason and what it costs. A deviation that can only hold readings back, never forward a wrong one, is the preferred kind.

### Conversion and the manufacturer's display

Drivers convert with 18.0182 and round once ([Glucose](06-data-model.md#glucose)). A manufacturer's app may not: the Sibionics app computes mmol/L × 18.016 and rounds down, so a driver following this rule reads up to 1 mg/dL above it. Rounding is kept because it stays within 0.5 mg/dL of the sensor's own value and converts back to the exact mmol/L; truncating would show some mmol/L values 0.1 low after an app converts back. Whether drivers should match the manufacturer's mg/dL instead is [Q19](14-open-questions.md#q19-mgdl-against-the-manufacturers-app).
