# Developer Guide

To use DGW without modifying it, follow [Install DGW](../usage/installation.md). The instructions below are for contributors building from source.

## Build and run from source

Install Rust 1.86+, Node.js 20+ and the [Tauri platform prerequisites](https://v2.tauri.app/start/prerequisites/). Run commands from the repository root unless noted otherwise.

On Ubuntu/Debian, the native build dependencies include:

```bash
sudo apt-get update
sudo apt-get install -y libgtk-3-dev libwebkit2gtk-4.1-dev librsvg2-dev
```

These are development-machine dependencies, not end-user installation steps. macOS builds require Xcode command-line tools; Windows builds require the corresponding native toolchain described in the Tauri prerequisites.

```bash
npm ci
npm run build
npm test
cargo test --workspace
npm run tauri dev
```

Configure genome resources through the app. Debug builds can discover `config/local-*.development.json`; these profiles contain machine-specific paths and are not portable resource packages. Release builds use registered resources and the bundled download catalog.

## Build installers

Use the manual **Build test installers** workflow, or **Build macOS test installer** for a selected Mac architecture. Artifacts are private while the repository is private and are not automatically published to a release. For native local builds:

```bash
# Linux
npm run tauri build -- --bundles appimage
# macOS (run on a Mac)
npm run tauri build -- --bundles dmg
# Windows (run on Windows)
npm run tauri build -- --bundles nsis
```

The FUSE-free Linux tar package additionally uses `scripts/package-portable.py`, which requires Python 3.11+ and a matching C compiler. See [installer validation](../usage/test-installation.md) for clean-machine checks and known limitations.

## Repository layout

```text
crates/dgw-core/   biological and persistence engine
crates/dgw-mcp/    local agent command interface
src-tauri/         Tauri desktop bridge
src/               React/TypeScript interface
docs-site/         Docusaurus documentation
fixtures/          redistributable synthetic inputs
config/            local resource-bundle profiles
```

## Verify a change

```bash
cargo fmt --all -- --check
cargo test -p dgw-core
cargo test -p dgw-mcp
npm test
npm run build
```

With native Linux dependencies installed:

```bash
cargo check -p dgw-desktop
npm run tauri dev
```

Build the documentation independently:

```bash
cd docs-site
npm ci
npm run typecheck
npm run build
```

Do not commit patient data, licensed resource extracts, `.dgw` packages, or large compressed VCFs. Scientific behavior belongs in `dgw-core`; the frontend should not recreate normalization, genotype, evidence, or state rules.
