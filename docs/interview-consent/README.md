# Psynovia – Online-Schweigepflichtsentbindung zum Abschlussinterview

**Basis:** tatsächliche `klinik-chiemseewinkel.html` aus `psynovia/PsynoviaWebsite` (Stand 16.11.2026). **Nicht** das ältere `intake.html`.

## Inhalt
- `schweigepflichtverwaltung.html`: interne Seite für bestehende Fall-IDs, Link-Erzeugung, frei bearbeitbaren und erst nach expliziter Bestätigung ausgelösten Mailversand, Statuskontrolle und Export.
- `schweigepflichtsentbindung.html`: Patientenseite mit individueller Erklärung, ausdrücklichem Häkchen, Namen und gezeichneter Unterschrift.
- `netlify/functions/interview-consent.js`: Linkausgabe, Tokenvalidierung, Einmalbestätigung, Supabase-Speicherung, Microsoft-Graph-E-Mails.
- `sql/consent_requests.sql`: separate Tabelle mit restriktiven Datenbankrechten.
- `entschluesseln-lokal.html`: vollständig offline arbeitende Entschlüsselungsseite für exportierte Einwilligungsnachweise.
- `testnachweis-mit-echtem-oeffentlichem-schluessel.json`: fiktiver Nachweis zur Prüfung deines privaten Schlüssels, verschlüsselt mit dem exakt gleichen öffentlichen RSA-Schlüssel wie im aktuellen Chiemseewinkel-Intake.
- `tests/smoke.cjs`: testet den Hauptablauf ohne Patientendaten oder Live-Dienste (`node tests/smoke.cjs`).

## Einbau (nicht automatisch aus diesem ZIP aktiviert)
1. Neue SQL-Tabelle **nach Prüfung** im Supabase-Projekt anlegen: `sql/consent_requests.sql`.
2. Beide `.html`-Dateien in das Root-Verzeichnis des GitHub-Repositories `psynovia/PsynoviaWebsite` legen.
3. `interview-consent.js` nach `netlify/functions/` legen. Die **bereits bestehende** Moduldatei `netlify/functions/lib/microsoft-graph-mail.js` bleibt erhalten und wird verwendet.
4. In Netlify unter Site configuration → Environment variables ergänzen:
   - `CONSENT_ADMIN_KEY`: **zufällig generierter** Verwaltungsschlüssel mit mindestens 32 Zeichen; unbedingt vertraulich behandeln.
   - `CONSENT_PATIENT_FLOW_ENABLED=false` setzen, solange der private Schlüsseltest nicht erfolgreich durchgeführt wurde. **Ohne ausdrücklich `true` ist die Erstellung, der Versand und die Zustimmung deaktiviert.**
   - `CONSENT_NOTIFY_EMAIL`: Praxis-Postfach für die Bestätigungsmail (beispielsweise dein vorhandenes Graph-Absender-Postfach).
   - Optional `CONSENT_BASE_URL=https://www.psynovia.de` (Standard ist bereits so eingestellt).
   - Bestehende `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `MS_GRAPH_TENANT_ID`, `MS_GRAPH_CLIENT_ID`, `MS_GRAPH_CLIENT_SECRET` und `MS_GRAPH_SENDER` müssen auf der Netlify-Site weiterhin verfügbar sein.
5. Site deployen. Verwaltung: `https://www.psynovia.de/schweigepflichtverwaltung.html`. Patientenseite (nur über individuellen Token-Link): `https://www.psynovia.de/schweigepflichtsentbindung.html#token=...`.
6. **Vor dem ersten Patienteneinsatz** mit einer Test-Fall-ID und eigenem Testpostfach vollständig prüfen: Link -> Mail -> Signatur -> Fallstatus -> Mail -> verschlüsselter Export -> lokale Entschlüsselung.

