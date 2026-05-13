# Abnahme-App v3.3 — Feuerwehr Frankfurt

Mobile Web-App für Fahrzeug-Abnahmeprotokolle.

## v3.3: Direkte ZIP-Verarbeitung

- ZIPs aus ebox21 können direkt in der App geöffnet werden, ohne manuelles
  Entpacken in der Files-App. App erkennt Excel-Dateien automatisch und zeigt
  bei mehreren eine Auswahl.
- Service-Worker ignoriert jetzt Cross-Origin-Requests sauber (keine
  CORS-Folgefehler mehr in der Konsole).

## Workflow neu

1. ebox21-Link in Safari → ZIP herunterladen → landet in Downloads
2. In der App: „Excel-Datei öffnen" → ZIP auswählen
3. Falls die ZIP nur eine Excel enthält: wird direkt geöffnet
4. Falls mehrere: Auswahl-Modal mit Dateinamen und Größe

## v3.0-v3.2-Funktionen (unverändert)

- App-Icons mit Adler-Logo, PWA-Polish
- Foto-Anhänge max. 3 pro Mangel-Position
- Zusätzliche Mängel pro Tabellenblatt+Fahrzeug
- Export mit Fotos als ZIP-Bundle
- Drei Layout-Modi (Handy, Tablet, PC)
- Tageslicht-optimierte Farben

## Installation auf GitHub Pages

1. Ordner-Inhalt in **public** Repository hochladen
2. Settings → Pages → Source `main` / `/ (root)` → Save
3. Nach 1-2 Min unter `https://DEINNAME.github.io/REPO/`

Bei Update: alte Dateien im Repo ersetzen. Falls die App noch wie vorher
aussieht: Browser-Cache leeren oder hart neu laden, weil der Service-Worker
sonst die alte Version cached.
