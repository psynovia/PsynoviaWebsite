import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

const BUCKET = "patient-reports-encrypted";
const MAX_ENCRYPTED_BYTES = 33_554_432;
const REPORT_VALID_DAYS = 30;
const SIGNED_DOWNLOAD_SECONDS = 15 * 60;
const MAX_DOB_ATTEMPTS = 5;
const LOCK_MINUTES = 15;

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
function dobHmac(dob, pepper){ return createHmac("sha256",pepper).update(dob,"utf8").digest("hex"); }
function validDob(v){ return /^\d{4}-\d{2}-\d{2}$/.test(String(v||"")) && !Number.isNaN(new Date(`${v}T00:00:00Z`).getTime()); }
function validCase(v){ return /^[A-Z0-9_-]{6,80}$/.test(String(v||"").trim().toUpperCase()); }
function validToken(v){ return typeof v === "string" && v.length >= 40 && v.length <= 128 && /^[A-Za-z0-9_-]+$/.test(v); }
function safeEqHex(a,b){ try{ const x=Buffer.from(a,"hex"), y=Buffer.from(b,"hex"); return x.length===y.length && timingSafeEqual(x,y); }catch{return false;} }
function sbHeaders(key, extra={}){ return { apikey:key, Authorization:`Bearer ${key}`, "Content-Type":"application/json", ...extra }; }
async function sbJson(url,key,opts={}){
  const r=await fetch(url,{method:opts.method||"GET",headers:sbHeaders(key,opts.headers||{}),body:opts.body===undefined?undefined:JSON.stringify(opts.body)});
  const data=await r.json().catch(()=>null); return {r,data};
}
async function signedUpload(base,key,path){
  const r=await fetch(`${base}/storage/v1/object/upload/sign/${BUCKET}/${encodeURIComponent(path)}`,{method:"POST",headers:sbHeaders(key,{"x-upsert":"false"}),body:"{}"});
  const d=await r.json().catch(()=>null); if(!r.ok||!d) throw new Error("signed_upload_failed");
  const rel=d.url||d.signedURL||d.signedUrl; if(typeof rel!=="string") throw new Error("signed_upload_invalid");
  return rel.startsWith("http")?rel:`${base}/storage/v1${rel.startsWith("/")?"":"/"}${rel}`;
}
async function objectSize(base,key,path){
  const r=await fetch(`${base}/storage/v1/object/info/authenticated/${BUCKET}/${encodeURIComponent(path)}`,{headers:{apikey:key,Authorization:`Bearer ${key}`}});
  const d=await r.json().catch(()=>null); if(!r.ok||!d) return null;
  const n=Number(d?.metadata?.size ?? d?.size ?? d?.metadata?.contentLength); return Number.isFinite(n)?n:null;
}
async function signedDownload(base,key,path){
  const r=await fetch(`${base}/storage/v1/object/sign/${BUCKET}/${encodeURIComponent(path)}`,{method:"POST",headers:sbHeaders(key),body:JSON.stringify({expiresIn:SIGNED_DOWNLOAD_SECONDS})});
  const d=await r.json().catch(()=>null); if(!r.ok||!d) throw new Error("signed_download_failed");
  const rel=d.signedURL||d.signedUrl||d.url; if(typeof rel!=="string") throw new Error("signed_download_invalid");
  return rel.startsWith("http")?rel:`${base}/storage/v1${rel.startsWith("/")?"":"/"}${rel}`;
}
async function notifySuccessfulDownload({base,key,token}){
  const claim=await sbJson(
    `${base}/rest/v1/patient_report_deliveries?access_token_hash=eq.${sha(token)}&download_notification_status=in.(pending,failed)&last_downloaded_at=not.is.null&select=report_id,case_id`,
    key,
    {method:"PATCH",headers:{Prefer:"return=representation"},body:{download_notification_status:"sending",download_notification_last_error:null}}
  );
  if(!claim.r.ok) return {ok:false,error:"claim_failed"};
  if(!Array.isArray(claim.data)||claim.data.length===0) return {ok:true,already_notified:true};
  const row=claim.data[0];
  const resendKey=env("RESEND_API_KEY"), from=env("RESEND_FROM_EMAIL");
  if(!resendKey||!from){
    await sbJson(`${base}/rest/v1/patient_report_deliveries?report_id=eq.${row.report_id}`,key,{method:"PATCH",headers:{Prefer:"return=minimal"},body:{download_notification_status:"failed",download_notification_last_error:"resend_config_missing"}}).catch(()=>{});
    return {ok:false,error:"notification_config_missing"};
  }
  const mail=await fetch("https://api.resend.com/emails",{
    method:"POST",
    headers:{Authorization:`Bearer ${resendKey}`,"Content-Type":"application/json"},
    body:JSON.stringify({
      from,
      to:"ergebnis@psynovia.de",
      subject:`Befund erfolgreich abgerufen · ${row.case_id}`,
      text:`Der Befund wurde im Psynovia-Portal erfolgreich abgerufen und im Browser entschlüsselt.\n\nFall-ID: ${row.case_id}\nZeitpunkt: ${new Date().toISOString()}\n\nDiese Nachricht enthält keine personenbezogenen Daten.`
    })
  });
  if(!mail.ok){
    await sbJson(`${base}/rest/v1/patient_report_deliveries?report_id=eq.${row.report_id}`,key,{method:"PATCH",headers:{Prefer:"return=minimal"},body:{download_notification_status:"failed",download_notification_last_error:`resend_${mail.status}`}}).catch(()=>{});
    return {ok:false,error:"notification_mail_failed"};
  }
  const sentAt=new Date().toISOString();
  await sbJson(`${base}/rest/v1/patient_report_deliveries?report_id=eq.${row.report_id}`,key,{method:"PATCH",headers:{Prefer:"return=minimal"},body:{download_notification_status:"sent",download_notification_sent_at:sentAt,download_notification_last_error:null}}).catch(()=>{});
  return {ok:true,sent:true};
}

