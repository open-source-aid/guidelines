# 8. Safety rules

These drivers move insulin. The rules here are not style preferences; a driver that breaks one MUST NOT be merged.

## Delivery

| # | Rule |
|---|---|
| S1 | Every command that can deliver insulin is behind the `delivery` feature, off by default. Without it the command is refused with `Refusal::NotBuilt` |
| S2 | **Stop paths are never gated.** `CancelTempBasal`, `CancelExtendedBolus`, `Suspend`, a 100 % temp basal and `stop()` are always compiled and never refused for a missing feature or a therapy state |
| S3 | A driver never changes a requested amount. Off-grid or out-of-range values are refused with `OutOfLimits` |
| S4 | When a command may have reached the device and the result is not known, the outcome is `Unknown`, `delivery_uncertain` is set, and the command is **not retried** by the driver |
| S5 | A write that timed out MUST NOT be resent with the same content. (The harness checks this: `Violation::ResentAfterTimeout`) |
| S6 | An emulated operation built from several device commands (for example a rate-controlled bolus as micro-boluses) MUST be recoverable from device history after a crash, and MUST report exactly what was delivered (`Approximated`) |
| S7 | Therapy state becomes `Unknown` on link loss for any region that was active; it is only cleared by observing the device |
| S8 | Bolus progress is reported from what the device says it delivered, never extrapolated |

## Cryptography and counters

| # | Rule |
|---|---|
| S9 | Counters and nonces are stored (`Class::Monotonic`) before they are used on the wire; a value is never reused, even after a crash |
| S10 | Keys and session material are `Secret` (zeroised, redacted in `Debug`), stored with `Class::Secret`, and never logged. Scope under discussion, see [Q16](14-open-questions.md#q16-how-strict-should-secret-handling-be-s10) |
| S11 | Crypto uses established crates (for example RustCrypto `chacha20poly1305`); a driver never implements a cipher itself |
| S12 | Every crypto and framing path has known-answer test vectors, ideally from real device captures |

## Code

| # | Rule |
|---|---|
| S13 | `#![forbid(unsafe_code)]` in every crate |
| S14 | No `panic!`, `unwrap`, `expect` or unchecked indexing on data received from the radio. Parsers return errors |
| S15 | Arithmetic on doses, rates and durations is checked or saturating, and the choice is deliberate |
| S16 | Device behaviour that is assumed rather than confirmed is listed in `.docs/to-confirm.md` with the bench test that settles it (as `pump-ypso` does) |

## Glucose data (Proposal)

CGM readings feed dosing decisions, so a wrong value is as dangerous as a wrong dose. Details in [06](06-data-model.md#cgm-data-model-proposal).

| # | Rule |
|---|---|
| S19 | A driver reads and reports every sensor-reported failure, expiry or temporary issue the protocol carries. Readings taken during any of them are flagged unusable |
| S20 | Signal loss is measured from the last reading with a value, never from the last record, so a sensor streaming without values does not look active |
| S21 | A driver's own heuristics may flag readings but never end a sensor. A state that ends a sensor is entered only after it is confirmed over several consecutive new records |

## Testing hardware

| # | Rule |
|---|---|
| S17 | Tools that talk to real radios MUST only connect to known simulators, never to whatever is in range. (Current: `tester` only connects to an exact advertised name ending in the simulator serial `3735928559`) |
| S18 | Delivery commands MUST NOT be run against a pump attached to a person during development |

## Regulatory note

This guideline does not make a driver a medical device, and following it is not a substitute for the clinical and regulatory responsibilities of anyone who distributes an AID system. Each app project remains responsible for what it ships.
