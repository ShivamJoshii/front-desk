-- Front Desk — standalone project schema (own stores, members, auth). Floor Swap stays in its own project.
create extension if not exists pgcrypto;

create table if not exists public.stores (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  city text,
  phone text, email text, address text, website text,
  created_at timestamptz not null default now()
);
create table if not exists public.store_members (
  store_id uuid not null references public.stores(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'staff' check (role in ('owner','staff')),
  desk_role text check (desk_role in ('receptionist','visit_team','owner','operator')),
  display_name text,
  created_at timestamptz not null default now(),
  primary key (store_id, user_id)
);
create table if not exists public.store_invites (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  email text not null,
  role text not null default 'staff' check (role in ('owner','staff')),
  desk_role text check (desk_role in ('receptionist','visit_team','owner','operator')),
  display_name text,
  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  unique (store_id, email)
);
create table if not exists public.platform_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create or replace function public.is_member(p_store uuid) returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.store_members m where m.store_id = p_store and m.user_id = auth.uid());
$$;
create or replace function public.is_owner(p_store uuid) returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.store_members m where m.store_id = p_store and m.user_id = auth.uid() and m.role = 'owner');
$$;
create or replace function public.is_platform_admin() returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.platform_admins a where a.user_id = auth.uid());
$$;
-- called by the app right after sign-in: turns invites for this email into memberships
create or replace function public.accept_invites() returns integer language plpgsql security definer set search_path = public as $$
declare n integer := 0;
begin
  if auth.uid() is null then return 0; end if;
  insert into public.store_members (store_id, user_id, role, desk_role, display_name)
    select i.store_id, auth.uid(), i.role, i.desk_role, i.display_name
    from public.store_invites i
    where lower(i.email) = lower(coalesce(auth.email(), '')) and i.accepted_at is null
  on conflict (store_id, user_id) do update set role = excluded.role, desk_role = coalesce(excluded.desk_role, public.store_members.desk_role), display_name = coalesce(excluded.display_name, public.store_members.display_name);
  get diagnostics n = row_count;
  update public.store_invites set accepted_at = now() where lower(email) = lower(coalesce(auth.email(), '')) and accepted_at is null;
  return n;
end $$;

alter table public.stores enable row level security;
alter table public.store_members enable row level security;
alter table public.store_invites enable row level security;
alter table public.platform_admins enable row level security;
create policy stores_member_select on public.stores for select using (public.is_member(id) or public.is_platform_admin());
create policy stores_owner_update on public.stores for update using (public.is_owner(id) or public.is_platform_admin());
create policy members_select on public.store_members for select using (user_id = auth.uid() or public.is_member(store_id) or public.is_platform_admin());
create policy members_owner_write on public.store_members for all using (public.is_owner(store_id) or public.is_platform_admin()) with check (public.is_owner(store_id) or public.is_platform_admin());
create policy invites_owner on public.store_invites for all using (public.is_owner(store_id) or public.is_platform_admin()) with check (public.is_owner(store_id) or public.is_platform_admin());
create policy admins_self on public.platform_admins for select using (user_id = auth.uid());

