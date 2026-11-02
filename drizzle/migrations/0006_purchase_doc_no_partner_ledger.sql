CREATE SEQUENCE IF NOT EXISTS public.purchases_seq_no_seq;
ALTER TABLE public.purchases ADD COLUMN IF NOT EXISTS seq_no bigint;
UPDATE public.purchases p SET seq_no = x.rn FROM (SELECT id, row_number() OVER (ORDER BY created_at, id) rn FROM public.purchases) x WHERE x.id = p.id AND p.seq_no IS NULL;
SELECT setval('public.purchases_seq_no_seq', GREATEST(1, (SELECT coalesce(max(seq_no),0) FROM public.purchases)), (SELECT count(*) > 0 FROM public.purchases));
ALTER TABLE public.purchases ALTER COLUMN seq_no SET DEFAULT nextval('public.purchases_seq_no_seq');
GRANT USAGE ON SEQUENCE public.purchases_seq_no_seq TO authenticated, service_role;

CREATE TABLE public.finance_partner_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid NOT NULL REFERENCES public.finance_partners(id),
  branch_id uuid NOT NULL REFERENCES public.branches(id),
  kind text NOT NULL CHECK (kind IN ('received','paid')),
  amount numeric NOT NULL CHECK (amount > 0),
  method text NOT NULL DEFAULT 'cash',
  note text,
  case_id uuid REFERENCES public.finance_cases(id),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.finance_partner_ledger TO authenticated;
GRANT ALL ON public.finance_partner_ledger TO service_role;
ALTER TABLE public.finance_partner_ledger ENABLE ROW LEVEL SECURITY;
CREATE POLICY "branch can read partner ledger" ON public.finance_partner_ledger FOR SELECT TO authenticated USING (public.can_access_branch(auth.uid(), branch_id));

INSERT INTO public.finance_partner_ledger (partner_id, branch_id, kind, amount, note, case_id, created_by, created_at)
SELECT c.partner_id, c.branch_id, 'received', c.amount - c.commission, 'Settlement ' || coalesce(c.ref_no,''), c.id, c.created_by, coalesce(c.settled_at, c.created_at)
FROM public.finance_cases c WHERE c.status = 'settled' AND c.amount - c.commission > 0;

CREATE OR REPLACE FUNCTION public.settle_finance(_case uuid, _received numeric)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare c public.finance_cases; t uuid;
begin
  select * into c from public.finance_cases where id = _case for update;
  if c.id is null then raise exception 'Case not found'; end if;
  if not public.can_operate_branch(auth.uid(), c.branch_id) then raise exception 'Not allowed'; end if;
  if c.status <> 'pending' then raise exception 'Already settled'; end if;
  if _received < 0 or _received > c.amount then raise exception 'Invalid amount'; end if;
  update public.finance_cases set status = 'settled', settled_at = now(), commission = c.amount - _received where id = _case;
  insert into public.transactions(branch_id, kind, category, amount, note, ref_id, created_by)
  values (c.branch_id, 'income', 'finance_settlement', _received, coalesce(c.ref_no, '') || ' ' || c.customer_name, c.id, auth.uid());
  if _received > 0 then
    insert into public.finance_partner_ledger(partner_id, branch_id, kind, amount, note, case_id, created_by)
    values (c.partner_id, c.branch_id, 'received', _received, 'Settlement ' || coalesce(c.ref_no,''), c.id, auth.uid());
  end if;
end $function$;

CREATE OR REPLACE FUNCTION public.partner_payment(_partner uuid, _branch uuid, _kind text, _amount numeric, _method text, _note text)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare pname text;
begin
  if not public.can_operate_branch(auth.uid(), _branch) then raise exception 'Not allowed'; end if;
  if _kind not in ('received','paid') then raise exception 'Invalid kind'; end if;
  if _amount is null or _amount <= 0 then raise exception 'Amount must be positive'; end if;
  select name into pname from public.finance_partners where id = _partner;
  if pname is null then raise exception 'Partner not found'; end if;
  insert into public.finance_partner_ledger(partner_id, branch_id, kind, amount, method, note, created_by)
  values (_partner, _branch, _kind, _amount, coalesce(_method,'cash'), _note, auth.uid());
  insert into public.transactions(branch_id, kind, category, amount, note, ref_id, created_by)
  values (_branch, case when _kind = 'received' then 'income' else 'expense' end,
          case when _kind = 'received' then 'Finance partner receipt' else 'Finance partner payment' end,
          _amount, pname || coalesce(' — ' || nullif(_note,''), ''), _partner, auth.uid());
  insert into public.audit_logs(user_id, action, details) values (auth.uid(), 'partner_' || _kind, jsonb_build_object('partner', _partner, 'branch', _branch, 'amount', _amount));
end $function$;