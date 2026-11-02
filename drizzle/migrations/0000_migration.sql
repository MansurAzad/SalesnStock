
create type public.app_role as enum ('super_admin','dealer_admin','branch_manager','sales','accountant','auditor');

create table public.branches (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  code text not null unique,
  brand text,
  address text,
  phone text,
  is_dealer_house boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  email text,
  branch_id uuid references public.branches(id) on delete set null,
  created_at timestamptz not null default now()
);

create table public.user_roles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade not null,
  role app_role not null,
  unique (user_id, role)
);

create table public.products (
  id uuid primary key default gen_random_uuid(),
  brand text not null,
  model text not null,
  variant text,
  kind text not null default 'phone' check (kind in ('phone','accessory')),
  purchase_price numeric(12,2) not null default 0,
  sale_price numeric(12,2) not null default 0,
  created_at timestamptz not null default now()
);

create table public.inventory_items (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id),
  branch_id uuid not null references public.branches(id),
  imei text not null unique,
  imei2 text,
  status text not null default 'in_stock' check (status in ('in_stock','in_transit','sold','returned','damaged')),
  purchase_price numeric(12,2) not null default 0,
  supplier text,
  created_at timestamptz not null default now()
);

create table public.stock_transfers (
  id uuid primary key default gen_random_uuid(),
  transfer_no text not null unique default ('TR-' || to_char(now(),'YYMMDD') || '-' || substr(gen_random_uuid()::text,1,6)),
  from_branch_id uuid not null references public.branches(id),
  to_branch_id uuid not null references public.branches(id),
  status text not null default 'in_transit' check (status in ('in_transit','received','cancelled')),
  note text,
  created_by uuid,
  received_by uuid,
  created_at timestamptz not null default now(),
  received_at timestamptz
);

create table public.transfer_items (
  id uuid primary key default gen_random_uuid(),
  transfer_id uuid not null references public.stock_transfers(id) on delete cascade,
  item_id uuid not null references public.inventory_items(id)
);

create table public.customers (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references public.branches(id),
  name text not null,
  phone text not null,
  nid text,
  address text,
  created_at timestamptz not null default now()
);

create table public.sales (
  id uuid primary key default gen_random_uuid(),
  invoice_no text not null unique default ('INV-' || to_char(now(),'YYMMDD') || '-' || substr(gen_random_uuid()::text,1,6)),
  branch_id uuid not null references public.branches(id),
  customer_id uuid references public.customers(id),
  sale_type text not null default 'cash' check (sale_type in ('cash','installment')),
  subtotal numeric(12,2) not null default 0,
  discount numeric(12,2) not null default 0,
  total numeric(12,2) not null default 0,
  paid numeric(12,2) not null default 0,
  payment_method text not null default 'cash',
  created_by uuid,
  created_at timestamptz not null default now()
);

create table public.sale_items (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references public.sales(id) on delete cascade,
  item_id uuid not null references public.inventory_items(id),
  price numeric(12,2) not null
);

create table public.installment_plans (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references public.sales(id) on delete cascade,
  branch_id uuid not null references public.branches(id),
  customer_id uuid not null references public.customers(id),
  financed_amount numeric(12,2) not null,
  down_payment numeric(12,2) not null default 0,
  months int not null,
  monthly_amount numeric(12,2) not null,
  status text not null default 'active' check (status in ('active','completed')),
  created_at timestamptz not null default now()
);

create table public.installments (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references public.installment_plans(id) on delete cascade,
  branch_id uuid not null references public.branches(id),
  seq int not null,
  due_date date not null,
  amount numeric(12,2) not null,
  paid_amount numeric(12,2) not null default 0,
  paid_at timestamptz
);

create table public.transactions (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references public.branches(id),
  kind text not null check (kind in ('income','expense')),
  category text not null,
  amount numeric(12,2) not null check (amount > 0),
  note text,
  ref_id uuid,
  created_by uuid,
  created_at timestamptz not null default now()
);

create table public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid,
  action text not null,
  details jsonb,
  created_at timestamptz not null default now()
);

-- grants
grant select, insert, update, delete on public.branches, public.profiles, public.products, public.inventory_items, public.stock_transfers, public.transfer_items, public.customers, public.sales, public.sale_items, public.installment_plans, public.installments, public.transactions to authenticated;
grant select on public.user_roles, public.audit_logs to authenticated;
grant all on public.branches, public.profiles, public.user_roles, public.products, public.inventory_items, public.stock_transfers, public.transfer_items, public.customers, public.sales, public.sale_items, public.installment_plans, public.installments, public.transactions, public.audit_logs to service_role;

