create sequence if not exists public.sales_seq_no_seq;
alter table public.sales add column seq_no bigint;
update public.sales s set seq_no = x.rn from (select id, row_number() over (order by created_at, id) rn from public.sales) x where x.id = s.id;
select setval('public.sales_seq_no_seq', coalesce((select max(seq_no) from public.sales), 0) + 1, false);
alter table public.sales alter column seq_no set default nextval('public.sales_seq_no_seq');
alter sequence public.sales_seq_no_seq owned by public.sales.seq_no;
create unique index sales_seq_no_key on public.sales(seq_no);