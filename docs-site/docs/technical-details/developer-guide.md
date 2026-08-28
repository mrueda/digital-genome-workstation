# Developer Guide

## Repository layout

```text
crates/dgw-core/   biological and persistence engine
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

