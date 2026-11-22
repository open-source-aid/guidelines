# 9. Dependencies and licensing

## Platform independence

- Driver and shared crates MUST be `#![no_std]` with `alloc` when built without the `std` feature.
- CI MUST build with `--no-default-features --target thumbv7em-none-eabihf` (a bare-metal target). If it builds there, it has no hidden OS dependency.
- No crate may depend on a BLE stack, a file system, an async runtime (`tokio`, `async-std`, `embassy`), a logger implementation, or platform SDKs. Those belong in hosts.
- Test-only and tool crates (`tester`, `simulator` firmware, `xtask`) MAY use `std` and platform crates; they are never linked into an app.

## Choosing a dependency

A runtime dependency of a driver or shared crate MUST:

| Criterion | Detail |
|---|---|
| Be `no_std` capable | With `default-features = false` |
| Be reputable | Widely used and maintained; prefer the RustCrypto, `dalek`, `zeroize`, `libm` families. Check downloads, maintainers, recent releases, and open security advisories (`cargo audit`) |
| Have a compatible licence | MIT, Apache-2.0, BSD or similar, compatible with AGPL-3.0-or-later |
| Be necessary | Do not add a crate for a few lines of code. Do not add a crate that duplicates a shared crate |
| Be pinned through `Cargo.lock` in CI | And reviewed when updated |

**Current runtime dependencies** for reference: `pump-shared` uses only `zeroize`; `pump-ypso` adds `chacha20poly1305` and `libm`, plus `chacha20` and `curve25519-dalek` for the simulator only.

Recommended CI additions (Proposal): `cargo audit` and `cargo deny` (licences, advisories, duplicate versions).

## Dependencies between open-source-aid crates

| From | May depend on |
|---|---|
| Shared crate | Other shared crates below it, external crates |
| Driver | Shared crates only. **Never another driver** |
| Simulator host (`simulator`) | Shared crates; device simulators through optional features (`ypso-sim`) |
| `tester` | Shared crates; drivers as dev-dependencies |
| Bindings | Shared crates and every driver it exposes |

## Licensing

- All crates are **AGPL-3.0-or-later** (**Current**).
- Code derived from another project MUST be credited in `NOTICE.md`, naming the project, author and licence, as `pump-ypso` does for `rockit-driver-ypso`.
- Device and company names are trademarks. `NOTICE.md` MUST say the project is not made or endorsed by the manufacturer, and names are used only to identify compatible devices.
- Protocol knowledge from reverse engineering MUST record its source (capture, firmware analysis, prior open-source driver) in `.docs/`, so it can be verified and so provenance is clear.
- **Open point:** the target apps do not all use the same licence. The group should check each app's licence and confirm that linking an AGPL driver works for every target app and how it is distributed ([14](14-open-questions.md#q8-licence-compatibility)).
