import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";
import katex from "../../docs-site/node_modules/katex/dist/katex.mjs";

const output = fileURLToPath(new URL("./scoring-equations.png", import.meta.url));
const stylesheetPath = fileURLToPath(
  new URL("../../docs-site/node_modules/katex/dist/katex.min.css", import.meta.url),
);
const stylesheetBase = new URL(
  "../../docs-site/node_modules/katex/dist/",
  import.meta.url,
).href;
const stylesheet = readFileSync(stylesheetPath, "utf8");

const equations = [
  ["Exact allele", String.raw`v=(g,c,p,r,a)`],
  [
    "Impact category",
    String.raw`I(x)=\begin{cases}1.00,&x=\mathrm{HIGH}\\0.67,&x=\mathrm{MODERATE}\\0.33,&x=\mathrm{LOW}\\0.10,&x=\mathrm{MODIFIER}\end{cases}`,
  ],
  [
    "Transcript aggregation",
    String.raw`I(v)=\max_{t\in T(v)} I\!\left(\operatorname{impact}(v,t)\right)`,
  ],
  ["Saturation candidate", String.raw`s(v_{p,a})=w_I I(v_{p,a})`],
  [
    "Candidate choice",
    String.raw`a_p^*=\begin{cases}\displaystyle\arg\min_{a\in E_p}s(v_{p,a}),&\mathrm{Minimize}\\[4pt]\displaystyle\arg\max_{a\in E_p}s(v_{p,a}),&\mathrm{Maximize}\end{cases}`,
  ],
  [
    "Selection total",
    String.raw`S=\sum_{p\in P}\sum_{h\in H_p}s(v_{p,h}),\qquad \Delta S=S_{\mathrm{after}}-S_{\mathrm{before}}`,
  ],
  [
    "Track Monitor",
    String.raw`\Delta I_m=I(v_m^{\mathrm{current}})-I(v_m^{\mathrm{source}}),\qquad \Delta I_{\mathrm{track}}=\sum_{m\in M}\Delta I_m`,
  ],
  [
    "Normalized monitor",
    String.raw`\overline{\Delta I}=\frac{\Delta I_{\mathrm{track}}}{|M|}`,
  ],
];

const rows = equations
  .map(
    ([label, equation]) => `
      <div class="row">
        <div class="label">${label}</div>
        <div class="equation">${katex.renderToString(equation, {
          displayMode: true,
          throwOnError: true,
          output: "html",
        })}</div>
      </div>`,
  )
  .join("");

const html = `<!doctype html>
  <html>
    <head>
      <meta charset="utf-8">
      <base href="${stylesheetBase}">
      <style>${stylesheet}</style>
      <style>
        * { box-sizing: border-box; }
        body { margin: 0; background: #ffffff; color: #111820; font-family: Arial, sans-serif; }
        .sheet { width: 1200px; padding: 28px 34px; }
        .row {
          display: grid;
          grid-template-columns: 205px 1fr;
          align-items: center;
          min-height: 88px;
          border-bottom: 1px solid #d8dde2;
        }
        .row:last-child { border-bottom: 0; }
        .label {
          color: #33434f;
          font-size: 19px;
          font-weight: 700;
          padding-right: 24px;
        }
        .equation { padding: 8px 12px; text-align: center; }
        .equation .katex { font-size: 1.55em; }
        .katex-display { margin: 0; }
      </style>
    </head>
    <body><main class="sheet">${rows}</main></body>
  </html>`;

const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || "/snap/bin/chromium",
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
await page.setContent(html, { waitUntil: "load" });
await page.locator(".sheet").screenshot({ path: output });
await browser.close();

console.log(output);
