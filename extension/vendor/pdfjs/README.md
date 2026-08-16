# Enable PDF ingestion

mem doesn't bundle PDF.js by default (it's ~1.5 MB and most users don't need PDF). To enable PDF imports:

1. Download the two files from a recent **pdfjs-dist** release on npm or GitHub:
   - `pdf.min.js`
   - `pdf.worker.min.js`
2. Place them in this folder (`extension/vendor/pdfjs/`).
3. Open `extension/options.html` and add this single line at the bottom of `<head>`:
   ```html
   <script src="vendor/pdfjs/pdf.min.js"></script>
   ```
4. Reload the extension in `chrome://extensions`.
5. The Files panel will now accept `.pdf` uploads.

If you want PDF support across pages too (e.g. saving an open PDF in a tab), do the same load in `dashboard.html`. The `parseFile()` helper checks `globalThis.pdfjsLib` and uses it whenever it's available.