## Ablauf
- **Nach erfolgreicher Schlüsselfreigabe:** `CONSENT_PATIENT_FLOW_ENABLED=true` setzen und neu deployen; erst danach echte Einwilligungen annehmen.
- Bei der Linkerstellung wird in der vorhandenen Tabelle `cases` ausschließlich die Fall-ID nachgeschlagen, um die vorhandene E-Mail-Adresse zu verwenden. Neue Fälle werden durch dieses Modul **nicht** angelegt.
- Die Linkerstellung verschickt keine E-Mail. Die E-Mail kann frei formuliert werden; `{LINK}` wird erst beim expliziten Versand in den persönlichen Link umgewandelt. Alternativ: Link kopieren oder einen Entwurf im eigenen Mailprogramm öffnen.
- Für jeden Link werden 32 kryptografisch zufällige Token-Bytes generiert. Die Datenbank speichert nur den SHA-256-Hash. Links laufen nach sieben Tagen ab.
- Nach der Bestätigung speichert das Backend den **verschlüsselten** Volltext einschließlich Unterschriftsbild, einen Fingerabdruck und den serverseitigen Zeitstempel, der mit der Fall-ID verknüpft ist.
- E-Mail an die Praxis nennt nur Fall-ID, Zeitpunkt und Kollegin; **keine** diagnostischen Daten oder Signatur. Microsoft Graph bestätigt die Annahme zum Versand, nicht die tatsächliche Zustellung.
- Wiederholter Aufruf nach Bestätigung zeigt „bereits bestätigt“, verschickt aber keine weitere E-Mail.
- Die Verwaltung bietet eine Sperrfunktion für Links und dokumentiert den Zeitpunkt. Eine Sperre nach bereits erfolgter Einwilligung ersetzt nicht die fallbezogene Bearbeitung eines Widerrufs.
- Die Verwaltung bietet den Export des verschlüsselten Nachweises als JSON. Der Envelopetyp ist `psynovia_interview_consent`; der öffentliche RSA-Schlüssel entspricht dem Chiemseewinkel-Intake. Entschlüsselung/Archivierung mit dem zugehörigen privaten Schlüssel muss vor dem Livebetrieb überprüft werden.

## Klinische und datenschutzrechtliche Restpunkte
- Der für den Einzelfall tatsächlich zuständige Berufsträger muss **namentlich** im Link erfasst werden. Die Qualifikation korrekt angeben (z.B. „Psychologische Psychotherapeutin“).
- Vor Liveschaltung Datenschutzinformation und Honorarvereinbarung zur externen Fachperson prüfen. Für eine generische Intake-Datenschutzhinweis-Seite ist die spezifische Aufklärung zur externen Mitwirkung möglicherweise nicht hinreichend. Der konkrete Erklärungstext ist hier im Formular enthalten.
- Die gezeichnete Unterschrift ist **keine qualifizierte elektronische Signatur**; der Zugang über den Falllink allein ist keine hochsichere Identitätsprüfung. Gegebenenfalls zusätzlich im Gespräch verifizieren.
- Die Seite enthält noch keine Widerrufsschaltfläche. Ein Widerruf wird per E-Mail an die Praxis entgegengenommen und muss organisatorisch im Fallverlauf dokumentiert und ggf. in der Datenbank als `revoked` markiert werden.
- Keine automatische Erinnerung oder erneute Zustellung bei unklaren Mailzuständen; solche Fälle manuell im Postausgang prüfen.
- Der Verwaltungsschlüssel ist ein pragmatischer Zugangsschutz, kein MFA-gestütztes Login. Bei häufiger Nutzung ist eine gesonderte Admin-Authentifizierung sinnvoll.
- Keine Änderungen am bestehenden Klinikintake oder der bestehenden Testlogik durch dieses Paket.

## Teststatus
`node --check` für die Netlify-Funktion; JavaScript-Parsekontrolle für alle HTML-Skripte und die Netlify-Funktion sowie `node tests/smoke.cjs`: erfolgreich (Mock-Backend). **Noch kein Live-End-to-End-Test**, keine E-Mail real gesendet, keine Produktionsdatenbank geändert. 

## Produktivaktivierung 16.11.2026
Das Feature wurde separat freigeschaltet. Der Einladungsversand setzt sowohl eine bewusst gesetzte Freigabe-Checkbox als auch die serverseitige Bestätigung `send_authorized: true` und die exakte Bestätigung der zugehörigen Patienten-E-Mail-Adresse voraus. Ein bloßes Erzeugen eines Links löst keinen E-Mail-Versand aus. Nach jeder Änderung des E-Mail-Textes wird die Freigabe zurückgesetzt.
