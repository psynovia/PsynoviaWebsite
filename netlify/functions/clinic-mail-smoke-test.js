const { sendGraphMail } = require("./lib/microsoft-graph-mail");

function html(){
  return `<!doctype html><html lang="de"><body style="font-family:Arial,Helvetica,sans-serif;color:#173a5e;line-height:1.55">
  <p>Guten Tag,</p>
  <p>vielen Dank für Ihre Anmeldung in meiner Praxis. Wie im Rahmen Ihrer Behandlung in der Privatklinik ChiemseeWinkel Seebruck besprochen, erhalten Sie nun die Unterlagen und Zugänge für die diagnostische Datenerhebung zur Abklärung einer möglichen ADHS im Erwachsenenalter.</p>
  <p style="padding:12px;border:1px solid #f1c27d;border-radius:10px;background:#fff8ed"><strong>TESTVERSAND:</strong> Der Hogrefe-Link unten ist absichtlich kein echter Testzugang und verbraucht keinen Eintrag aus dem Hogrefe-Pool.</p>
  <h3>Vor Beginn – was Sie wissen sollten</h3>
  <p>Die Datenerhebung besteht aus verschiedenen Fragebögen und standardisierten Leistungstests. Dabei werden unter anderem aktuelle Beschwerden, Erfahrungen aus Kindheit und Lebensverlauf, mögliche Beeinträchtigungen im Alltag sowie verschiedene Bereiche der Aufmerksamkeit und kognitiven Leistungsfähigkeit erfasst.</p>
  <p><strong>Wichtig ist:</strong></p>
  <p>Kein einzelner Fragebogen und kein einzelner Test allein kann eine ADHS feststellen oder ausschließen.</p>
  <p>Die Ergebnisse werden nicht automatisiert diagnostisch bewertet, sondern anschließend von mir fachlich im Gesamtzusammenhang ausgewertet.</p>
  <p>Nach Auswertung der Datenerhebung erfolgt die weitere klinische Einordnung im diagnostischen Abschlussinterview. Dabei können offene Fragen geklärt und die Ergebnisse gemeinsam in den persönlichen Lebensverlauf eingeordnet werden.</p>
  <p>Bitte beantworten Sie die Fragen möglichst ehrlich und so, wie es für Sie tatsächlich zutrifft. Es gibt keine „richtigen“ oder „erwünschten“ Antworten. Auch bei den Leistungstests geht es nicht darum, möglichst gut abzuschneiden, sondern darum, ein möglichst realistisches Bild unter normalen Bedingungen zu erhalten.</p>
  <p>Falls während der Bearbeitung Fragen entstehen oder Sie unsicher sind, können Sie die Bearbeitung jederzeit unterbrechen und sich gerne bei mir melden.</p>
  <p>Ihre <strong>Psynovia-Fall-ID</strong> lautet:</p><p><strong>CHIEM-2026-TESTTEST</strong></p>
  <p>Bitte bewahren Sie diese für eventuelle Rückfragen auf.</p>
  <p>Bitte wundern Sie sich nicht, dass im Hogrefe-Testsystem eine andere Kennung angezeigt wird als bei Psynovia. Das ist technisch bedingt und völlig korrekt.</p>
  <p>Die folgenden persönlichen Zugangslinks sind <strong>14 Tage gültig</strong>. Bitte bewahren Sie die Links auf und geben Sie sie nicht an andere Personen weiter.</p>
  <h3>1. Testung über das Hogrefe Testsystem</h3>
  <p>Ihre dortige Kennung lautet:</p><p><strong>TEST-HASE-KOMBI</strong></p>
  <p>Bitte prüfen Sie zu Beginn der Testung kurz, ob diese Kennung korrekt angezeigt wird.</p>
  <p><a href="https://example.invalid/psynovia-hogrefe-test">https://example.invalid/psynovia-hogrefe-test</a></p>
  <p>Bitte planen Sie hierfür etwa <strong>40 Minuten ungestörte Zeit</strong> ein. Die Hogrefe-Testung sollte möglichst in einem Durchgang bearbeitet werden. Sorgen Sie bitte für eine ruhige Umgebung und vermeiden Sie Unterbrechungen oder einen Wechsel zwischen verschiedenen Geräten.</p>
  <h3>2. Psynovia-Datenerhebung</h3>
  <p><a href="https://www.psynovia.de/.netlify/functions/start-diagnostik?token=TESTTOKEN">https://www.psynovia.de/.netlify/functions/start-diagnostik?token=TESTTOKEN</a></p>
  <p>Für diesen Teil können Sie sich mehr Zeit lassen. Die Datenerhebung dauert etwa <strong>90 Minuten</strong> und kann bei Bedarf unterbrochen und später über denselben persönlichen Link fortgesetzt werden. Bitte bearbeiten Sie insbesondere die Leistungstests in einer möglichst ruhigen Umgebung und nach Möglichkeit nicht unter starkem Zeitdruck, bei ausgeprägter Müdigkeit oder während häufiger Ablenkungen.</p>
  <h3>3. Ergänzende Unterlagen</h3>
  <p>Sofern Ihnen noch Schulzeugnisse aus der Grundschule oder der weiteren Schulzeit vorliegen, können Sie diese über den folgenden geschützten Upload übermitteln:</p>
  <p><a href="https://www.psynovia.de/klinik-unterlagen.html#token=TESTTOKEN"><strong>Unterlagen sicher hochladen</strong></a></p>
  <p>Dort können Sie Scans oder gut lesbare Fotos verschlüsselt übertragen. Falls keine Zeugnisse mehr vorhanden sind, ist das selbstverständlich kein Problem. Gerne können Sie dort auch andere Dokumente hochladen, die Sie für die diagnostische Einordnung für relevant halten.</p>
  <h3>Wie geht es danach weiter?</h3>
  <p>Sobald die Datenerhebung vollständig vorliegt, werte ich die Ergebnisse fachlich aus und melde mich zur weiteren Terminplanung beziehungsweise zur Vereinbarung des diagnostischen Abschlussinterviews bei Ihnen.</p>
  <p>Ich wünsche Ihnen viel Freude bei der Datenerhebung. Bei technischen Schwierigkeiten oder Rückfragen können Sie jederzeit direkt auf diese E-Mail antworten.</p>
  <p>Mit freundlichen Grüßen</p>
  <p><strong>Tobias Winner, M.Sc.</strong><br>Psychologischer Psychotherapeut<br>Psynovia – Privatpraxis für Psychotherapie<br>Grillparzerstraße 16<br>83024 Rosenheim<br>tobiaswinner@psynovia.de</p>
  </body></html>`;
}

exports.handler = async function(event){
  const secret = String(process.env.CLINIC_MAIL_SMOKE_SECRET || "");
  const supplied = String(event.queryStringParameters?.key || "");
  if (!secret || supplied !== secret) return {statusCode:403,body:"forbidden"};
  const to = String(process.env.CLINIC_ACCESS_TEST_RECIPIENT || "").trim();
  if (!to) return {statusCode:500,body:"recipient_missing"};
  await sendGraphMail({to, subject:"TEST · Ihre Psynovia-Zugänge · CHIEM-2026-TESTTEST", html:html()});
  return {statusCode:200,headers:{"Content-Type":"application/json"},body:JSON.stringify({ok:true})};
};