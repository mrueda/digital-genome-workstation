# Contributing

DGW is currently a focused side project. Keep genome processing on the user's computer, keep the software research-only, and follow the contracts in `docs-site/docs/`.

Before submitting a change, run:

```bash
npm run build
npm test
cargo test -p dgw-core
```

Linux contributors compiling the Tauri shell also need GTK 3, WebKitGTK 4.1, and librsvg development packages. Do not commit human subject data, COSMIC-derived records, proprietary databases, generated `.dgw` projects, or large compressed VCFs. New fixtures must be synthetic or clearly redistributable.

Source contributions are accepted under Apache-2.0.
