import { createHash, scryptSync, timingSafeEqual } from "node:crypto";

const BUCKET = "secure-delivery-encrypted";
const SIGNED_DOWNLOAD_SECONDS = 15 * 60;
const MAX_DOB_ATTEMPTS = 5;
const LOCK_MINUTES = 15;
const SCRYPT_N = 2 ** 15;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

function j(status, body) {
  return new Response(JSON.stringify(body), { status, headers: {
    "Content-Type":"application/json; charset=utf-8",
    "Cache-Control":"no-store, no-cache, must-revalidate, max-age=0",
    "Pragma":"no-cache",
    "X-Content-Type-Options":"nosniff",
    "X-Robots-Tag":"noindex, nofollow, noarchive",
    "Referrer-Policy":"no-referrer"
  }});
}
function env(name){ return String(Netlify.env.get(name)||"").trim(); }
function sha(v){ return createHash("sha256").update(String(v),"utf8").digest("hex"); }
function validDob(v){ return /^\d{4}-\d{2}-\d{2}$/.test(String(v||"")) && !Number.isNaN(new Date(`${v}T00:00:00Z`).getTime()); }
function validToken(v){ return typeof v === "string" && v.length >= 40 && v.length <= 128 && /^[A-Za-z0-9_-]+$/.test(v); }
function safeEqHex(a,b){ try{ const x=Buffer.from(a,"hex"), y=Buffer.from(b,"hex"); return x.length===y.length && timingSafeEqual(x,y); }catch{return false;} }
function fromB64u(s){ try{ return Buffer.from(String(s||""),"base64url"); }catch{return Buffer.alloc(0);} }
function dobHash(dob,saltText){
  const salt=fromB64u(saltText);
  if(salt.length!==16) return "";
  try{return scryptSync(dob,salt,32,{N:SCRYPT_N,r:SCRYPT_R,p:SCRYPT_P,maxmem:SCRYPT_MAXMEM}).toString("hex");}catch{return "";}
}
function sbHeaders(key, extra={}){ return { apikey:key, Authorization:`Bearer ${key}`, "Content-Type":"application/json", ...extra }; }
async function sbJson(url,key,opts={}){
  const r=await fetch(url,{method:opts.method||"GET",headers:sbHeaders(key,opts.headers||{}),body:opts.body===undefined?undefined:JSON.stringify(opts.body)});
  const data=await r.json().catch(()=>null); return {r,data};
}
function encodeStoragePath(path){return String(path).split("/").map(encodeURIComponent).join("/");}
async function signedDownload(base,key,path){
  const r=await fetch(`${base}/storage/v1/object/sign/${BUCKET}/${encodeStoragePath(path)}`,{method:"POST",headers:sbHeaders(key),body:JSON.stringify({expiresIn:SIGNED_DOWNLOAD_SECONDS})});
  const d=await r.json().catch(()=>null); if(!r.ok||!d) throw new Error("signed_download_failed");
  const rel=d.signedURL||d.signedUrl||d.url; if(typeof rel!=="string") throw new Error("signed_download_invalid");
  return rel.startsWith("http")?rel:`${base}/storage/v1${rel.startsWith("/")?"":"/"}${rel}`;
}
function publicType(t){return ({report:"Befundbericht",consent:"Schweigepflichtentbindung",other:"Dokument"})[t]||"Dokument";}
async function lookup(base,key,token,fields){
  return sbJson(`${base}/rest/v1/secure_deliveries?access_token_hash=eq.${sha(token)}&select=${encodeURIComponent(fields)}&limit=1`,key);
}
function active(row){return row&&row.status==="ready"&&!row.revoked_at&&new Date(row.expires_at).getTime()>Date.now();}
async function notifySuccessfulDownload({base,key,row}){
  const resendKey=env("RESEND_API_KEY"), from=env("RESEND_FROM_EMAIL");
  if(!resendKey||!from){
    await sbJson(`${base}/rest/v1/secure_deliveries?delivery_id=eq.${row.delivery_id}`,key,{method:"PATCH",headers:{Prefer:"return=minimal"},body:{download_notification_status:"failed",download_notification_last_error:"resend_config_missing"}}).catch(()=>{});
    return {ok:false,error:"notification_config_missing"};
  }
  const eventTime=new Date().toISOString();
  const recipientLabel=row.recipient_type==="clinic"?"Klinik / Behandler":"Patient:in";
  const typeLabel=publicType(row.document_type);
  const count=Number(row.download_count||0)+1;
  const mail=await fetch("https://api.resend.com/emails",{
    method:"POST",headers:{Authorization:`Bearer ${resendKey}`,"Content-Type":"application/json"},
    body:JSON.stringify({from,to:"ergebnis@psynovia.de",subject:`Sicheres Dokument abgerufen · ${recipientLabel} · ${typeLabel} · ${row.case_id}`,
      text:`Ein sicher bereitgestelltes Psynovia-Dokument wurde erfolgreich abgerufen und im Browser entschlüsselt.\n\nFall-ID: ${row.case_id}\nDokumenttyp: ${typeLabel}\nEmpfängerzugang: ${recipientLabel}\nAbruf Nr.: ${count}\nZeitpunkt: ${eventTime}\n\nDiese Nachricht enthält keine personenbezogenen Daten.`})
  });
  if(!mail.ok){
    await sbJson(`${base}/rest/v1/secure_deliveries?delivery_id=eq.${row.delivery_id}`,key,{method:"PATCH",headers:{Prefer:"return=minimal"},body:{download_notification_status:"failed",download_notification_last_error:`resend_${mail.status}`}}).catch(()=>{});
    return {ok:false,error:"notification_mail_failed"};
  }
  await sbJson(`${base}/rest/v1/secure_deliveries?delivery_id=eq.${row.delivery_id}`,key,{method:"PATCH",headers:{Prefer:"return=minimal"},body:{download_notification_status:"sent",download_notification_sent_at:eventTime,download_notification_last_error:null}}).catch(()=>{});
  return {ok:true,sent:true};
}

