# 18. Case study: Sibionics — the same vendor, twice

Sibionics sells two generations of CGM under one app family: the **GS3** (the
current one) and the older **GS1** line (GS1, GS1+, GS1 Eco, and the GS1-3E,
LS1/KS1, GS2 … variants). Both come from one vendor, both are used through the
same phone app code, and they even share the same GATT service numbers — which
makes them a good test of where the *variant* line is.

The short version: **the GS3's regional builds are variants; GS1 is a second
driver.** Neither the vendor nor the app is what decides it — the protocol is.

## 1. The GS3's regional builds are variants

The same GS3 sensor is sold under different app families, and each family
presents different registration material during the handshake. The radio
advertisement is identical, so a driver cannot tell them apart before
connecting; the app offers a picker, the driver matches the advertisement to the
device, and the chosen entry is handed to the engine, which uses it for exactly
one thing: which registration material to present.

That is the textbook case from [17](17-terminology.md#variants-feature-flags-and-related-terms):

* one protocol, one crate, one `static DRIVER`;
* the members differ only in a model or security detail that the engine needs as
  a *parameter*;
* the variant is chosen at run time, per device, by the host from a list the
  driver publishes;
* nothing in the framing, the message set or the reading format changes.

It is the same shape as `ypso`/`ypso-opn` and `dana-rs`/`dana-rs-v3`: the
protocol is one, the security scheme is not.

## 2. GS1 is a different driver

GS1 looks similar from the outside and is a different protocol underneath:

| | GS3 | GS1 |
|---|---|---|
| Transport security | a per-session cipher keyed from the device address | a fixed obfuscation key, no session |
| Message set | one small set | a different set, with activation and configuration steps |
| What a reading carries | glucose already computed by the sensor | the raw electrode signal and temperature |
| Who computes glucose | the sensor | the phone, with a stateful algorithm |
| Sensor health | one status byte the sensor reports | per-reading warnings the app interprets, plus a counter of abnormal readings |
| State the driver must keep | session, index | session, index, and the algorithm's own long-lived state |

A variant is allowed to change the model and the security material. It is not
allowed to change the message set, the reading format, who computes the value,
or the health model. GS1 changes all four, so it is a different **device
family**: its own driver, its own crate, its own `static DRIVER`.

The mechanical signs agree. `DriverInfo.protocol`, the advertisement match, the
GATT surface and the command list are static per driver, and a variant is only a
parameter passed to `new_engine`. Making GS1 a variant would mean branching the
engine on the variant for the cipher, the framing, the message set, the record
parser, the algorithm and the health rules — two drivers pretending to be one.

The feature flags follow: a whole protocol should be excludable from a build
(`gs3` / `gs1`), because a build that only ever drives one generation should not
carry the other's protocol, its variants or its simulator.

## 3. What is still shared, and where it goes

R2 says a driver depends on shared crates only, never on another driver crate.
So for a vendor with two generations, every shared piece has exactly two
destinations: **a shared crate** if it carries no device knowledge, or
**duplication** if it does.

Shared, because it is generic CGM semantics:

* readings, sensor state, quality flags, warm-up and trend — already in
  `cgm-shared`;
* the warm-up / wear / signal-loss / trend and rate logic — the same questions
  for both generations, parameterised by record cadence, warm-up, wear, trend
  source and value source. This is the largest genuinely shared piece, and it
  is the textbook "moves into a shared crate when a second driver needs it".

Shared, because it is a codec and knows nothing about the device:

* the checksum, the length-prefixed framing helpers and the cipher primitives.

Duplicated, because it *is* device knowledge:

* the GATT service and characteristic numbers, even though the two generations
  happen to use the same ones. A shared crate must not know a sensor's
  characteristics, and R2 forbids the GS1 crate reaching into the GS3 one, so
  the constants are written twice. That is the guideline working as intended.

Never shared:

* message sets, record parsers and link state machines — the protocol *is* the
  crate's identity;
* health policy. The two generations disagree on where health comes from, so the
  *policy* stays per driver even though the vocabulary it reports through is
  shared;
* the algorithm. It exists only for the generation that sends raw signals.

## 4. What this changes in the contract

Two consequences that are about the shared contract, not about Sibionics:

* **A recoverable sensor state.** Both generations can report "the sensor is
  having a temporary issue, wait rather than replace it", and today
  `SensorState` cannot express it — a driver can only flag readings, and the app
  shows signal loss. That belongs in the shared state, not in a per-driver enum
  ([Q18](14-open-questions.md#q18-a-recoverable-sensor-state-in-cgm-shared)).
  The CGM proposals S19–S21 already describe the behaviour: report the sensor's
  own status, measure signal loss from the last reading *with a value*, and let
  a driver heuristic flag readings but never end a sensor on its own.
* **One `static DRIVER` per crate.** Two generations means two crates for one
  vendor. If a later decision allows several `static DRIVER`s per crate, this
  case is one of the reasons to revisit it — but the *protocol* boundary would
  not move.

## 5. Lessons

* **"Same vendor" and "same app" are not variant criteria.** The criterion is
  "same protocol, different model or security material".
* **A variant is a parameter.** If the engine has to branch on it for framing,
  parsing or the health model, it is a second driver.
* **Absence is a boundary signal too.** No health byte on one generation and no
  on-phone algorithm on the other are differences a variant cannot hide.
* **Share semantics and codecs; duplicate device knowledge.** A 40-line block of
  GATT constants is cheaper than a device-specific shared crate that R2 would
  not allow anyway.
* **Let the second driver pull code up.** The monitor belongs in `cgm-shared`
  when GS1 lands, not before — but it is worth designing the GS3 driver so that
  the generic part is separable today.
