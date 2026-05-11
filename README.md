# Abnahme-App

Mobile Web-App für die Bearbeitung von Fahrzeug-Abnahmeprotokollen in Excel-Format,
optimiert für iPhone Safari.

## Funktionsumfang

- Excel-Dateien laden, mehrere Fahrzeuge parallel bearbeiten
- Sub-Fahrzeuge für gemeinsame Eintragungen (z.B. gleicher Mangel an 3 Fahrzeugen)
- iO/Mangel-Status mit optionaler Notiz pro Position
- Auto-Speicherung im Browser, Bestätigungstöne, Tutorial
- ebox21-Download und -Upload direkt verlinkt
- Export ohne Veränderung an Excel-Format und Makros

## Installation auf GitHub Pages

1. Diesen Ordner-Inhalt in ein **public** GitHub-Repository hochladen
2. Repository-Settings → Pages → Source: Branch `main`, Folder `/ (root)` → Save
3. Nach 1-2 Minuten ist die App unter `https://DEINNAME.github.io/REPO-NAME/` erreichbar
4. URL am iPhone in Safari öffnen → Teilen → "Zum Home-Bildschirm"

## Lokal nutzen

Die `abnahme-app.html` ist eine vollständige Single-File-Version mit allem inline
(SheetJS, fflate, Styles, Logik, Icons). Einfach in einem Browser öffnen.

## Updates

Neue Version: einfach die Dateien im Repository ersetzen, GitHub Pages
aktualisiert sich automatisch nach 1-2 Minuten.

## Konfiguration

ebox21-Links sind im Code fest eingetragen, können aber von jedem Nutzer über
"ebox21-Links ändern" auf der Startseite angepasst werden (Speicherung lokal
im Browser des Nutzers).