create table if not exists public.leads (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  ghl_contact_id text, qb_customer_id text,
  first_name text, last_name text, phone text, email text,
  source text, source_detail text,
  stage text not null default 'new' check (stage in ('new','working','reached','consult_booked','consult_done','home_booked','home_done','estimate_sent','won','lost','nurture','customer')),
  stage_changed_at timestamptz not null default now(),
  owner_user_id uuid references auth.users(id),
  service text, why text, timeline text, tried_others text,
  buyer_type text check (buyer_type in ('price','quality','both')),
  sqft numeric, address text, photos_received int not null default 0,
  consent_source text, consent_at timestamptz,
  attempts int not null default 0, last_touch_at timestamptz, next_action_at timestamptz,
  lost_reason text, nurture_until date, est_value numeric, notes text, ghl_raw jsonb,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create unique index if not exists leads_ghl_uidx on public.leads(store_id, ghl_contact_id) where ghl_contact_id is not null;
create index if not exists leads_store_stage_idx on public.leads(store_id, stage);
create index if not exists leads_store_phone_idx on public.leads(store_id, phone);
create index if not exists leads_next_action_idx on public.leads(store_id, next_action_at);

create table if not exists public.lead_events (
  id bigserial primary key,
  store_id uuid not null references public.stores(id) on delete cascade,
  lead_id uuid references public.leads(id) on delete cascade,
  kind text not null check (kind in ('form','sms_in','sms_out','email_in','email_out','call','voicemail','note','consult','home_visit','estimate','payment','invoice','mockup','stage','task','walkin')),
  at timestamptz not null default now(), direction text check (direction in ('in','out')),
  body text, duration_s int, recording_url text, transcript text, summary text,
  ghl_message_id text, qb_txn_id text, by_user_id uuid references auth.users(id),
  meta jsonb not null default '{}'::jsonb
);
create unique index if not exists lead_events_ghl_msg_uidx on public.lead_events(ghl_message_id);
create unique index if not exists lead_events_qb_uidx on public.lead_events(kind, qb_txn_id);
create index if not exists lead_events_lead_idx on public.lead_events(lead_id, at desc);
create index if not exists lead_events_store_at_idx on public.lead_events(store_id, at desc);

create table if not exists public.tasks (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  lead_id uuid references public.leads(id) on delete cascade,
  kind text not null check (kind in ('call','text','confirm','brief','mockup','chase','rebook','walkin_followup','untouched','focus','eod','custom')),
  title text not null, say text, script jsonb, draft text,
  due_at timestamptz not null,
  assigned_role text not null default 'receptionist' check (assigned_role in ('receptionist','visit_team','owner','operator')),
  assigned_user_id uuid references auth.users(id),
  status text not null default 'open' check (status in ('open','done','snoozed','skipped')),
  outcome text, outcome_note text, done_at timestamptz, done_by uuid references auth.users(id),
  rule_key text, created_by text not null default 'rule', created_at timestamptz not null default now()
);
create unique index if not exists tasks_rule_once_uidx on public.tasks(lead_id, rule_key) where rule_key is not null and lead_id is not null;
create index if not exists tasks_store_due_idx on public.tasks(store_id, status, due_at);

create table if not exists public.appointments (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  lead_id uuid not null references public.leads(id) on delete cascade,
  kind text not null check (kind in ('consult','home_visit')),
  starts_at timestamptz not null, ends_at timestamptz,
  assignee_user_id uuid references auth.users(id), assignee_name text, ghl_event_id text,
  status text not null default 'booked' check (status in ('booked','confirmed','showed','no_show','cancelled','rescheduled')),
  confirmed_at timestamptz, outcome jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id), created_at timestamptz not null default now()
);
create unique index if not exists appointments_ghl_uidx on public.appointments(ghl_event_id) where ghl_event_id is not null;
create index if not exists appointments_store_start_idx on public.appointments(store_id, starts_at);

create table if not exists public.estimates (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  lead_id uuid references public.leads(id) on delete set null,
  qb_estimate_id text not null, doc_number text, qb_customer_id text, customer_name text,
  total numeric, status text, txn_date date, expiry_date date, accepted_at timestamptz, raw jsonb,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (store_id, qb_estimate_id)
);
create table if not exists public.invoices (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  lead_id uuid references public.leads(id) on delete set null,
  qb_invoice_id text not null, doc_number text, qb_customer_id text, customer_name text,
  total numeric, balance numeric, txn_date date, due_date date, raw jsonb,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (store_id, qb_invoice_id)
);
create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  lead_id uuid references public.leads(id) on delete set null,
  qb_payment_id text not null, qb_customer_id text, customer_name text,
  amount numeric not null, txn_date date, method text, is_deposit boolean not null default false, raw jsonb,
  created_at timestamptz not null default now(),
  unique (store_id, qb_payment_id)
);
create table if not exists public.daily_reports (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  user_id uuid references auth.users(id),
  report_date date not null, kind text not null check (kind in ('focus','eod')),
  picks jsonb not null default '[]'::jsonb, text text, numbers jsonb not null default '{}'::jsonb,
  posted_at timestamptz not null default now(),
  unique (store_id, report_date, kind, user_id)
);
create table if not exists public.desk_settings (
  store_id uuid primary key references public.stores(id) on delete cascade,
  settings jsonb not null default '{}'::jsonb, updated_at timestamptz not null default now()
);
-- tokens + cursors. RLS on, no policies: service role only.
create table if not exists public.integrations (
  store_id uuid not null references public.stores(id) on delete cascade,
  provider text not null check (provider in ('ghl','qbo','slack','deepgram')),
  config jsonb not null default '{}'::jsonb, secrets jsonb not null default '{}'::jsonb,
  status text not null default 'disconnected' check (status in ('connected','disconnected','error')),
  cursor jsonb not null default '{}'::jsonb, last_sync_at timestamptz, last_error text,
  updated_at timestamptz not null default now(),
  primary key (store_id, provider)
);