-- helper functions
create or replace function public.has_role(_user_id uuid, _role app_role) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.user_roles where user_id = _user_id and role = _role)
$$;

create or replace function public.is_hq(_uid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.user_roles where user_id = _uid and role in ('super_admin','dealer_admin','accountant','auditor'))
$$;

create or replace function public.can_write_hq(_uid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.user_roles where user_id = _uid and role in ('super_admin','dealer_admin'))
$$;

create or replace function public.user_branch(_uid uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select branch_id from public.profiles where id = _uid
$$;

create or replace function public.can_access_branch(_uid uuid, _branch uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_hq(_uid) or public.user_branch(_uid) = _branch
$$;

create or replace function public.can_operate_branch(_uid uuid, _branch uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.can_write_hq(_uid) or (
    public.user_branch(_uid) = _branch and exists (
      select 1 from public.user_roles where user_id = _uid and role in ('branch_manager','sales','accountant')))
$$;

-- RLS
alter table public.branches enable row level security;
alter table public.profiles enable row level security;
alter table public.user_roles enable row level security;
alter table public.products enable row level security;
alter table public.inventory_items enable row level security;
alter table public.stock_transfers enable row level security;
alter table public.transfer_items enable row level security;
alter table public.customers enable row level security;
alter table public.sales enable row level security;
alter table public.sale_items enable row level security;
alter table public.installment_plans enable row level security;
alter table public.installments enable row level security;
alter table public.transactions enable row level security;
alter table public.audit_logs enable row level security;

create policy "read branches" on public.branches for select to authenticated using (true);
create policy "hq manage branches" on public.branches for all to authenticated using (public.can_write_hq(auth.uid())) with check (public.can_write_hq(auth.uid()));

create policy "read own or hq profiles" on public.profiles for select to authenticated using (id = auth.uid() or public.is_hq(auth.uid()));
create policy "update own name" on public.profiles for update to authenticated using (id = auth.uid() or public.can_write_hq(auth.uid())) with check (id = auth.uid() or public.can_write_hq(auth.uid()));

create policy "read own or hq roles" on public.user_roles for select to authenticated using (user_id = auth.uid() or public.is_hq(auth.uid()));

create policy "read products" on public.products for select to authenticated using (true);
create policy "hq manage products" on public.products for all to authenticated using (public.can_write_hq(auth.uid())) with check (public.can_write_hq(auth.uid()));

create policy "read items" on public.inventory_items for select to authenticated using (public.can_access_branch(auth.uid(), branch_id));
create policy "hq manage items" on public.inventory_items for all to authenticated using (public.can_write_hq(auth.uid())) with check (public.can_write_hq(auth.uid()));

create policy "read transfers" on public.stock_transfers for select to authenticated using (public.can_access_branch(auth.uid(), from_branch_id) or public.can_access_branch(auth.uid(), to_branch_id));
create policy "read transfer items" on public.transfer_items for select to authenticated using (exists (select 1 from public.stock_transfers t where t.id = transfer_id and (public.can_access_branch(auth.uid(), t.from_branch_id) or public.can_access_branch(auth.uid(), t.to_branch_id))));

create policy "read customers" on public.customers for select to authenticated using (public.can_access_branch(auth.uid(), branch_id));
create policy "insert customers" on public.customers for insert to authenticated with check (public.can_operate_branch(auth.uid(), branch_id));
create policy "update customers" on public.customers for update to authenticated using (public.can_operate_branch(auth.uid(), branch_id)) with check (public.can_operate_branch(auth.uid(), branch_id));

create policy "read sales" on public.sales for select to authenticated using (public.can_access_branch(auth.uid(), branch_id));
create policy "read sale items" on public.sale_items for select to authenticated using (exists (select 1 from public.sales s where s.id = sale_id and public.can_access_branch(auth.uid(), s.branch_id)));
create policy "read plans" on public.installment_plans for select to authenticated using (public.can_access_branch(auth.uid(), branch_id));
create policy "read installments" on public.installments for select to authenticated using (public.can_access_branch(auth.uid(), branch_id));

create policy "read tx" on public.transactions for select to authenticated using (public.can_access_branch(auth.uid(), branch_id));
create policy "insert tx" on public.transactions for insert to authenticated with check (public.can_operate_branch(auth.uid(), branch_id) and created_by = auth.uid());

create policy "hq read audit" on public.audit_logs for select to authenticated using (public.is_hq(auth.uid()));

-- signup trigger: profile + first user becomes super_admin
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, full_name, email)
  values (new.id, coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email,'@',1)), new.email);
  if not exists (select 1 from public.user_roles where role = 'super_admin') then
    insert into public.user_roles (user_id, role) values (new.id, 'super_admin');
  end if;
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
for each row execute function public.handle_new_user();

