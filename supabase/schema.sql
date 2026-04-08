create table if not exists public.idea_rankings (
  id bigint generated always as identity primary key,
  axis_1_label text not null,
  axis_2_label text not null,
  ideas jsonb not null,
  created_at timestamptz not null default now()
);

alter table public.idea_rankings enable row level security;

drop policy if exists "Allow anonymous inserts for idea rankings" on public.idea_rankings;
drop policy if exists "Allow anonymous reads for idea rankings" on public.idea_rankings;

create policy "Allow anonymous inserts for idea rankings"
on public.idea_rankings
for insert
to anon
with check (true);

create policy "Allow anonymous reads for idea rankings"
on public.idea_rankings
for select
to anon
using (true);

grant insert, select on table public.idea_rankings to anon;
grant usage, select on sequence public.idea_rankings_id_seq to anon;