export default async (req) => {
  if(req.method!=="POST") return j(405,{ok:false,error:"method_not_allowed"});
  const base=env("SUPABASE_URL"), key=env("SUPABASE_SERVICE_ROLE_KEY");
  if(!base||!key) return j(500,{ok:false,error:"server_configuration_missing"});
  let body; try{body=await req.json();}catch{return j(400,{ok:false,error:"invalid_json"});}
  const action=String(body?.action||"");
  const token=String(body?.access_token||"").trim();
  if(!validToken(token)) return j(403,{ok:false,error:"access_denied"});

  if(action==="inspect"){
    const q=await lookup(base,key,token,"delivery_id,status,expires_at,revoked_at,protection_mode,recipient_type,document_type");
    if(!q.r.ok||!Array.isArray(q.data)||q.data.length!==1||!active(q.data[0])) return j(403,{ok:false,error:"access_denied"});
    const row=q.data[0];
    return j(200,{ok:true,protection_mode:row.protection_mode,recipient_type:row.recipient_type,document_type:row.document_type,document_type_label:publicType(row.document_type)});
  }

  if(action==="verify"){
    const q=await lookup(base,key,token,"delivery_id,case_id,object_path,status,expires_at,revoked_at,failed_attempts,locked_until,recipient_type,protection_mode,document_type,dob_hmac,dob_salt");
    if(!q.r.ok||!Array.isArray(q.data)||q.data.length!==1||!active(q.data[0])) return j(403,{ok:false,error:"access_denied"});
    const row=q.data[0], nowMs=Date.now();
    const lockMs=row.locked_until?new Date(row.locked_until).getTime():0;
    if(lockMs>nowMs) return j(429,{ok:false,error:"temporarily_locked",retry_after_seconds:Math.max(1,Math.ceil((lockMs-nowMs)/1000))});
    if(row.protection_mode==="dob"){
      const dob=String(body?.birth_date||"").trim();
      if(!validDob(dob)) return j(403,{ok:false,error:"access_denied"});
      let attempts=Number(row.failed_attempts||0); if(lockMs&&lockMs<=nowMs) attempts=0;
      const candidate=dobHash(dob,row.dob_salt);
      if(!candidate||!safeEqHex(candidate,String(row.dob_hmac||""))){
        attempts+=1; const locked=attempts>=MAX_DOB_ATTEMPTS;
        const lock=locked?new Date(nowMs+LOCK_MINUTES*60000).toISOString():null;
        await sbJson(`${base}/rest/v1/secure_deliveries?delivery_id=eq.${row.delivery_id}`,key,{method:"PATCH",headers:{Prefer:"return=minimal"},body:{failed_attempts:locked?0:attempts,locked_until:lock}}).catch(()=>{});
        return j(locked?429:403,{ok:false,error:locked?"temporarily_locked":"access_denied",remaining_attempts:Math.max(0,MAX_DOB_ATTEMPTS-attempts)});
      }
      await sbJson(`${base}/rest/v1/secure_deliveries?delivery_id=eq.${row.delivery_id}`,key,{method:"PATCH",headers:{Prefer:"return=minimal"},body:{failed_attempts:0,locked_until:null}}).catch(()=>{});
    }
    try{
      const url=await signedDownload(base,key,row.object_path);
      return j(200,{ok:true,recipient_type:row.recipient_type,document_type:row.document_type,signed_download_url:url,expires_in_seconds:SIGNED_DOWNLOAD_SECONDS});
    }catch{return j(502,{ok:false,error:"download_prepare_failed"});}
  }

  if(action==="confirm_download"){
    const q=await lookup(base,key,token,"delivery_id,case_id,status,expires_at,revoked_at,recipient_type,document_type,download_count");
    if(!q.r.ok||!Array.isArray(q.data)||q.data.length!==1||!active(q.data[0])) return j(403,{ok:false,error:"access_denied"});
    const row=q.data[0], now=new Date().toISOString();
    await sbJson(`${base}/rest/v1/secure_deliveries?delivery_id=eq.${row.delivery_id}`,key,{method:"PATCH",headers:{Prefer:"return=minimal"},body:{last_downloaded_at:now}}).catch(()=>{});
    await fetch(`${base}/rest/v1/rpc/increment_secure_delivery_download`,{method:"POST",headers:sbHeaders(key),body:JSON.stringify({p_delivery_id:row.delivery_id})}).catch(()=>{});
    const result=await notifySuccessfulDownload({base,key,row});
    return j(200,{ok:true,notification_sent:!!result.sent});
  }
  return j(400,{ok:false,error:"unknown_action"});
};