-- Psynovia · Hogrefe-Linkpool
-- Ergänzt die sichtbare Hogrefe-ID (z. B. HASE-001)
-- und gibt sie bei der Reservierung zusammen mit dem Link zurück.

alter table public.hogrefe_links
  add column if not exists hogrefe_id text;

create unique index if not exists hogrefe_links_hogrefe_id_unique
  on public.hogrefe_links (hogrefe_id)
  where hogrefe_id is not null;

-- Der Rückgabetyp wird um hogrefe_id erweitert.
-- PostgreSQL erlaubt keine Änderung des Rückgabetyps per CREATE OR REPLACE,
-- deshalb wird die Funktion kontrolliert neu erstellt.
drop function if exists public.reserve_hogrefe_link(text, text);

create function public.reserve_hogrefe_link(
  p_case_id text,
  p_test_type text
)
returns table (
  assignment_id uuid,
  hogrefe_link_id uuid,
  case_id text,
  test_type text,
  hogrefe_id text,
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

  perform pg_advisory_xact_lock(
    hashtext('hogrefe:' || v_case_id || ':' || v_test_type)
  );

  -- Idempotenz: bereits bestehende aktive Zuweisung zurückgeben.
  return query
  select
    a.id,
    a.hogrefe_link_id,
    a.case_id,
    a.test_type,
    l.hogrefe_id,
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

  -- Ältesten freien Link atomar reservieren.
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
    l.hogrefe_id,
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
