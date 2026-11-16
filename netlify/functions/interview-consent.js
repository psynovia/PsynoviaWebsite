'use strict';
// Backend für Psynovia Interview-Schweigepflichtsentbindung.
// Setzt MS_GRAPH_* und SUPABASE_* wie der bestehende Klinik-Flow voraus.
// Zusätzliche Umgebungsvariablen: CONSENT_ADMIN_KEY (lange zufällige Zeichenfolge),
// CONSENT_NOTIFY_EMAIL (Praxis-Postfach), optional CONSENT_BASE_URL.
const crypto = require('crypto');
const { sendGraphMail } = require('./lib/microsoft-graph-mail'); // bestehende Datei im Psynovia-Repo
const VERSION = 'interview_release_2026_11_v1';
const TABLE = 'interview_consent_requests';
const BASE = (process.env.CONSENT_BASE_URL || 'https://www.psynovia.de').replace(/\/$/, '');
const fail = (status, code) => response(status, {ok:false,error:code});
function response(statusCode, body) {return {statusCode,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store, private','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Access-Control-Allow-Origin':'https://www.psynovia.de'},body:JSON.stringify(body)};}
function digest(data){return crypto.createHash('sha256').update(data).digest('hex');}
function allowedToken(s){return typeof s==='string'&&/^[A-Za-z0-9_-]{40,100}$/.test(s);}
function isCaseId(s){return /^(CHIEM|PSY)-20\d{2}-[A-Z0-9]{6,16}$/.test(s);}
function string(s,max){return typeof s==='string'?s.trim().slice(0,max):'';}
function escapeHtml(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function authOk(event){const expected=process.env.CONSENT_ADMIN_KEY||'';const actual=event.headers?.['x-psynovia-consent-admin'] || event.headers?.['X-Psynovia-Consent-Admin'] || '';if(expected.length<32||actual.length!==expected.length)return false;return crypto.timingSafeEqual(Buffer.from(expected),Buffer.from(actual));}
async function db(method,path,body,prefer){const url=process.env.SUPABASE_URL,key=process.env.SUPABASE_SERVICE_ROLE_KEY;if(!url||!key)throw new Error('supabase_not_configured');const r=await fetch(`${url}/rest/v1/${path}`,{method,headers:{apikey:key,Authorization:`Bearer ${key}`,'Content-Type':'application/json',...(prefer?{Prefer:prefer}:{})},body:body===undefined?undefined:JSON.stringify(body),cache:'no-store'});const data=await r.json().catch(()=>null);if(!r.ok){console.error('consent_db_failed',r.status,typeof data==='object'&&data?.code);throw new Error('database_error');}return data;}
function eq(v){return encodeURIComponent(v);}
function isEmail(s){return typeof s==='string'&&s.length<255&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);}
function htmlEscapeWithLines(s){return escapeHtml(s).replace(/\r?\n/g,'<br>');}
function invitationHtml(subject,body,url){const escaped=htmlEscapeWithLines(body).replace(/\{LINK\}/g,`<a href="${escapeHtml(url)}" rel="noopener noreferrer">Einwilligungslink öffnen</a>`);return `<!doctype html><html lang="de"><body style="font-family:Arial,Helvetica,sans-serif;line-height:1.65;color:#173a5e"><div style="max-width:640px;margin:0 auto;padding:20px"><p style="font-weight:bold">Psynovia</p><p>${escaped}</p></div></body></html>`;}

async function getRequestByToken(token){const data=await db('GET',`${TABLE}?token_hash=eq.${digest(token)}&select=id,case_id,professional_name,professional_title,form_version,expires_at,status,confirmed_at,notification_status&limit=1`);return Array.isArray(data)?data[0]:null;}
function validEnvelope(e){return !!(e&&e.v===2&&e.type==='psynovia_interview_consent'&&e.content_encryption==='AES-256-GCM'&&e.key_encryption==='RSA-OAEP-256'&&typeof e.iv_b64==='string'&&e.iv_b64.length===16&&typeof e.wrapped_key_b64==='string'&&e.wrapped_key_b64.length>300&&e.wrapped_key_b64.length<1200&&typeof e.ciphertext_b64==='string'&&e.ciphertext_b64.length>100&&e.ciphertext_b64.length<650000);}
function htmlBody(title,items){return `<!doctype html><html lang="de"><body style="font-family:Arial,Helvetica,sans-serif;line-height:1.6;color:#173a5e"><h2>${escapeHtml(title)}</h2>${items.map(([k,v])=>`<p><strong>${escapeHtml(k)}:</strong> ${/^https:\/\/www\.psynovia\.de\//.test(v)?`<a href=\"${escapeHtml(v)}\">Einwilligungslink öffnen</a>`:escapeHtml(v)}</p>`).join('')}<p>Bitte den Einwilligungsnachweis in der geschützten Psynovia-Verwaltung prüfen. Diese Nachricht enthält keine diagnostischen Unterlagen.</p></body></html>`;}
async function mail(to,subject,items){await sendGraphMail({to,subject,html:htmlBody(subject,items)});}
exports.handler = async function(event) {
  if(event.httpMethod!=='POST') return fail(405,'method_not_allowed');
  if((event.body||'').length>800000)return fail(413,'payload_too_large');
  let p;try{p=JSON.parse(event.body||'{}');}catch{return fail(400,'invalid_json');}
  const action=p.action;
  try {
    if(action==='create') {
      if(process.env.CONSENT_PATIENT_FLOW_ENABLED!=='true')return fail(503,'not_yet_enabled');
      if(!authOk(event))return fail(401,'admin_auth_required');
      const caseId=string(p.case_id,60).toUpperCase(), professional=string(p.professional_name,120), title=string(p.professional_title,100)||'Psychologische Psychotherapeutin';
      if(!isCaseId(caseId)||professional.length<5||title.length<5)return fail(400,'invalid_input');
      const rows=await db('GET',`cases?case_id=eq.${eq(caseId)}&select=case_id,email&limit=1`);
      if(!Array.isArray(rows)||rows.length!==1)return fail(404,'case_not_found');
      const patientEmail=String(rows[0].email||'').trim().toLowerCase();
      // Die Einladung wird niemals während der Linkerstellung automatisch verschickt.
      const token=crypto.randomBytes(32).toString('base64url');
      const url=`${BASE}/schweigepflichtsentbindung.html#token=${encodeURIComponent(token)}`;
      const expiry=new Date(Date.now()+7*86400000).toISOString();
      const created=await db('POST',TABLE,{case_id:caseId,token_hash:digest(token),professional_name:professional,professional_title:title,expires_at:expiry,form_version:VERSION},'return=representation');
      const item=created?.[0];if(!item?.id)throw new Error('database_error');
      return response(200,{ok:true,id:item.id,case_id:caseId,link:url,expires_at:expiry,delivery:'not_requested',patient_email:patientEmail});
    }
    if(action==='send_invitation') {
      if(process.env.CONSENT_PATIENT_FLOW_ENABLED!=='true')return fail(503,'not_yet_enabled');
      if(!authOk(event))return fail(401,'admin_auth_required');
      const id=string(p.id,40),token=string(p.token,110);
      const subject=string(p.subject,160),body=string(p.message,3500);
      if(!/^[0-9a-f-]{36}$/i.test(id)||!allowedToken(token)||subject.length<4||body.length<12||!body.includes('{LINK}'))return fail(400,'invalid_invitation');
      // Zweite, serverseitig erzwungene Freigabe: Kein Versand nur durch Linkerzeugung oder durch Aufruf ohne Zustimmung.
      if(p.send_authorized!==true)return fail(403,'send_not_authorized');
      const rows=await db('GET',`${TABLE}?id=eq.${eq(id)}&token_hash=eq.${digest(token)}&select=id,case_id,status,expires_at,link_email_status&limit=1`);
      const row=rows?.[0];if(!row)return fail(404,'invitation_not_found');
      if(row.status!=='pending'||new Date(row.expires_at).getTime()<=Date.now())return fail(410,'link_unavailable');
      if(row.link_email_status!=='not_requested'&&row.link_email_status!=='failed')return fail(409,'invitation_already_sent_or_uncertain');
      const found=await db('GET',`cases?case_id=eq.${eq(row.case_id)}&select=case_id,email&limit=1`);
      const recipient=String(found?.[0]?.email||'').trim().toLowerCase();
      if(!isEmail(recipient))return fail(409,'patient_email_not_available');
      if(String(p.recipient_confirmed||'').trim().toLowerCase()!==recipient)return fail(409,'recipient_confirmation_mismatch');
      // Sperre vor dem externen Versand, damit parallele Klicks nicht mehrfach senden.
      const claimed=await db('PATCH',`${TABLE}?id=eq.${eq(id)}&link_email_status=eq.${eq(row.link_email_status)}&select=id`,{link_email_status:'sending'},'return=representation');
      if(!claimed?.length)return fail(409,'invitation_in_progress');
      const url=`${BASE}/schweigepflichtsentbindung.html#token=${encodeURIComponent(token)}`;
      let delivery;
      try{
        await sendGraphMail({to:recipient,subject,html:invitationHtml(subject,body,url)});
        delivery='accepted';
      }catch(e){delivery=e.message==='graph_send_ambiguous'?'uncertain':'failed';console.error('consent_invite_mail',delivery);}
      await db('PATCH',`${TABLE}?id=eq.${eq(id)}`,{link_email_status:delivery,link_email_at:delivery==='accepted'?new Date().toISOString():null,last_error_code:delivery==='accepted'?null:`invitation_${delivery}`},'return=minimal');
      return response(200,{ok:delivery==='accepted',delivery});
    }
    if(action==='status'){
      if(!allowedToken(p.token))return fail(400,'invalid_token');
      const row=await getRequestByToken(p.token);
      if(!row)return fail(404,'link_not_found');
      const expired=new Date(row.expires_at).getTime()<Date.now();
      return response(200,{ok:true,case_id:row.case_id,professional_name:row.professional_name,professional_title:row.professional_title,form_version:row.form_version,status:row.status,expired,confirmed_at:row.confirmed_at});
    }
    if(action==='confirm'){
      if(process.env.CONSENT_PATIENT_FLOW_ENABLED!=='true')return fail(503,'not_yet_enabled');
      if(!allowedToken(p.token)||!validEnvelope(p.envelope))return fail(400,'invalid_confirmation');
      const row=await getRequestByToken(p.token);
      if(!row)return fail(404,'link_not_found');
      if(row.status==='confirmed')return response(200,{ok:true,already_confirmed:true,confirmed_at:row.confirmed_at,case_id:row.case_id});
      if(row.status!=='pending'||new Date(row.expires_at).getTime()<Date.now())return fail(410,'link_unavailable');
      const now=new Date().toISOString();
      const envelope={...p.envelope}; // Ausschließlich verschlüsselte Nutzdaten, nicht den Klartext übernehmen.
      const hash=digest(`${envelope.iv_b64}.${envelope.wrapped_key_b64}.${envelope.ciphertext_b64}`); // stable trotz PostgreSQL jsonb-Normalisierung
      const updated=await db('PATCH',`${TABLE}?id=eq.${row.id}&status=eq.pending&expires_at=gt.${eq(now)}&select=id,case_id,confirmed_at,professional_name`,{status:'confirmed',confirmed_at:now,encrypted_envelope:envelope,envelope_sha256:hash,notification_status:'sending'},'return=representation');
      if(!updated?.length){return fail(409,'already_handled');}
      const recipient=String(process.env.CONSENT_NOTIFY_EMAIL||process.env.MS_GRAPH_SENDER||'').trim();
      let notification='failed';
      if(recipient){try{await mail(recipient,`Psynovia – Schweigepflichtsentbindung bestätigt · ${row.case_id}`,[['Fall-ID',row.case_id],['Zeitpunkt',new Date(now).toLocaleString('de-DE',{timeZone:'Europe/Berlin'})],['Externe Fachperson',row.professional_name]]);notification='accepted';}catch(e){notification=e.message==='graph_send_ambiguous'?'uncertain':'failed';console.error('consent_notify_mail',notification);}}
      await db('PATCH',`${TABLE}?id=eq.${row.id}`,{notification_status:notification,notification_at:notification==='accepted'?new Date().toISOString():null,last_error_code:notification==='accepted'?null:`email_${notification}`},'return=minimal');
      return response(200,{ok:true,confirmed_at:now,case_id:row.case_id,notification_status:notification});
    }
    if(action==='revoke') {
      if(!authOk(event))return fail(401,'admin_auth_required');
      const id=string(p.id,40);if(!/^[a-f\d-]{36}$/i.test(id))return fail(400,'invalid_id');
      const rows=await db('PATCH',`${TABLE}?id=eq.${eq(id)}&status=neq.revoked&select=id`,{status:'revoked',revoked_at:new Date().toISOString()},'return=representation');
      if(!rows?.length)return fail(404,'request_not_found_or_revoked');
      return response(200,{ok:true,revoked:true});
    }
    if(action==='list') {
      if(!authOk(event))return fail(401,'admin_auth_required');
      const caseId=string(p.case_id,60).toUpperCase();if(!isCaseId(caseId))return fail(400,'invalid_case_id');
      const list=await db('GET',`${TABLE}?case_id=eq.${eq(caseId)}&select=id,case_id,professional_name,created_at,expires_at,status,confirmed_at,revoked_at,link_email_status,notification_status,notification_at&order=created_at.desc&limit=30`);
      return response(200,{ok:true,records:list||[]});
    }
    if(action==='export') {
      if(!authOk(event))return fail(401,'admin_auth_required');
      const id=string(p.id,40);if(!/^[a-f\d-]{36}$/i.test(id))return fail(400,'invalid_id');
      const rows=await db('GET',`${TABLE}?id=eq.${eq(id)}&select=case_id,professional_name,professional_title,created_at,confirmed_at,form_version,status,encrypted_envelope,envelope_sha256&limit=1`);
      if(!rows?.length||!rows[0].confirmed_at||!rows[0].encrypted_envelope)return fail(404,'proof_not_found');
      return response(200,{ok:true,record:rows[0]});
    }
    return fail(400,'unknown_action');
  }catch(e){console.error('consent_api_error',e.message);return fail(500,'server_error');}
};