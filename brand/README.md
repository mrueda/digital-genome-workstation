# DGW visual identity

`dgw-mark.svg` is the canonical Digital Genome Workstation logo. It represents one source genome track branching into an unchanged alternative and an editable alternative; the amber diamond is a visible variant edit block.

Use the mark without recoloring, stretching, rotating, adding effects, or changing its proportions. Keep the rounded charcoal tile when the mark is displayed on either light or dark backgrounds.

The canonical colors are charcoal `#151718`, cyan `#65C5D8`, violet `#8D70E8`, and amber `#F2B84B`. Platform-specific raster icons are generated from the SVG with:

```bash
npx tauri icon brand/dgw-mark.svg --output src-tauri/icons --ios-color '#151718'
```