export default async (req) => {
  if(req.method!=="POST") return j(405,{ok:false,error:"method_not_allowed"});
  const base=env("SUPABASE_URL"), key=env("SUPABASE_SERVICE_ROLE_KEY"), pepper=env("PATIENT_REPORT_DOB_PEPPER"), admin=env("PATIENT_REPORT_ADMIN_TOKEN");
  if(!base||!key||!pepper||!admin) return j(500,{ok:false,error:"server_configuration_missing"});
  let body; try{ body=await req.json(); }catch{return j(400,{ok:false,error:"invalid_json"});}
  const action=String(body?.action||"");

  if(action==="admin_prepare"){
    const supplied=req.headers.get("x-admin-token")||"";
    if(!validToken(supplied)||!safeEqHex(sha(supplied),sha(admin))) return j(403,{ok:false,error:"admin_denied"});
    const caseId=String(body.case_id||"").trim().toUpperCase(), dob=String(body.birth_date||"").trim();
    if(!validCase(caseId)||!validDob(dob)) return j(400,{ok:false,error:"invalid_input"});
    const c=await sbJson(`${base}/rest/v1/cases?case_id=eq.${encodeURIComponent(caseId)}&select=case_id&limit=1`,key);
    if(!c.r.ok||!Array.isArray(c.data)||c.data.length!==1) return j(404,{ok:false,error:"case_not_found"});
    await sbJson(`${base}/rest/v1/patient_report_deliveries?case_id=eq.${encodeURIComponent(caseId)}&status=in.(pending,ready)`,key,{method:"PATCH",headers:{Prefer:"return=minimal"},body:{status:"revoked",revoked_at:new Date().toISOString()}});
    const reportId=randomUUID(), objectPath=`${reportId}.enc`, accessToken=randomBytes(32).toString("base64url");
    const expiresAt=new Date(Date.now()+REPORT_VALID_DAYS*86400000).toISOString();
    const ins=await sbJson(`${base}/rest/v1/patient_report_deliveries`,key,{method:"POST",headers:{Prefer:"return=minimal"},body:{report_id:reportId,case_id:caseId,object_path:objectPath,status:"pending",access_token_hash:sha(accessToken),dob_hmac:dobHmac(dob,pepper),expires_at:expiresAt}});
    if(!ins.r.ok) return j(502,{ok:false,error:"prepare_failed"});
    try{
      const uploadUrl=await signedUpload(base,key,objectPath);
      return j(200,{ok:true,report_id:reportId,case_id:caseId,access_token:accessToken,signed_upload_url:uploadUrl,expires_at:expiresAt,max_encrypted_bytes:MAX_ENCRYPTED_BYTES});
    }catch{
      await sbJson(`${base}/rest/v1/patient_report_deliveries?report_id=eq.${reportId}`,key,{method:"PATCH",headers:{Prefer:"return=minimal"},body:{status:"revoked",revoked_at:new Date().toISOString()}}).catch(()=>{});
      return j(502,{ok:false,error:"signed_upload_failed"});
    }
  }

  if(action==="admin_finalize"){
    const supplied=req.headers.get("x-admin-token")||"";
    if(!validToken(supplied)||!safeEqHex(sha(supplied),sha(admin))) return j(403,{ok:false,error:"admin_denied"});
    const reportId=String(body.report_id||""), bytes=Number(body.encrypted_bytes), digest=String(body.payload_sha256||"").toLowerCase();
    if(!/^[0-9a-f-]{36}$/i.test(reportId)||!Number.isInteger(bytes)||bytes<=0||bytes>MAX_ENCRYPTED_BYTES||!/^[a-f0-9]{64}$/.test(digest)) return j(400,{ok:false,error:"invalid_finalize"});
    const q=await sbJson(`${base}/rest/v1/patient_report_deliveries?report_id=eq.${encodeURIComponent(reportId)}&select=report_id,case_id,object_path,status&limit=1`,key);
    if(!q.r.ok||!Array.isArray(q.data)||q.data.length!==1||q.data[0].status!=="pending") return j(409,{ok:false,error:"report_not_pending"});
    const size=await objectSize(base,key,q.data[0].object_path); if(size===null||size!==bytes) return j(409,{ok:false,error:"encrypted_size_mismatch"});
    const now=new Date().toISOString();
    const p=await sbJson(`${base}/rest/v1/patient_report_deliveries?report_id=eq.${encodeURIComponent(reportId)}`,key,{method:"PATCH",headers:{Prefer:"return=minimal"},body:{status:"ready",encrypted_bytes:bytes,payload_sha256:digest,ready_at:now}});
    if(!p.r.ok) return j(502,{ok:false,error:"finalize_failed"});
    return j(200,{ok:true,report_id:reportId,case_id:q.data[0].case_id});
  }

  if(action==="verify"){
    const token=String(body.access_token||"").trim(), dob=String(body.birth_date||"").trim();
    if(!validToken(token)||!validDob(dob)) return j(403,{ok:false,error:"access_denied"});
    const q=await sbJson(`${base}/rest/v1/patient_report_deliveries?access_token_hash=eq.${sha(token)}&select=report_id,case_id,object_path,status,dob_hmac,expires_at,revoked_at,failed_attempts,locked_until&limit=1`,key);
    if(!q.r.ok||!Array.isArray(q.data)||q.data.length!==1) return j(403,{ok:false,error:"access_denied"});
    const row=q.data[0], nowMs=Date.now();
    if(row.status!=="ready"||row.revoked_at||new Date(row.expires_at).getTime()<=nowMs) return j(403,{ok:false,error:"access_denied"});
    const lockMs=row.locked_until?new Date(row.locked_until).getTime():0;
    if(lockMs>nowMs) return j(429,{ok:false,error:"temporarily_locked",retry_after_seconds:Math.max(1,Math.ceil((lockMs-nowMs)/1000))});
    let attempts=Number(row.failed_attempts||0); if(lockMs&&lockMs<=nowMs) attempts=0;
    const candidate=dobHmac(dob,pepper);
    if(!safeEqHex(candidate,row.dob_hmac)){
      attempts+=1; const lock=attempts>=MAX_DOB_ATTEMPTS?new Date(nowMs+LOCK_MINUTES*60000).toISOString():null;
      await sbJson(`${base}/rest/v1/patient_report_deliveries?report_id=eq.${row.report_id}`,key,{method:"PATCH",headers:{Prefer:"return=minimal"},body:{failed_attempts:attempts>=MAX_DOB_ATTEMPTS?0:attempts,locked_until:lock}}).catch(()=>{});
      return j(attempts>=MAX_DOB_ATTEMPTS?429:403,{ok:false,error:attempts>=MAX_DOB_ATTEMPTS?"temporarily_locked":"access_denied",remaining_attempts:Math.max(0,MAX_DOB_ATTEMPTS-attempts)});
    }
    const url=await signedDownload(base,key,row.object_path);
    const now=new Date().toISOString();
    await sbJson(`${base}/rest/v1/patient_report_deliveries?report_id=eq.${row.report_id}`,key,{method:"PATCH",headers:{Prefer:"return=minimal"},body:{failed_attempts:0,locked_until:null,last_downloaded_at:now}}).catch(()=>{});
    await fetch(`${base}/rest/v1/rpc/increment_patient_report_download`,{method:"POST",headers:sbHeaders(key),body:JSON.stringify({p_report_id:row.report_id})}).catch(()=>{});
    return j(200,{ok:true,case_id:row.case_id,signed_download_url:url,expires_in_seconds:SIGNED_DOWNLOAD_SECONDS});
  }

  if(action==="confirm_download"){
    const token=String(body.access_token||"").trim();
    if(!validToken(token)) return j(403,{ok:false,error:"access_denied"});
    const result=await notifySuccessfulDownload({base,key,token});
    return j(result.ok?200:502,result);
  }

  return j(400,{ok:false,error:"unknown_action"});
};