create or replace function public.desk_touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
create trigger leads_touch before update on public.leads for each row execute function public.desk_touch_updated_at();
create trigger estimates_touch before update on public.estimates for each row execute function public.desk_touch_updated_at();
create trigger invoices_touch before update on public.invoices for each row execute function public.desk_touch_updated_at();

create or replace function public.desk_integration_status(p_store uuid)
returns table (provider text, status text, last_sync_at timestamptz, last_error text, config jsonb)
language sql security definer set search_path = public as $$
  select i.provider, i.status, i.last_sync_at, i.last_error, i.config
  from public.integrations i
  where i.store_id = p_store and (public.is_member(p_store) or public.is_platform_admin());
$$;

alter table public.leads enable row level security;
alter table public.lead_events enable row level security;
alter table public.tasks enable row level security;
alter table public.appointments enable row level security;
alter table public.estimates enable row level security;
alter table public.invoices enable row level security;
alter table public.payments enable row level security;
alter table public.daily_reports enable row level security;
alter table public.desk_settings enable row level security;
alter table public.integrations enable row level security;

do $$
declare t text;
begin
  foreach t in array array['leads','lead_events','tasks','appointments','estimates','invoices','payments','daily_reports','desk_settings'] loop
    execute format('create policy %I on public.%I for select using (public.is_member(store_id) or public.is_platform_admin())', t||'_member_select', t);
    execute format('create policy %I on public.%I for insert with check (public.is_member(store_id) or public.is_platform_admin())', t||'_member_insert', t);
    execute format('create policy %I on public.%I for update using (public.is_member(store_id) or public.is_platform_admin())', t||'_member_update', t);
    execute format('create policy %I on public.%I for delete using (public.is_owner(store_id) or public.is_platform_admin())', t||'_owner_delete', t);
  end loop;
end $$;


-- Floor & More: same store id as before so nothing downstream changes
insert into public.stores (id, name, city, phone, email, address, website) values
  ('5d148dc0-bf36-4301-a4c2-3d5fbef12458','Floor & More','Edmonton','+17809378600','info@floorandmorecanada.com','7027 Roper Rd NW, Edmonton, AB T6B 3K3','https://floorandmorecanada.com/')
on conflict (id) do nothing;

insert into public.desk_settings (store_id, settings) values (
  '5d148dc0-bf36-4301-a4c2-3d5fbef12458',
  '{"timezone":"America/Edmonton","hours":{"weekday":["08:30","16:30"],"weekend":["10:00","16:30"]},
    "sla_first_call_min":5,"cadence":{"calls_per_day":2,"days":3,"text_after_miss":true},
    "consult":{"slot_min":45,"start":"09:00","end":"16:00"},"home_visit":{"per_day":1,"assignees":["Ravinder","Shiv"]},
    "deposit_pct":50,"won_on":"deposit_payment","estimate_chase_days":[1,3,7,14],"untouched_hours":48,
    "focus_time":"08:30","eod_time":"16:15","nightly_time":"21:00","qualify_min_job":5000}'::jsonb
) on conflict (store_id) do nothing;

insert into public.integrations (store_id, provider, config) values
  ('5d148dc0-bf36-4301-a4c2-3d5fbef12458','ghl','{"location_id":"86Uyutj3iWpx7aNPC7ng"}'::jsonb),
  ('5d148dc0-bf36-4301-a4c2-3d5fbef12458','qbo','{"country":"CA"}'::jsonb)
on conflict do nothing;

-- who can sign in (accept_invites turns these into memberships on first login)
insert into public.store_invites (store_id, email, role, desk_role, display_name) values
  ('5d148dc0-bf36-4301-a4c2-3d5fbef12458','hello@mybuilder.ca','owner','operator','Shivam'),
  ('5d148dc0-bf36-4301-a4c2-3d5fbef12458','shivam-joshi1@protonmail.com','owner','operator','Shivam'),
  ('5d148dc0-bf36-4301-a4c2-3d5fbef12458','mybuilderagency@gmail.com','owner','operator','Shivam'),
  ('5d148dc0-bf36-4301-a4c2-3d5fbef12458','d.sandhu1101@gmail.com','staff','operator','Davin'),
  ('5d148dc0-bf36-4301-a4c2-3d5fbef12458','admin@floorandmorecanada.com','owner','owner','Priya'),
  ('5d148dc0-bf36-4301-a4c2-3d5fbef12458','info@floorandmorecanada.com','owner','owner','Shiv')
on conflict (store_id, email) do nothing;
