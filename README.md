# ExcelTools — Transfer Catalog Intake Form

A zero-dependency web form for entering **Catalog / Suppliers rows** for the Kotis
transfer-recommendation workbook — dropdowns and validation instead of open Excel
access. Served via GitHub Pages from `index.html`.

**How it's used:** fill the form (or paste a row copied from the live Excel sheet),
then copy the tab-separated row back out into Excel — or download a fragment CSV for
the sheet maintainer to merge. The Excel workbook remains the source of truth;
this form is a guarded entry path into it.

**Generated — do not hand-edit.** Both files are built from the
`TransferRecommendationTool` repo:

```bash
node tools/intake/build-public-site.mjs   # from the TransferRecommendationTool repo
```

- `index.html` — copy of `tools/intake/intake.html` with the data script pointed locally
- `transfer-data.js` — trimmed data module: **one catalog row per supplier** (the last
  in each supplier's series, so the "suggest next" id button stays collision-free);
  full supplier list and vocabulary kept

Self-test: open `index.html?smoke=1` — the page title reports `KCP-INTAKE PASS`.
