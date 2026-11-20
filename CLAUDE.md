# OS-AID driver guideline: instructions for agents

This folder holds the OS-AID Unified Driver Guideline. Follow it whenever you write, change or review a u-osaid crate: pump, CGM or uploader drivers, shared crates, simulators, `tester` and bindings.

These drivers deliver insulin, so a safety rule is never a style preference. If a task would break a rule here, stop and say so. Do not work around the rule.

## How to use this folder

- This file is a summary. The numbered chapters are authoritative, and where they disagree with this file, the chapter wins. Read the relevant chapter before you start; don't work from memory.
- Rule IDs (R1–R11, E1–E10, S1–S18) are stable. Cite them in code comments, commit messages and review findings, for example `// S4: outcome is Unknown, never retried`.
- In the chapters, **Current** marks what the repositories already do, and **Proposal** marks text the group has not agreed on. Implement Current behaviour. Don't implement a Proposal unless the task asks for it, and if it does, say so in the PR.
- The decisions still open are listed in [14-open-questions.md](14-open-questions.md) as Q1–Q17. Don't settle one yourself. If your work depends on one, pick the least committal option, mark it in the code with `// Open: Qn`, and mention it in your summary.
- [17-terminology.md](17-terminology.md) defines the terms. Use them exactly. In particular, a *variant* is chosen per device at run time, a *feature flag* is chosen per build at compile time, and *capabilities*, *limits* and *configuration* are three different things.
- The reference code lives in the sibling repositories of the `u-osaid` GitHub organisation: `pump-shared`, `pump-yspo` (crate `pump-ypso`; the repository name is a typo, ignore it), `simulator` and `tester`. They are usually checked out next to this repository (`../pump-shared` and so on); if they are not, clone them from `github.com/u-osaid`. When the guideline says "follow the reference driver", read `pump-ypso`.

| Task | Read first |
|---|---|
| New driver, or review of a driver PR | [15-new-driver-checklist.md](15-new-driver-checklist.md), then [04](04-driver-contract.md), [08](08-safety.md), [10](10-testing-and-ci.md) |
| Engine or protocol work | [04-driver-contract.md](04-driver-contract.md), [05-state-machines.md](05-state-machines.md) |
| Units, limits, history, glucose | [06-data-model.md](06-data-model.md) |
| Deciding whether code belongs in the driver, the host or the adapter | [07-platform-boundary.md](07-platform-boundary.md) |
| Adding a dependency | [09-dependencies-and-licensing.md](09-dependencies-and-licensing.md) |
| Simulator or firmware work | [11-simulators.md](11-simulators.md) |
| Releases, API changes | [12-versioning-and-releases.md](12-versioning-and-releases.md) |
| AAPS, Trio or Loop wrappers, bindings | [13-app-integration.md](13-app-integration.md), [16-case-study-dana.md](16-case-study-dana.md) |

## Non-negotiable rules

### Architecture

- **No algorithm awareness (R1).** A driver knows nothing about oref, IOB, COB or any dosing logic. Commands are plain device operations such as `Bolus` and `TempBasal`.
- **No cross-driver dependencies (R2).** A driver depends on shared crates only, never on another `pump-*`, `cgm-*` or `uploader-*` crate.
- **A utility moves into a shared crate only when a second driver needs it,** and shared crates contain no device-specific knowledge.
- **Sans-IO and synchronous (R5, R6, E2).** The `Engine` is a poll-based state machine with `submit`, `stop`, `handle_completion`, `poll_action`, `poll_event` and `poll_timeout`.
  - The public API has no `async`, threads, executors, sleeping or blocking.
  - Engines never read a clock themselves; time comes from the host.
- **Platform-free (R8).** Crates are `#![no_std]` + `alloc` without the `std` feature, and they MUST build with `--no-default-features --target thumbv7em-none-eabihf`.
- **Platform boundary ([07](07-platform-boundary.md)).** Ask the three questions in order:
  1. Would two apps have to write the same logic? Then it goes in the driver.
  2. Does it call an OS API? Then it belongs to the host, reached through an `Action`.
  3. Does it depend on one app's model, settings or UI? Then it belongs to the adapter.
- **Thin wrappers ([13](13-app-integration.md)).** Bindings and app adapters add no logic. If Kotlin and Swift would both need something, it goes in Rust.

### Engine contract ([04](04-driver-contract.md))

