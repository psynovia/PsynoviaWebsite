# Psynovia Onepager

Diese Version funktioniert auch lokal per Doppelklick auf `index.html`, weil keine ES-Module verwendet werden.

## Struktur
- `index.html` – Einstieg
- `css/styles.css` – globales Styling
- `content/pages.js` – Inhalte / Reihenfolge der Blöcke
- `js/app.js` – Rendering / Menülogik
- `js/components/` – einzelne Block-Renderer

## Lokal öffnen
Einfach `index.html` im Browser öffnen.

## Für Netlify / GitHub
Den gesamten Ordner in ein Git-Repository legen und mit Netlify verbinden.
Build Command: leer lassen
Publish Directory: `/`
