-- Psynovia · Hogrefe-Linkpool
-- Sichere, idempotente und atomare Reservierung eines Testlinks je Fall und Testtyp.
-- Die eigentlichen Links sind ausschließlich serverseitig über den Supabase-Service-Role-Key zugänglich.

create extension if not exists pgcrypto;

create table if not exists public.hogrefe_links (
  id uuid primary key default gen_random_uuid(),
  test_type text not null,
  access_url text not null,
  status text not null default 'available',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  disabled_at timestamptz,
  notes text,

  constraint hogrefe_links_test_type_not_blank
    check (length(btrim(test_type)) > 0),
  constraint hogrefe_links_access_url_not_blank
    check (length(btrim(access_url)) > 0),
  constraint hogrefe_links_status_check
    check (status in ('available', 'assigned', 'disabled')),
  constraint hogrefe_links_access_url_unique
    unique (access_url)
);

create index if not exists hogrefe_links_available_lookup_idx
  on public.hogrefe_links (test_type, created_at, id)
  where status = 'available';

create table if not exists public.hogrefe_assignments (
  id uuid primary key default gen_random_uuid(),
  case_id text not null,
  test_type text not null,
  hogrefe_link_id uuid not null
    references public.hogrefe_links(id) on delete restrict,
  status text not null default 'assigned',
  assigned_at timestamptz not null default now(),
  email_sent_at timestamptz,
  replaced_at timestamptz,
  notes text,

  constraint hogrefe_assignments_case_id_not_blank
    check (length(btrim(case_id)) > 0),
  constraint hogrefe_assignments_test_type_not_blank
    check (length(btrim(test_type)) > 0),
  constraint hogrefe_assignments_status_check
    check (status in ('assigned', 'email_sent', 'replaced', 'cancelled')),
  constraint hogrefe_assignments_link_once_unique
    unique (hogrefe_link_id)
);

-- Pro Fall und Testtyp darf es nur eine aktive Zuweisung geben.
-- Historische, ersetzte oder stornierte Zuweisungen bleiben nachvollziehbar.
create unique index if not exists hogrefe_assignments_one_active_per_case_type_idx
  on public.hogrefe_assignments (case_id, test_type)
  where status in ('assigned', 'email_sent');

create index if not exists hogrefe_assignments_case_lookup_idx
  on public.hogrefe_assignments (case_id, assigned_at desc);

alter table public.hogrefe_links enable row level security;
alter table public.hogrefe_assignments enable row level security;

-- Keine Browser-/Client-Zugriffe. Der Service-Role-Key bleibt ausschließlich im Backend.
revoke all on table public.hogrefe_links from public, anon, authenticated;
revoke all on table public.hogrefe_assignments from public, anon, authenticated;

create or replace function public.reserve_hogrefe_link(
  p_case_id text,
  p_test_type text
)
returns table (
  assignment_id uuid,
  hogrefe_link_id uuid,
  case_id text,
  test_type text,
  access_url text,
  assignment_status text,
  assigned_at timestamptz,
  email_sent_at timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_case_id text := btrim(coalesce(p_case_id, ''));
  v_test_type text := btrim(coalesce(p_test_type, ''));
  v_link_id uuid;
begin
  if v_case_id = '' then
    raise exception 'case_id must not be empty' using errcode = '22023';
  end if;

  if v_test_type = '' then
    raise exception 'test_type must not be empty' using errcode = '22023';
  end if;

  if not exists (
    select 1
    from public.cases c
    where c.case_id = v_case_id
  ) then
    raise exception 'Unknown case_id: %', v_case_id using errcode = 'P0002';
  end if;

  -- Verhindert, dass parallele Webhook-Retries für denselben Fall
  -- gleichzeitig zwei Links reservieren.
  perform pg_advisory_xact_lock(
    hashtext('hogrefe:' || v_case_id || ':' || v_test_type)
  );

  -- Idempotenz: Bestehende aktive Zuweisung unverändert zurückgeben.
  return query
  select
    a.id,
    a.hogrefe_link_id,
    a.case_id,
    a.test_type,
    l.access_url,
    a.status,
    a.assigned_at,
    a.email_sent_at
  from public.hogrefe_assignments a
  join public.hogrefe_links l on l.id = a.hogrefe_link_id
  where a.case_id = v_case_id
    and a.test_type = v_test_type
    and a.status in ('assigned', 'email_sent')
  order by a.assigned_at desc
  limit 1;

  if found then
    return;
  end if;

  -- Atomare Entnahme des ältesten freien Links. SKIP LOCKED verhindert
  -- Doppelvergaben bei gleichzeitig eintreffenden Zahlungen.
  select l.id
  into v_link_id
  from public.hogrefe_links l
  where l.test_type = v_test_type
    and l.status = 'available'
  order by l.created_at, l.id
  for update skip locked
  limit 1;

  if v_link_id is null then
    raise exception 'HOGREFE_POOL_EMPTY:%', v_test_type using errcode = 'P0001';
  end if;

  update public.hogrefe_links
  set
    status = 'assigned',
    updated_at = now()
  where id = v_link_id
    and status = 'available';

  insert into public.hogrefe_assignments (
    case_id,
    test_type,
    hogrefe_link_id,
    status
  ) values (
    v_case_id,
    v_test_type,
    v_link_id,
    'assigned'
  );

  return query
  select
    a.id,
    a.hogrefe_link_id,
    a.case_id,
    a.test_type,
    l.access_url,
    a.status,
    a.assigned_at,
    a.email_sent_at
  from public.hogrefe_assignments a
  join public.hogrefe_links l on l.id = a.hogrefe_link_id
  where a.case_id = v_case_id
    and a.test_type = v_test_type
    and a.status = 'assigned'
  order by a.assigned_at desc
  limit 1;
end;
$$;

revoke all on function public.reserve_hogrefe_link(text, text)
  from public, anon, authenticated;
grant execute on function public.reserve_hogrefe_link(text, text)
  to service_role;

-- Vom Backend nach erfolgreich versendeter Zugangsmail aufzurufen.
create or replace function public.mark_hogrefe_mail_sent(
  p_case_id text,
  p_test_type text
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_updated integer;
begin
  update public.hogrefe_assignments
  set
    status = 'email_sent',
    email_sent_at = coalesce(email_sent_at, now())
  where case_id = btrim(coalesce(p_case_id, ''))
    and test_type = btrim(coalesce(p_test_type, ''))
    and status in ('assigned', 'email_sent');

  get diagnostics v_updated = row_count;
  return v_updated > 0;
end;
$$;

revoke all on function public.mark_hogrefe_mail_sent(text, text)
  from public, anon, authenticated;
grant execute on function public.mark_hogrefe_mail_sent(text, text)
  to service_role;
