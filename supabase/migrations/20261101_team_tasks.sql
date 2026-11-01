-- Team board: internal Sales / Ops / Marketing tasks.
-- Kept apart from public.tasks, which is the lead-card engine (desk-rules writes it, the Today stack reads it).
create table if not exists public.team_tasks (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  area text not null check (area in ('sales','ops','marketing')),
  title text not null check (length(btrim(title)) > 0),
  note text,
  owner_name text,                -- a name from desk_settings.settings.team; not every owner has a login (e.g. Ravinder)
  due_on date,
  status text not null default 'todo' check (status in ('todo','doing','done')),
  done_at timestamptz,
  done_by uuid references auth.users(id) on delete set null,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists team_tasks_store_status_idx on public.team_tasks(store_id, status, due_on);

drop trigger if exists team_tasks_touch on public.team_tasks;
create trigger team_tasks_touch before update on public.team_tasks for each row execute function public.desk_touch_updated_at();

alter table public.team_tasks enable row level security;
drop policy if exists team_tasks_member_select on public.team_tasks;
drop policy if exists team_tasks_member_insert on public.team_tasks;
drop policy if exists team_tasks_member_update on public.team_tasks;
drop policy if exists team_tasks_delete on public.team_tasks;
create policy team_tasks_member_select on public.team_tasks for select using (public.is_member(store_id) or public.is_platform_admin());
create policy team_tasks_member_insert on public.team_tasks for insert with check (public.is_member(store_id) or public.is_platform_admin());
create policy team_tasks_member_update on public.team_tasks for update using (public.is_member(store_id) or public.is_platform_admin());
-- owners, or whoever created the task, can delete it
create policy team_tasks_delete on public.team_tasks for delete using (public.is_owner(store_id) or created_by = auth.uid() or public.is_platform_admin());

-- Who can own a task. Edit this list in desk_settings to add or remove people.
update public.desk_settings
   set settings = settings || '{"team":["Shivam","Priya","Shiv","Ravinder","Davin"]}'::jsonb,
       updated_at = now()
 where store_id = '5d148dc0-bf36-4301-a4c2-3d5fbef12458' and not (settings ? 'team');
