# App icons

Drop the following PNG files here for PWA install support:

- `icon-192.png` — 192×192, opaque, full-bleed Mesh logo
- `icon-512.png` — 512×512, same as above
- `icon-maskable-512.png` — 512×512 with 20% safe-zone padding (for Android adaptive icons)

For now the manifest references these paths; the app degrades gracefully if the files are missing (browser shows a generic placeholder), but you'll get a console warning.

You can generate them quickly with any logo and https://maskable.app/editor.
