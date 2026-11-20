# 4. The driver contract

All types below are in `pump-shared` (**Current**, `API_VERSION = 1`). This chapter explains the rules around them; the field-level reference is [`pump-shared/.docs/data-model.md`](https://github.com/u-osaid/pump-shared/blob/main/.docs/data-model.md).

## `Driver`: the static description

```rust
pub trait Driver: Sync {
    fn info(&self) -> &'static DriverInfo;
    fn matches(&self, adv: &Advertisement<'_>) -> Option<&'static Variant>;
    fn new_engine(&self, variant: &'static Variant, config: Config) -> Box<dyn Engine>;
}
```

A driver crate exposes one `static DRIVER` value. `DriverInfo` is a compile-time constant that tells the host, without running any code:

| Field | Use |
|---|---|
| `id`, `name`, `kind`, `version`, `protocol` | Identification and logging |
| `api_version` | MUST be `pump_shared::API_VERSION`; hosts refuse drivers where `is_compatible()` is false |
| `ble` (`BleMatch`) | Name prefixes, service UUIDs, manufacturer ID used to filter scans |
| `gatt` | Every characteristic the engine may touch, and which ones it subscribes to (`notify`). The harness rejects subscriptions that are not declared here |
| `variants` | Models within the family |
| `commands` | The `CommandKind`s compiled in (depends on features) |
| `features` | Compiled feature flags |
| `slots` | Every storage slot the engine uses and its `Class` (`Secret`, `Monotonic`, `Plain`) |

Rule: **a driver MUST declare everything it will ask the host for.** A host can then prepare permissions, keystore entries and GATT discovery ahead of time, and a reviewer can see the driver's whole footprint in one place.

## `Engine`: the per-device state machine

```rust
pub trait Engine: TherapyMachine {
    fn submit(&mut self, command: Command) -> Result<CommandId, SubmitError>;
    fn stop(&mut self) -> CommandId;
    fn handle_completion(&mut self, id: OpId, completion: Completion) -> Result<(), CompletionError>;
    fn handle_timeout(&mut self, now: Timestamp);
    fn handle_wall_clock(&mut self, now: UtcTime);
    fn handle_link_lost(&mut self);
    fn handle_notification(&mut self, notification: Notification);
    fn poll_action(&mut self) -> Option<Action>;
    fn poll_event(&mut self) -> Option<Event>;
    fn poll_timeout(&self) -> Option<Timestamp>;
    fn state(&self) -> EngineState;
}
```

### Host loop

A conforming host runs this loop until `poll_action` returns `None`, then sleeps until the next input or `poll_timeout`:

```rust
loop {
    while let Some(event) = engine.poll_event() { adapter.on_event(event); }
    let Some(action) = engine.poll_action() else { break };
    let id = action.id();
    let completion = host.perform(action);          // may be asynchronous on the platform side
    engine.handle_completion(id, completion)?;       // but is fed back synchronously
}
```

### Rules for engines

| # | Rule |
|---|---|
| E1 | At most **one action is outstanding** at a time. A completion for any other `OpId`, or of the wrong shape, returns `CompletionError` and changes nothing |
| E2 | Every call returns promptly. No blocking, sleeping, spinning, threads or executors visible to the host |
| E3 | `submit` queues; it never performs work inline beyond producing the first action. A full queue returns `SubmitError::QueueFull` |
| E4 | `stop()` MUST always be accepted, pre-empts queued commands, and is never refused for a missing feature |
| E5 | Every `submit` ends with exactly one `Event::Finished { id, outcome }` |
| E6 | Engine state that must survive a restart (session keys, counters, nonce state) is persisted through `Action::Store` **before** it is relied on |
| E7 | Monotonic values (`Class::Monotonic`) MUST be stored before the value is used on the wire, so a crash cannot reuse a counter or nonce |
| E8 | After `handle_link_lost`, anything in flight that may have reached the device finishes as `Outcome::Unknown` |
| E9 | Subscriptions only to characteristics declared with `notify` in `DriverInfo.gatt` |
| E10 | Secrets only travel as `Secret` (zeroised on drop, never printed by `Debug`) |

## Commands and outcomes

Commands are device operations, not therapy decisions. The full table (which commands deliver insulin, which are stop paths) is in the data model. Every command finishes with exactly one `Outcome`:

| Outcome | Meaning | Host/app reaction |
|---|---|---|
| `Completed(Report)` | Done exactly as requested | Record it |
| `Approximated(Approximation)` | Done, but not exactly (carries requested and achieved) | Record what was achieved |
| `Refused(Refusal)` | **Nothing was sent** to the device | Safe to change and resubmit |
| `Unknown` | Something was sent; the result is not known | Mark delivery uncertain; reconcile from status/history; **never retry automatically** |
| `Failed(Failure)` | Failed in a way known not to have taken effect | Report |

`Refusal` values: `NotBuilt` (feature not compiled), `NotPaired`, `NotRunning`, `NotSuspended`, `OutOfLimits`, `Busy`, `Unsupported` (the device cannot do it).

## Actions and completions

| Action | Expected completion | Host duty |
|---|---|---|
| `Ble { op: BleOp }` | `Ble(BleResult)` | Connect, read, write, subscribe, unsubscribe, disconnect, request fast interval |
| `Store { slot, class, bytes }` | `Stored` | Persist durably, according to `class` |
| `Load { slot }` | `Loaded(Option<Vec<u8>>)` | `None` if never stored |
| `Erase { slot }` | `Stored` | |
| `Wrap { plaintext }` / `Unwrap { wrapped }` | `Wrapped` / `Secret` | Use the platform keystore |
| `KeyAgree { key, peer_public }` | `Secret` | X25519 with a key the host holds (`KeyRef`) |
| `Random { len }` | `Secret` | Cryptographically secure random bytes |
| any | `Failed` | The host could not perform it |

`Action`, `Completion` and `BleOp` are deliberately **exhaustive**: adding a variant is a breaking change that every host must handle. Data enums (`Command`, `Event`, `HistoryEvent`, `Refusal`, …) are `#[non_exhaustive]` so apps keep compiling when a variant is added.

## Events

| Event | When |
|---|---|
| `Started { id }` | A command begins executing |
| `Progress { id, delivered, requested }` | During a bolus |
| `Finished { id, outcome }` | Once per submitted command |
| `DeviceInfo(..)` | After connect: serial, firmware, variant, `Limits`, `Capabilities` |
| `StateChanged(EngineState)` | `Loading`, `Unpaired`, `Pairing`, `Paired`, `KeyRejected` |
| `TherapyChanged(TherapyState)` | Whenever the therapy state machine changes |
| `Log { level, line }` | Diagnostic text; MUST NOT contain secrets |
