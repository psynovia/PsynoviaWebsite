-- Parallel clinic collateral/document upload v2.
-- Additive only: the existing live upload tables remain untouched until cutover.

create table if not exists public.clinic_document_upload_tokens_v2 (
  id uuid primary key default gen_random_uuid(),
  case_id text not null references public.cases(case_id) on delete cascade,
  purpose text not null check (purpose in ('patient_documents','clinic_collateral')),
  token_hash text not null unique check (token_hash ~ '^[a-f0-9]{64}$'),
  mode text not null default 'live' check (mode in ('live','test')),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  upload_count integer not null default 0 check (upload_count >= 0),
  unique (case_id, purpose)
);

alter table public.clinic_document_upload_tokens_v2 enable row level security;
revoke all on table public.clinic_document_upload_tokens_v2 from anon, authenticated;
grant select, insert, update, delete on table public.clinic_document_upload_tokens_v2 to service_role;

create table if not exists public.clinic_document_uploads_v2 (
  id uuid primary key default gen_random_uuid(),
  case_id text not null references public.cases(case_id) on delete cascade,
  token_id uuid not null references public.clinic_document_upload_tokens_v2(id) on delete restrict,
  source text not null check (source in ('patient','clinic')),
  object_path text not null unique
    check (object_path ~ '^CHIEM-[0-9]{4}-[A-HJ-NP-Z2-9]{8}/[0-9a-f-]{36}\\.enc$'),
  status text not null default 'pending'
    check (status in ('pending','uploaded','failed','deleted')),
  encrypted_bytes bigint check (encrypted_bytes is null or (encrypted_bytes > 0 and encrypted_bytes <= 33554432)),
  payload_sha256 text check (payload_sha256 is null or payload_sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default now(),
  uploaded_at timestamptz,
  deleted_at timestamptz
);

alter table public.clinic_document_uploads_v2 enable row level security;
revoke all on table public.clinic_document_uploads_v2 from anon, authenticated;
grant select, insert, update, delete on table public.clinic_document_uploads_v2 to service_role;

create or replace function public.mark_clinic_document_uploaded_v2(
  p_upload_id uuid,
  p_case_id text,
  p_encrypted_bytes bigint,
  p_payload_sha256 text
)
returns boolean
language plpgsql
set search_path = public
as $$
declare
  v_token_id uuid;
begin
  update public.clinic_document_uploads_v2
     set status = 'uploaded',
         encrypted_bytes = p_encrypted_bytes,
         payload_sha256 = p_payload_sha256,
         uploaded_at = now()
   where id = p_upload_id
     and case_id = p_case_id
     and status = 'pending'
  returning token_id into v_token_id;

  if v_token_id is null then
    return false;
  end if;

  update public.clinic_document_upload_tokens_v2
     set upload_count = upload_count + 1,
         last_used_at = now()
   where id = v_token_id;

  return true;
end;
$$;

revoke all on function public.mark_clinic_document_uploaded_v2(uuid,text,bigint,text) from public;
grant execute on function public.mark_clinic_document_uploaded_v2(uuid,text,bigint,text) to service_role;