- **One static `DRIVER`, and its `DriverInfo` declares everything.** That means every GATT characteristic and notification, every storage slot and class, every command and every feature, plus `api_version: pump_shared::API_VERSION`.
- **E1: one action outstanding at a time.** A wrong or foreign completion returns `CompletionError` and changes nothing.
- **E3: `submit` only queues.** A full queue returns `QueueFull`.
- **E4: `stop()` is always accepted** and pre-empts the queue.
- **E5: every `submit` ends with exactly one `Event::Finished`.**
- **E6, E7: persist before use.** State that must survive a restart is written with `Action::Store` before it is relied on. `Class::Monotonic` values are stored before they go on the wire.
- **E8: link loss makes in-flight work `Unknown`.** After `handle_link_lost`, anything in flight that may have reached the device finishes as `Outcome::Unknown`.
- **Therapy state goes through the shared `TherapyMachine` only.** Apply `LinkLost` and `Observed`, and never keep a private copy of therapy state.
- **The protocol machine is fully input-driven** ([05](05-state-machines.md)). It takes a bounded number of steps per command and has a defined state after every possible `Completion`.
- **Protocol internals never appear as interface parameters** ([07](07-platform-boundary.md#auxiliary-inputs)). Rolling bytes, counters and session tokens stay private engine state, persisted to declared slots. User input that is known up front becomes a command parameter.

### Data model ([06](06-data-model.md))

- **Integers only.** Insulin is in milli-units (`u32`) and rates in milli-units per hour. Percent is a `u16`, where 100 means neutral.
- **Convert at the protocol boundary.** Nothing above the driver sees a device-specific unit.
- **Glucose is always `MgDl(u16)`, in both directions.** The app converts mmol/L.
  - If the device uses mmol/L internally, convert it in the protocol layer and keep the original bytes in `raw`.
  - Don't use sentinel values such as 0, 39 or 401. Represent those conditions as states (`Option` or an enum).
- **An unknown value is `None`, never an estimate.** History entries keep their `raw` bytes.
- **Read capabilities and limits from the device** where the protocol allows it. A hard-coded value cites its source in a comment.
- **Refuse, don't round.** A value that `Bounds::allows` rejects is refused with `Refusal::OutOfLimits`. Rounding is the adapter's job.

### Safety ([08](08-safety.md))

- **S1:** Commands that deliver insulin are behind the `delivery` feature, which is off by default. Without it they return `Refusal::NotBuilt`.
- **S2:** Stop paths are never gated. These are `CancelTempBasal`, `CancelExtendedBolus`, `Suspend`, a 100 % temp basal and `stop()`.
- **S3:** A driver never changes a requested amount.
- **S4, S5:** An uncertain delivery gives `Unknown` and sets `delivery_uncertain`, and is never retried. A write that timed out is never resent unchanged.
- **S6:** An emulated operation must be recoverable from device history, and it reports exactly what was delivered as `Approximated`.
- **S7, S8:** Therapy state becomes `Unknown` on link loss. Bolus progress comes from what the device reports, never from extrapolation.
- **S9:** Counters and nonces are stored before use and never reused.
- **S10:** Keys and session material are `Secret` and are never logged; `Event::Log` never contains secrets. How strict to be is still open as Q16, but until it's settled, apply S10 as written.
- **S11, S12:** Use established crypto crates and never hand-roll a cipher. Every crypto and framing path has known-answer vectors, from real captures where possible.
- **S13, S14, S15:** Use `#![forbid(unsafe_code)]`. Don't use `panic!`, `unwrap`, `expect` or unchecked indexing on radio data. Arithmetic on doses, rates and durations is deliberately checked or saturating.
- **S16:** Unconfirmed device behaviour goes in `.docs/to-confirm.md`, together with the bench test that would settle it.
- **S17, S18:** Tools only connect to known simulators, never to whatever is in range. Never run delivery commands against a pump attached to a person, and never point any tool you run at a real pump.

### Repository layout ([03](03-repositories-and-crates.md))

- **Naming.** Repositories are named `pump-<manufacturer>[-<model>]`, `cgm-…` or `uploader-<service>`, and the crate name matches the repository. Each repository holds one device family; models within it are `Variant`s.
- **Layout.** Use `src/{lib.rs, driver.rs, protocol/, counters.rs, engine/, sim/}` and `tests/{crypto_vectors.rs, engine.rs, e2e.rs, sim/}`.
  - `protocol/` is pure functions and data only.
  - `engine/` alone holds session state.
  - `sim/` compiles only with the `sim` feature.
- **Features.** The features are `std` (default), `sim`, `delivery`, and variant features such as `opn`.
- **Required files.** Every repository has `LICENSE` (AGPL-3.0-or-later), `NOTICE.md` (derivation, third-party code and a trademark disclaimer), and `.docs/` recording protocol knowledge and its source.

### Dependencies ([09](09-dependencies-and-licensing.md))

- **Every runtime dependency must meet all of these:**
  - `no_std` with `default-features = false`;
  - reputable (prefer the RustCrypto, `dalek`, `zeroize` and `libm` families);
  - licence-compatible with AGPL (MIT, Apache or BSD);
  - actually necessary.
- **Justify each new crate in the PR.** If a few lines of code would do, don't add a crate for it.

## Definition of done

A change is not done until every one of these passes in the crate you touched:

```sh
cargo fmt --all --check
cargo clippy --workspace --all-features --all-targets -- -D warnings
cargo build --no-default-features --target thumbv7em-none-eabihf
cargo build --no-default-features --features delivery --target thumbv7em-none-eabihf
cargo build --no-default-features --features sim --target thumbv7em-none-eabihf
cargo llvm-cov --all-features --fail-under-lines 100 --fail-under-regions 100 --fail-under-functions 100
```

The tests themselves must also meet the bar ([10](10-testing-and-ci.md)):

- **100 % coverage of lines, regions and functions (R11).** Exclude hardware-bound code only behind a documented feature, never with ad-hoc `#[coverage(off)]`.
- **Tests assert results.** A test that only executes code doesn't count.
- **New behaviour is tested at every layer it touches:**
  - unit tests;
  - vectors;
  - engine tests for every command, refusal and outcome;
  - simulator tests;
  - an end-to-end run through `tester-harness` with fault sweeps (`BleTimeout`, `BleDisconnected`, `BleStatus`, `HostFails`) at every step.
- **No harness violations.** `ResentAfterTimeout`, `CompletionRejected`, `NeverSettled` and `UnannouncedSubscribe` must not appear.
- **Mutation testing.** Kill or explain every surviving `cargo mutants` result in codec, counter, limit or delivery code.
- **Property tests.** Use `proptest` wherever a round-trip or invariant exists.
- **Simulators** ([11](11-simulators.md)) are deterministic for a given input and `now`. They reproduce the device's error codes, keep device history, and respond to the universal controls.
- **Contract changes.** Any incompatible change bumps `API_VERSION`. A `CHANGELOG.md` entry separates device-visible changes from API changes ([12](12-versioning-and-releases.md)).

Before you finish, go through [15-new-driver-checklist.md](15-new-driver-checklist.md) and report anything left unticked.

## Working practices

- **Don't commit or push unless you're asked to.** Never commit secrets, captures that contain keys, or personal data.
- **Port behaviour, not bugs.** When porting from AAPS (Kotlin) or Trio/DanaKit (Swift), compare both implementations. Where they disagree, record it in `.docs/to-confirm.md` instead of picking one silently. [16](16-case-study-dana.md) shows the pattern.
- **Record provenance.** Note the source of reverse-engineered protocol knowledge in `.docs/`, and credit derived code in `NOTICE.md`.
- **Stop and ask** when a requirement conflicts with a rule here, a safety question has no clear answer, or the work depends on an open question.

## Editing the guideline itself

- **Keep the conventions.**
  - Use RFC 2119 keywords in capitals.
  - Mark text **Current** or **Proposal**.
  - Add new rules with the next free number in their series, and never renumber existing ones.
  - Add new decisions to [14-open-questions.md](14-open-questions.md) as the next Q number.
  - Add new terms to [17-terminology.md](17-terminology.md), not to individual chapters. Diabetes terms (IOB, COB, …) are assumed knowledge and not defined.
- **Write cross-references as `NN-file.md#fragment`,** even inside the same file, because the page generator rewrites only that form.
- **The HTML page is generated, never committed.** `site/build.mjs` turns `README.md` and the numbered chapters into one page, and the `pages` workflow publishes it to GitHub Pages on every push to `main`. Files that don't start with `NN-` (such as this one) are left out. To preview locally, run `cd site && npm ci && npm run build` and open `_site/index.html`.
