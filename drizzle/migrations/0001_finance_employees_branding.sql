create table public.finance_partners (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  contact text,
  commission_pct numeric not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
grant select, insert, update, delete on public.finance_partners to authenticated;
grant all on public.finance_partners to service_role;
alter table public.finance_partners enable row level security;
create policy "read partners" on public.finance_partners for select to authenticated using (true);
create policy "hq manage partners" on public.finance_partners for all to authenticated using (public.can_write_hq(auth.uid())) with check (public.can_write_hq(auth.uid()));

create table public.finance_cases (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references public.branches(id),
  partner_id uuid not null references public.finance_partners(id),
  sale_id uuid references public.sales(id),
  customer_name text not null,
  customer_phone text,
  ref_no text,
  amount numeric not null,
  commission numeric not null default 0,
  status text not null default 'pending',
  note text,
  created_by uuid,
  created_at timestamptz not null default now(),
  settled_at timestamptz
);
grant select, insert, update on public.finance_cases to authenticated;
grant all on public.finance_cases to service_role;
alter table public.finance_cases enable row level security;
create policy "read cases" on public.finance_cases for select to authenticated using (public.can_access_branch(auth.uid(), branch_id));
create policy "insert cases" on public.finance_cases for insert to authenticated with check (public.can_operate_branch(auth.uid(), branch_id) and status = 'pending' and created_by = auth.uid());

create or replace function public.settle_finance(_case uuid, _received numeric) returns void
language plpgsql security definer set search_path = public as $$
declare c public.finance_cases;
begin
  select * into c from public.finance_cases where id = _case for update;
  if c.id is null then raise exception 'Case not found'; end if;
  if not public.can_operate_branch(auth.uid(), c.branch_id) then raise exception 'Not allowed'; end if;
  if c.status <> 'pending' then raise exception 'Already settled'; end if;
  update public.finance_cases set status = 'settled', settled_at = now(), commission = c.amount - _received where id = _case;
  insert into public.transactions(branch_id, kind, category, amount, note, ref_id, created_by)
  values (c.branch_id, 'income', 'finance_settlement', _received, coalesce(c.ref_no, '') || ' ' || c.customer_name, c.id, auth.uid());
end $$;

create table public.employees (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references public.branches(id),
  name text not null,
  phone text,
  designation text,
  salary numeric not null default 0,
  joined_on date,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
grant select, insert, update on public.employees to authenticated;
grant all on public.employees to service_role;
alter table public.employees enable row level security;
create policy "read employees" on public.employees for select to authenticated using (public.can_access_branch(auth.uid(), branch_id));
create policy "manage employees" on public.employees for insert to authenticated with check (public.can_write_hq(auth.uid()) or (public.user_branch(auth.uid()) = branch_id and public.has_role(auth.uid(), 'branch_manager')));
create policy "update employees" on public.employees for update to authenticated using (public.can_write_hq(auth.uid()) or (public.user_branch(auth.uid()) = branch_id and public.has_role(auth.uid(), 'branch_manager'))) with check (public.can_write_hq(auth.uid()) or (public.user_branch(auth.uid()) = branch_id and public.has_role(auth.uid(), 'branch_manager')));

create table public.attendance (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id),
  branch_id uuid not null references public.branches(id),
  day date not null default current_date,
  status text not null default 'present',
  check_in time,
  check_out time,
  note text,
  unique (employee_id, day)
);
grant select, insert, update on public.attendance to authenticated;
grant all on public.attendance to service_role;
alter table public.attendance enable row level security;
create policy "read attendance" on public.attendance for select to authenticated using (public.can_access_branch(auth.uid(), branch_id));
create policy "insert attendance" on public.attendance for insert to authenticated with check (public.can_operate_branch(auth.uid(), branch_id));
create policy "update attendance" on public.attendance for update to authenticated using (public.can_operate_branch(auth.uid(), branch_id)) with check (public.can_operate_branch(auth.uid(), branch_id));

create table public.app_settings (
  id int primary key default 1 check (id = 1),
  company_name text not null default 'Dealer ERP',
  tagline text,
  logo_url text,
  phone text,
  address text,
  invoice_footer text,
  updated_at timestamptz not null default now()
);
grant select, insert, update on public.app_settings to authenticated;
grant all on public.app_settings to service_role;
alter table public.app_settings enable row level security;
create policy "read settings" on public.app_settings for select to authenticated using (true);
create policy "hq insert settings" on public.app_settings for insert to authenticated with check (public.can_write_hq(auth.uid()));
create policy "hq update settings" on public.app_settings for update to authenticated using (public.can_write_hq(auth.uid())) with check (public.can_write_hq(auth.uid()));
insert into public.app_settings (id) values (1) on conflict do nothing;