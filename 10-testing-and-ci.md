# 10. Testing and CI

## Test layers

Every driver has all of these. Each layer catches a different class of bug.

| Layer | What it tests | Where | Data |
|---|---|---|---|
| **Unit** | One pure function: a codec, CRC, unit conversion, counter policy, `Bounds` arithmetic | `#[cfg(test)]` in each module | Hand-written |
| **Known-answer vectors** | Framing and crypto produce exactly the bytes the real device sends and accepts | `tests/crypto_vectors.rs` | **Real** captures from devices or reference implementations |
| **Engine** | The engine against scripted completions: every branch of every command, every refusal | `tests/engine.rs` | Synthetic |
| **Simulator** | The device simulator behaves like the device (so it can be trusted in end-to-end tests) | `tests/sim/` | Synthetic, checked against `.docs/to-confirm.md` |
| **End-to-end (in process)** | Engine + simulator through `tester-harness`, with virtual time and fault injection | `tests/e2e.rs` | Synthetic |
| **End-to-end (over BLE)** | Same scenarios, through a real BLE stack, against the nRF52840 simulator | `tester` with `--target ble` | Synthetic, real radio |
| **Bench** | The real device. Settles `.docs/to-confirm.md` items | Manual, documented | **Real** |

## Fault sweeps

The most valuable end-to-end tests are sweeps: run a scenario once to count its steps, then rerun it with a fault injected at **each** step. The harness supports:

| Fault | Simulates |
|---|---|
| `BleTimeout` | A write or read that gets no answer |
| `BleDisconnected` | The link dropping mid-operation |
| `BleStatus(code)` | An ATT or device error code |
| `HostFails` | Storage, keystore or RNG failing |

and checks these invariants on every run:

| Violation | Meaning |
|---|---|
| `ResentAfterTimeout` | A timed-out write was resent unchanged (could double-deliver) |
| `CompletionRejected` | The engine rejected a valid completion (host/engine disagreement) |
| `NeverSettled` | The engine kept producing actions forever |
| `UnannouncedSubscribe` | The engine subscribed to a characteristic not declared in `DriverInfo` |

Drivers SHOULD add their own invariants on top, for example "after any fault, a fresh session resumes counters from storage" or "an `Unknown` bolus is never resubmitted".

## Coverage

Every crate MUST reach **100 % of lines, regions and functions** with `cargo llvm-cov`. This is already the gate in `pump-shared`, `pump-ypso`, `simulator-bridge` and `tester`, so it is a proven target, not an aspiration. With AI-assisted test writing the cost of the last few percent is low.

| Code | Gate |
|---|---|
| Shared crates, drivers, simulators, harness | 100 % lines, regions, functions |
| Hardware-bound code (real radio in `tester`, firmware crates) | Excluded only behind a feature (`radio`) or outside the workspace (`crates/nrf52840`), and the exclusion listed in the README |
| `#[coverage(off)]` or similar per-function exclusions | Not allowed without a reviewer's approval and a comment saying why |

How to keep 100 % achievable:

- **Make impossible states unrepresentable** instead of writing defensive branches that tests cannot reach. A branch no test can reach is usually a sign the types are too loose.
- **Cover error paths with fault sweeps**, not one hand-written test per branch. The harness injects a fault at every step, which reaches most error handling automatically.
- **Keep hardware glue thin.** Put logic in host-testable crates (like `simulator-bridge`) so the excluded firmware crate stays small.

### Coverage is not enough: mutation testing

100 % coverage shows every line ran, not that any test would notice if it were wrong. This matters more when tests are generated with AI, which can produce tests that execute code without checking it. So, on top of the coverage gate:

- Run [`cargo-mutants`](https://github.com/sourcefrog/cargo-mutants) on `protocol/`, `counters`, `engine/` and the shared crates. It changes the code (flips a comparison, replaces a return value) and checks that a test fails.
- In CI, run it on the files changed by each pull request (`cargo mutants --in-diff`), and on the whole crate nightly.
- A surviving mutant in a codec, counter, limit check or delivery path MUST be killed by a new test or explained in the PR.
- Reviewers SHOULD reject tests that only execute code without asserting on its result.

## Formal verification

Optional, encouraged for small pure functions where a bug is dangerous and the input space is bounded:

| Target | Property | Tool |
|---|---|---|
| Frame split and reassembly | `reassemble(split(x)) == x` for all `x` up to N bytes | Kani, or `proptest` as a cheaper first step |
| CRC, unit conversion | Matches a reference implementation for all inputs | Kani |
| `Bounds::floor` / `nearest` | Result is allowed, at or below the input (floor), and closest | Kani, Creusot |
| Counter policy | Never returns a value already used | Kani, Verus |
| Therapy transitions | No transition leaves an invalid state | Exhaustive test over the generated graph |

Property-based tests (`proptest`) SHOULD be used wherever a round-trip or invariant exists.

## CI

Every repository MUST run on push to `main` and on every pull request. Reference workflow (as used today):

```yaml
name: ci
on:
  push: { branches: [main] }
  pull_request:
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
        with:
          components: rustfmt, clippy, llvm-tools-preview
          targets: thumbv7em-none-eabihf
      - uses: taiki-e/install-action@cargo-llvm-cov
      - run: cargo fmt --all --check
      - run: cargo clippy --workspace --all-features --all-targets -- -D warnings
      # platform independence: every meaningful feature combination on bare metal
      - run: cargo build --no-default-features --target thumbv7em-none-eabihf
      - run: cargo build --no-default-features --features delivery --target thumbv7em-none-eabihf
      - run: cargo build --no-default-features --features sim --target thumbv7em-none-eabihf
      - run: cargo llvm-cov --all-features --fail-under-lines 100 --fail-under-regions 100 --fail-under-functions 100
```

Proposed additions:

- `cargo mutants --in-diff` on pull requests, and a full mutation run nightly.
- `cargo test --no-default-features` so `no_std` code paths are tested, not just built.
- A minimum-supported-Rust-version job (`rust-version = "1.85"` today).
- `cargo audit` / `cargo deny`.
- A cross-repository job in `tester` that runs every driver's scenarios against the latest `pump-shared`, so a contract change cannot silently break a driver.
- A shared reusable workflow (`open-source-aid/.github`) so every driver repository runs the same checks.