-- admin: set user role + branch
create or replace function public.admin_set_user(_user uuid, _role app_role, _branch uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.can_write_hq(auth.uid()) then raise exception 'Not allowed'; end if;
  if _role = 'super_admin' and not public.has_role(auth.uid(),'super_admin') then raise exception 'Only super admin can grant super admin'; end if;
  delete from public.user_roles where user_id = _user;
  insert into public.user_roles (user_id, role) values (_user, _role);
  update public.profiles set branch_id = _branch where id = _user;
  insert into public.audit_logs (user_id, action, details) values (auth.uid(), 'set_user_role', jsonb_build_object('user', _user, 'role', _role, 'branch', _branch));
end $$;

-- create transfer
create or replace function public.create_transfer(_from uuid, _to uuid, _item_ids uuid[], _note text) returns uuid
language plpgsql security definer set search_path = public as $$
declare t_id uuid; bad int;
begin
  if not public.can_operate_branch(auth.uid(), _from) then raise exception 'Not allowed for source branch'; end if;
  if _from = _to then raise exception 'Source and destination must differ'; end if;
  if coalesce(array_length(_item_ids,1),0) = 0 then raise exception 'No items selected'; end if;
  select count(*) into bad from public.inventory_items where id = any(_item_ids) and (branch_id <> _from or status <> 'in_stock');
  if bad > 0 then raise exception 'Some items are not in stock at source branch'; end if;
  insert into public.stock_transfers (from_branch_id, to_branch_id, note, created_by) values (_from, _to, _note, auth.uid()) returning id into t_id;
  insert into public.transfer_items (transfer_id, item_id) select t_id, unnest(_item_ids);
  update public.inventory_items set status = 'in_transit' where id = any(_item_ids);
  insert into public.audit_logs (user_id, action, details) values (auth.uid(), 'create_transfer', jsonb_build_object('transfer', t_id, 'count', array_length(_item_ids,1)));
  return t_id;
end $$;

create or replace function public.receive_transfer(_transfer uuid) returns void
language plpgsql security definer set search_path = public as $$
declare t record;
begin
  select * into t from public.stock_transfers where id = _transfer for update;
  if t is null or t.status <> 'in_transit' then raise exception 'Transfer not in transit'; end if;
  if not public.can_operate_branch(auth.uid(), t.to_branch_id) then raise exception 'Not allowed'; end if;
  update public.inventory_items set status = 'in_stock', branch_id = t.to_branch_id
    where id in (select item_id from public.transfer_items where transfer_id = _transfer);
  update public.stock_transfers set status = 'received', received_by = auth.uid(), received_at = now() where id = _transfer;
  insert into public.audit_logs (user_id, action, details) values (auth.uid(), 'receive_transfer', jsonb_build_object('transfer', _transfer));
end $$;

-- create sale
create or replace function public.create_sale(
  _branch uuid, _customer uuid, _items jsonb, _discount numeric, _paid numeric, _method text,
  _sale_type text, _months int
) returns uuid
language plpgsql security definer set search_path = public as $$
declare s_id uuid; p_id uuid; sub numeric := 0; tot numeric; ids uuid[]; bad int; remaining numeric; monthly numeric; i int;
begin
  if not public.can_operate_branch(auth.uid(), _branch) then raise exception 'Not allowed for this branch'; end if;
  select array_agg((e->>'item_id')::uuid), coalesce(sum((e->>'price')::numeric),0) into ids, sub from jsonb_array_elements(_items) e;
  if ids is null then raise exception 'Cart is empty'; end if;
  select count(*) into bad from public.inventory_items where id = any(ids) and (branch_id <> _branch or status <> 'in_stock');
  if bad > 0 then raise exception 'Some items are not available in this branch'; end if;
  if coalesce(_discount,0) < 0 or _discount > sub then raise exception 'Invalid discount'; end if;
  tot := sub - coalesce(_discount,0);
  if _paid < 0 or _paid > tot then raise exception 'Invalid paid amount'; end if;
  if _sale_type = 'cash' and _paid <> tot then raise exception 'Cash sale must be fully paid'; end if;
  if _sale_type = 'installment' then
    if _customer is null then raise exception 'Customer is required for installment'; end if;
    if _months is null or _months < 1 or _months > 36 then raise exception 'Months must be 1-36'; end if;
    if _paid >= tot then raise exception 'Down payment must be less than total'; end if;
  end if;

  insert into public.sales (branch_id, customer_id, sale_type, subtotal, discount, total, paid, payment_method, created_by)
  values (_branch, _customer, _sale_type, sub, coalesce(_discount,0), tot, _paid, _method, auth.uid()) returning id into s_id;
  insert into public.sale_items (sale_id, item_id, price)
    select s_id, (e->>'item_id')::uuid, (e->>'price')::numeric from jsonb_array_elements(_items) e;
  update public.inventory_items set status = 'sold' where id = any(ids);

  if _paid > 0 then
    insert into public.transactions (branch_id, kind, category, amount, note, ref_id, created_by)
    values (_branch, 'income', case when _sale_type='installment' then 'Down payment' else 'Sales' end, _paid, 'Invoice sale', s_id, auth.uid());
  end if;

  if _sale_type = 'installment' then
    remaining := tot - _paid;
    monthly := round(remaining / _months, 2);
    insert into public.installment_plans (sale_id, branch_id, customer_id, financed_amount, down_payment, months, monthly_amount)
    values (s_id, _branch, _customer, remaining, _paid, _months, monthly) returning id into p_id;
    for i in 1.._months loop
      insert into public.installments (plan_id, branch_id, seq, due_date, amount)
      values (p_id, _branch, i, (current_date + (i || ' month')::interval)::date,
        case when i = _months then remaining - monthly * (_months - 1) else monthly end);
    end loop;
  end if;
  insert into public.audit_logs (user_id, action, details) values (auth.uid(), 'create_sale', jsonb_build_object('sale', s_id, 'total', tot));
  return s_id;
end $$;

create or replace function public.pay_installment(_inst uuid, _amount numeric) returns void
language plpgsql security definer set search_path = public as $$
declare r record; due numeric;
begin
  select * into r from public.installments where id = _inst for update;
  if r is null then raise exception 'Not found'; end if;
  if not public.can_operate_branch(auth.uid(), r.branch_id) then raise exception 'Not allowed'; end if;
  due := r.amount - r.paid_amount;
  if _amount <= 0 or _amount > due then raise exception 'Amount must be between 1 and %', due; end if;
  update public.installments set paid_amount = paid_amount + _amount, paid_at = case when paid_amount + _amount >= amount then now() else paid_at end where id = _inst;
  insert into public.transactions (branch_id, kind, category, amount, note, ref_id, created_by)
  values (r.branch_id, 'income', 'Installment', _amount, 'Installment #' || r.seq, r.plan_id, auth.uid());
  if not exists (select 1 from public.installments where plan_id = r.plan_id and paid_amount < amount) then
    update public.installment_plans set status = 'completed' where id = r.plan_id;
  end if;
end $$;

-- seed
insert into public.branches (name, code, brand, address, is_dealer_house) values
 ('Central Dealer House','HQ',null,'Dhaka',true),
 ('OPPO Showroom Konabari','OPPO-KB','OPPO','Konabari, Gazipur',false),
 ('Vivo Showroom Mouchak','VIVO-MC','Vivo','Mouchak, Gazipur',false),
 ('Xiaomi Showroom Dhaka','MI-DH','Xiaomi','Dhaka',false);

insert into public.products (brand, model, variant, purchase_price, sale_price) values
 ('OPPO','A79','8/256',24500,27990),
 ('Vivo','Y28','8/128',19800,22490),
 ('Xiaomi','Redmi Note 13','8/256',23000,25999),
 ('TECNO','Spark 20','8/128',13800,15490),
 ('Infinix','Hot 40','8/256',15200,16999);

insert into public.inventory_items (product_id, branch_id, imei, purchase_price)
select p.id, b.id, '35' || lpad((row_number() over ())::text || floor(random()*1000000000)::text, 13, '0'), p.purchase_price
from public.products p cross join generate_series(1,4) g
join public.branches b on b.code = 'HQ';
