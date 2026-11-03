-- 0017 — security & data-integrity hardening
--
-- Issues fixed here (from the full audit):
--   1. can_operate_branch() / can_access_branch() / can_approve_branch() returned NULL for a
--      user with no branch, and `IF NOT can_operate_branch(...)` never fired on NULL, so a
--      branch-less user passed every branch check in pay_installment, settle_finance,
--      receive_transfer, partner_payment, pay_supplier, return_purchase_item, return_sale,
--      cancel_transfer, update_pending_expense, update_pending_finance_case,
--      cancel_pending_finance_case, mark_inventory_damaged and restore_damaged_inventory.
--   2. Any signed-in user could UPDATE their own profiles row, including branch_id, and
--      move themselves into another showroom.
--   3. The helper functions were executable by PUBLIC/anon and took an arbitrary _uid, so an
--      unauthenticated caller could map any user id to their roles and branch.
--   4. create_sale / create_transfer did not lock the inventory rows, so two tills could sell
--      or transfer the same IMEI at the same time.
--   5. create_sale trusted the client line price, so the discount-approval policy could be
--      bypassed by lowering a line price instead of using the discount box.
--   6. pay_installment collected money against cancelled installments (returned sales).
--   7. settle_finance(..., 0) violated transactions.amount CHECK (amount > 0).
--   8. Money columns had no CHECK constraints, hot columns had no indexes, and several
--      relationships had no ON DELETE clause.
--   9. apply_offline_op looked customers up by phone across every branch.
--  10. The "first user becomes super_admin" bootstrap was racy.
--  11. Manual income could be forged by anyone who could reach the transactions table.
--  12. The "hq manage items" policy let HQ edit stock status directly, bypassing the
--      security-definer stock workflow, and offline_ops rows could be rewritten wholesale.

-- ---------------------------------------------------------------------------
-- 1. Branch helpers must answer true/false, never NULL
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role app_role) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT coalesce(
    EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role), false)
$$;

CREATE OR REPLACE FUNCTION public.is_hq(_uid uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT coalesce(
    EXISTS (SELECT 1 FROM public.user_roles
            WHERE user_id = _uid AND role IN ('super_admin','dealer_admin','accountant','auditor')), false)
$$;

CREATE OR REPLACE FUNCTION public.can_write_hq(_uid uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT coalesce(
    EXISTS (SELECT 1 FROM public.user_roles
            WHERE user_id = _uid AND role IN ('super_admin','dealer_admin')), false)
$$;

CREATE OR REPLACE FUNCTION public.user_branch(_uid uuid) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT branch_id FROM public.profiles WHERE id = _uid
$$;

CREATE OR REPLACE FUNCTION public.can_access_branch(_uid uuid, _branch uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT coalesce(public.is_hq(_uid), false)
      OR (public.user_branch(_uid) IS NOT NULL AND public.user_branch(_uid) = _branch)
$$;

CREATE OR REPLACE FUNCTION public.can_operate_branch(_uid uuid, _branch uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT coalesce(public.can_write_hq(_uid), false)
      OR (
        public.user_branch(_uid) IS NOT NULL
        AND public.user_branch(_uid) = _branch
        AND EXISTS (SELECT 1 FROM public.user_roles
                    WHERE user_id = _uid AND role IN ('branch_manager','sales','accountant'))
      )
$$;

CREATE OR REPLACE FUNCTION public.can_approve_branch(_uid uuid, _branch uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT coalesce(public.can_write_hq(_uid), false)
      OR (
        public.user_branch(_uid) IS NOT NULL
        AND public.user_branch(_uid) = _branch
        AND public.has_role(_uid, 'branch_manager')
      )
$$;

REVOKE ALL ON FUNCTION public.has_role(uuid, app_role) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.is_hq(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.can_write_hq(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.user_branch(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.can_access_branch(uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.can_operate_branch(uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.can_approve_branch(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.has_role(uuid, app_role) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_hq(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_write_hq(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.user_branch(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_access_branch(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_operate_branch(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_approve_branch(uuid, uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- 2. A user may edit their own name/email/print language, never their branch
-- ---------------------------------------------------------------------------
REVOKE INSERT, UPDATE ON public.profiles FROM authenticated;
GRANT UPDATE (full_name, email, print_lang) ON public.profiles TO authenticated;

-- ---------------------------------------------------------------------------
-- 3. Stock state only changes through the security-definer workflow
-- ---------------------------------------------------------------------------
REVOKE INSERT, UPDATE ON public.inventory_items FROM authenticated;
GRANT SELECT, DELETE ON public.inventory_items TO authenticated;

-- Offline rows may only be marked resolved — never rewritten.
REVOKE UPDATE ON public.offline_ops FROM authenticated;
GRANT UPDATE (resolved, resolved_by) ON public.offline_ops TO authenticated;

-- Manual income rows go through add_manual_income() so the amount cannot be forged.
DROP POLICY IF EXISTS "insert income tx" ON public.transactions;
REVOKE INSERT ON public.transactions FROM authenticated;

CREATE OR REPLACE FUNCTION public.add_manual_income(_branch uuid, _category text, _amount numeric, _note text)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE t_id uuid;
BEGIN
  IF NOT public.can_operate_branch(auth.uid(), _branch) THEN RAISE EXCEPTION 'Not allowed for this branch'; END IF;
  IF NOT public.can_write_hq(auth.uid())
     AND NOT (public.user_branch(auth.uid()) = _branch
              AND public.has_role(auth.uid(), 'accountant')) THEN
    RAISE EXCEPTION 'Only an accountant, branch manager or admin can add an income entry';
  END IF;
  IF coalesce(trim(_category), '') = '' THEN RAISE EXCEPTION 'Category is required'; END IF;
  IF _amount IS NULL OR _amount <= 0 THEN RAISE EXCEPTION 'Amount must be greater than zero'; END IF;
  INSERT INTO public.transactions (branch_id, kind, category, amount, note, ref_id, created_by)
  VALUES (_branch, 'income', trim(_category), _amount, nullif(trim(_note), ''), NULL, auth.uid())
  RETURNING id INTO t_id;
  INSERT INTO public.audit_logs (user_id, action, details)
  VALUES (auth.uid(), 'add_manual_income', jsonb_build_object('transaction', t_id, 'branch', _branch, 'category', trim(_category), 'amount', _amount));
  RETURN t_id;
END;
$$;
REVOKE ALL ON FUNCTION public.add_manual_income(uuid, text, numeric, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.add_manual_income(uuid, text, numeric, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- 4. create_sale — lock stock, measure the discount against the catalogue price
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.create_sale(uuid, uuid, jsonb, numeric, numeric, text, text, int, text);
CREATE OR REPLACE FUNCTION public.create_sale(
  _branch uuid, _customer uuid, _items jsonb, _discount numeric, _paid numeric, _method text,
  _sale_type text, _months int, _discount_reason text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  s_id uuid; p_id uuid; sub numeric := 0; tot numeric; ids uuid[]; bad int; remaining numeric;
  monthly numeric; last_amt numeric; i int;
  cost numeric; maxpct numeric; approver uuid; needs boolean := false;
  list_sub numeric := 0; eff_discount numeric := 0;
BEGIN
  IF NOT public.can_operate_branch(auth.uid(), _branch) THEN RAISE EXCEPTION 'Not allowed for this branch'; END IF;

  SELECT array_agg(DISTINCT (e->>'item_id')::uuid), coalesce(sum((e->>'price')::numeric),0)
    INTO ids, sub FROM jsonb_array_elements(_items) e;
  IF ids IS NULL THEN RAISE EXCEPTION 'Cart is empty'; END IF;
  IF array_length(ids,1) <> (SELECT count(*) FROM jsonb_array_elements(_items)) THEN
    RAISE EXCEPTION 'The same item was added to the cart twice';
  END IF;

  -- Lock the stock rows (ordered, to avoid deadlocks) before checking their state.
  PERFORM 1 FROM public.inventory_items WHERE id = any(ids) ORDER BY id FOR UPDATE;
  SELECT count(*) INTO bad FROM public.inventory_items
    WHERE id = any(ids) AND (branch_id <> _branch OR status <> 'in_stock');
  IF bad > 0 THEN RAISE EXCEPTION 'Some items are not available in this branch'; END IF;

  IF _customer IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.customers WHERE id = _customer AND branch_id = _branch) THEN
    RAISE EXCEPTION 'Customer does not belong to this branch';
  END IF;

  IF coalesce(_discount,0) < 0 OR _discount > sub THEN RAISE EXCEPTION 'Invalid discount'; END IF;
  tot := sub - coalesce(_discount,0);
  IF tot <= 0 THEN RAISE EXCEPTION 'Sale total must be greater than zero'; END IF;

  -- The real discount is measured against the catalogue price, never against a client price.
  SELECT coalesce(sum(p.sale_price),0) INTO list_sub
    FROM public.inventory_items i JOIN public.products p ON p.id = i.product_id
    WHERE i.id = any(ids);
  eff_discount := greatest(list_sub - tot, 0);

  SELECT coalesce(sum(purchase_price),0) INTO cost FROM public.inventory_items WHERE id = any(ids);
  SELECT max_discount_pct INTO maxpct FROM public.branches WHERE id = _branch;

  needs := (eff_discount > round(list_sub * maxpct / 100, 2)) OR (tot < cost);
  IF (eff_discount > 0 OR tot < cost) AND coalesce(trim(_discount_reason), '') = '' THEN
    RAISE EXCEPTION 'A reason is required for this discount';
  END IF;
  IF needs AND NOT public.can_approve_branch(auth.uid(), _branch) THEN
    RAISE EXCEPTION 'Discount above % or below cost needs manager approval — ask a branch manager or admin to complete this sale', maxpct || '%';
  END IF;
  IF eff_discount > 0 OR tot < cost THEN approver := auth.uid(); END IF;

  IF _paid < 0 OR _paid > tot THEN RAISE EXCEPTION 'Invalid paid amount'; END IF;
  IF _sale_type = 'cash' AND _paid <> tot THEN RAISE EXCEPTION 'Cash sale must be fully paid'; END IF;
  IF _sale_type = 'installment' THEN
    IF _customer IS NULL THEN RAISE EXCEPTION 'Customer is required for installment'; END IF;
    IF _months IS NULL OR _months < 1 OR _months > 36 THEN RAISE EXCEPTION 'Months must be 1-36'; END IF;
    IF _paid >= tot THEN RAISE EXCEPTION 'Down payment must be less than total'; END IF;
  END IF;

  INSERT INTO public.sales (branch_id, customer_id, sale_type, subtotal, discount, total, paid,
                            payment_method, created_by, discount_reason, discount_approved_by)
  VALUES (_branch, _customer, _sale_type, tot + eff_discount, eff_discount, tot, _paid, _method,
          auth.uid(), nullif(trim(_discount_reason), ''), approver)
  RETURNING id INTO s_id;

  -- Store the EFFECTIVE price per line (the catalogue price minus the real
  -- discount), so the line items always add up to sales.total. The remainder
  -- from rounding is put on the last line so the sum is exact.
  WITH raw AS (
    SELECT (e->>'item_id')::uuid AS item_id,
           (e->>'price')::numeric AS price,
           row_number() OVER (ORDER BY (e->>'item_id')::uuid) AS rn
      FROM jsonb_array_elements(_items) e
  ), calc AS (
    SELECT item_id, rn, round(tot * price / NULLIF(sub, 0), 2) AS eff FROM raw
  ), fin AS (
    SELECT item_id, rn, eff, sum(eff) OVER (ORDER BY rn) AS running FROM calc
  )
  INSERT INTO public.sale_items (sale_id, item_id, price)
  SELECT s_id, item_id,
         CASE WHEN rn = (SELECT max(rn) FROM fin) THEN tot - (running - eff) ELSE eff END
    FROM fin;
  UPDATE public.inventory_items SET status = 'sold' WHERE id = any(ids);

  IF _paid > 0 THEN
    INSERT INTO public.transactions (branch_id, kind, category, amount, note, ref_id, created_by)
    VALUES (_branch, 'income', CASE WHEN _sale_type='installment' THEN 'Down payment' ELSE 'Sales' END,
            _paid, 'Invoice sale', s_id, auth.uid());
  END IF;

  IF _sale_type = 'installment' THEN
    remaining := tot - _paid;
    IF remaining <= 0 THEN RAISE EXCEPTION 'Nothing left to finance'; END IF;
    -- Round down so the schedule always adds up to the financed amount and never creates a
    -- zero-value or negative installment.
    monthly := trunc(remaining / _months, 2);
    IF monthly <= 0 THEN RAISE EXCEPTION 'Amount is too small to split into % installments', _months; END IF;
    last_amt := remaining - monthly * (_months - 1);
    INSERT INTO public.installment_plans (sale_id, branch_id, customer_id, financed_amount,
                                          down_payment, months, monthly_amount)
    VALUES (s_id, _branch, _customer, remaining, _paid, _months, monthly) RETURNING id INTO p_id;
    FOR i IN 1.._months LOOP
      INSERT INTO public.installments (plan_id, branch_id, seq, due_date, amount)
      VALUES (p_id, _branch, i, (current_date + (i || ' month')::interval)::date,
              CASE WHEN i = _months THEN last_amt ELSE monthly END);
    END LOOP;
  END IF;

  INSERT INTO public.audit_logs (user_id, action, details) VALUES (auth.uid(), 'create_sale',
    jsonb_build_object('sale', s_id, 'total', tot, 'catalogue_total', list_sub,
                        'discount', eff_discount, 'reason', _discount_reason, 'approved_by', approver));
  RETURN s_id;
END $$;

-- ---------------------------------------------------------------------------
-- 5. create_transfer — lock the stock rows
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_transfer(_from uuid, _to uuid, _item_ids uuid[], _note text) returns uuid
language plpgsql security definer set search_path = public as $$
declare t_id uuid; bad int;
begin
  if not public.can_operate_branch(auth.uid(), _from) then raise exception 'Not allowed for source branch'; end if;
  if _from = _to then raise exception 'Source and destination must differ'; end if;
  if coalesce(array_length(_item_ids,1),0) = 0 then raise exception 'No items selected'; end if;
  if array_length(_item_ids,1) <> (select count(distinct x) from unnest(_item_ids) x) then
    raise exception 'The same item was selected twice';
  end if;
  perform 1 from public.inventory_items where id = any(_item_ids) order by id for update;
  select count(*) into bad from public.inventory_items where id = any(_item_ids) and (branch_id <> _from or status <> 'in_stock');
  if bad > 0 then raise exception 'Some items are not in stock at source branch'; end if;
  insert into public.stock_transfers (from_branch_id, to_branch_id, note, created_by) values (_from, _to, _note, auth.uid()) returning id into t_id;
  insert into public.transfer_items (transfer_id, item_id) select t_id, unnest(_item_ids);
  update public.inventory_items set status = 'in_transit' where id = any(_item_ids);
  insert into public.audit_logs (user_id, action, details) values (auth.uid(), 'create_transfer', jsonb_build_object('transfer', t_id, 'count', array_length(_item_ids,1)));
  return t_id;
end $$;

-- ---------------------------------------------------------------------------
-- 6. pay_installment — never collect against a cancelled installment
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pay_installment(_inst uuid, _amount numeric) returns void
language plpgsql security definer set search_path = public as $$
declare r record; due numeric;
begin
  select * into r from public.installments where id = _inst for update;
  if r is null then raise exception 'Not found'; end if;
  if not public.can_operate_branch(auth.uid(), r.branch_id) then raise exception 'Not allowed'; end if;
  if r.cancelled then raise exception 'This installment belongs to a returned sale'; end if;
  if exists (select 1 from public.installment_plans p where p.id = r.plan_id and p.status = 'cancelled') then
    raise exception 'This installment plan was cancelled';
  end if;
  due := r.amount - r.paid_amount;
  if _amount <= 0 or _amount > due then raise exception 'Amount must be between 1 and %', due; end if;
  update public.installments set paid_amount = paid_amount + _amount, paid_at = case when paid_amount + _amount >= amount then now() else paid_at end where id = _inst;
  insert into public.transactions (branch_id, kind, category, amount, note, ref_id, created_by)
  values (r.branch_id, 'income', 'Installment', _amount, 'Installment #' || r.seq, r.plan_id, auth.uid());
  if not exists (select 1 from public.installments where plan_id = r.plan_id and paid_amount < amount) then
    update public.installment_plans set status = 'completed' where id = r.plan_id;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 7. settle_finance — a zero receipt must not break the CHECK (amount > 0)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.settle_finance(_case uuid, _received numeric)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare c public.finance_cases;
begin
  select * into c from public.finance_cases where id = _case for update;
  if c.id is null then raise exception 'Case not found'; end if;
  if not public.can_operate_branch(auth.uid(), c.branch_id) then raise exception 'Not allowed'; end if;
  if c.status <> 'pending' then raise exception 'Already settled'; end if;
  if _received < 0 or _received > c.amount then raise exception 'Invalid amount'; end if;
  update public.finance_cases set status = 'settled', settled_at = now(), commission = c.amount - _received where id = _case;
  if _received > 0 then
    insert into public.transactions(branch_id, kind, category, amount, note, ref_id, created_by)
    values (c.branch_id, 'income', 'finance_settlement', _received, coalesce(c.ref_no, '') || ' ' || c.customer_name, c.id, auth.uid());
    insert into public.finance_partner_ledger(partner_id, branch_id, kind, amount, note, case_id, created_by)
    values (c.partner_id, c.branch_id, 'received', _received, 'Settlement ' || coalesce(c.ref_no,''), c.id, auth.uid());
  end if;
end $function$;

-- ---------------------------------------------------------------------------
-- 8. return_sale — also cancel the plan itself
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.return_sale(_sale uuid, _reason text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE s public.sales; refund numeric;
BEGIN
  SELECT * INTO s FROM public.sales WHERE id = _sale FOR UPDATE;
  IF s.id IS NULL THEN RAISE EXCEPTION 'Sale not found'; END IF;
  IF s.status = 'returned' THEN RAISE EXCEPTION 'Sale already returned'; END IF;
  IF NOT public.can_approve_branch(auth.uid(), s.branch_id) THEN RAISE EXCEPTION 'Only a branch manager or admin can return a sale'; END IF;
  IF coalesce(trim(_reason),'') = '' THEN RAISE EXCEPTION 'Reason is required'; END IF;
  SELECT s.paid + coalesce((SELECT sum(i.paid_amount) FROM public.installments i JOIN public.installment_plans p ON p.id = i.plan_id WHERE p.sale_id = _sale),0) INTO refund;
  UPDATE public.inventory_items SET status = 'in_stock', branch_id = s.branch_id WHERE id IN (SELECT item_id FROM public.sale_items WHERE sale_id = _sale);
  UPDATE public.sales SET status = 'returned', returned_at = now(), return_reason = _reason WHERE id = _sale;
  UPDATE public.installments SET cancelled = true WHERE plan_id IN (SELECT id FROM public.installment_plans WHERE sale_id = _sale) AND paid_amount < amount;
  UPDATE public.installment_plans SET status = 'cancelled' WHERE sale_id = _sale AND status = 'active';
  IF refund > 0 THEN
    INSERT INTO public.transactions (branch_id, kind, category, amount, note, ref_id, created_by)
    VALUES (s.branch_id, 'expense', 'Sale refund', refund, _reason, _sale, auth.uid());
  END IF;
  INSERT INTO public.audit_logs (user_id, action, details) VALUES (auth.uid(), 'return_sale', jsonb_build_object('sale', _sale, 'refund', refund, 'reason', _reason));
END $$;

-- ---------------------------------------------------------------------------
-- 9. apply_offline_op — branch-scoped customer lookup, idempotent on a race
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.apply_offline_op(_client_ref uuid, _kind text, _payload jsonb, _queued_at timestamptz, _device text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE prev public.offline_ops; res jsonb; br uuid; cust uuid; sale_id uuid; st text;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not signed in'; END IF;
  SELECT * INTO prev FROM public.offline_ops WHERE client_ref = _client_ref;
  IF FOUND THEN
    RETURN jsonb_build_object('status', prev.status, 'result', prev.result, 'error', prev.error);
  END IF;
  br := nullif(_payload->>'branch','')::uuid;
  BEGIN
    IF _kind = 'sale' THEN
      cust := nullif(_payload->>'customer','')::uuid;
      IF cust IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.customers WHERE id = cust AND branch_id = br) THEN
        cust := NULL;
      END IF;
      IF cust IS NULL AND coalesce(_payload->>'phone','') <> '' THEN
        IF NOT public.can_operate_branch(auth.uid(), br) THEN RAISE EXCEPTION 'Not allowed for this branch'; END IF;
        SELECT id INTO cust FROM public.customers WHERE phone = _payload->>'phone' AND branch_id = br ORDER BY created_at LIMIT 1;
        IF cust IS NULL THEN
          INSERT INTO public.customers(branch_id, name, phone, nid)
          VALUES (br, coalesce(nullif(_payload->>'cust_name',''), _payload->>'phone'), _payload->>'phone', nullif(_payload->>'nid',''))
          RETURNING id INTO cust;
        END IF;
      END IF;
      sale_id := public.create_sale(br, cust, _payload->'items', coalesce((_payload->>'discount')::numeric,0),
        coalesce((_payload->>'paid')::numeric,0), _payload->>'method', _payload->>'sale_type',
        nullif(_payload->>'months','')::int, nullif(_payload->>'discount_reason',''));
      res := jsonb_build_object('sale_id', sale_id);
    ELSIF _kind = 'kisti' THEN
      SELECT branch_id INTO br FROM public.installments WHERE id = (_payload->>'inst')::uuid;
      PERFORM public.pay_installment((_payload->>'inst')::uuid, (_payload->>'amount')::numeric);
      res := '{}'::jsonb;
    ELSIF _kind = 'expense' THEN
      st := public.submit_expense(br, _payload->>'category', (_payload->>'amount')::numeric, (_payload->>'date')::date,
        _payload->>'method', coalesce(_payload->>'note',''), coalesce(_payload->>'attachment',''));
      res := jsonb_build_object('expense_status', st);
    ELSE
      RAISE EXCEPTION 'Unknown offline action';
    END IF;
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO public.offline_ops(client_ref, branch_id, kind, payload, device, queued_at, status, error)
    VALUES (_client_ref, br, _kind, _payload, _device, _queued_at, 'conflict', SQLERRM);
    INSERT INTO public.audit_logs(user_id, action, details)
    VALUES (auth.uid(), 'offline_conflict', jsonb_build_object('kind', _kind, 'error', SQLERRM, 'queued_at', _queued_at, 'device', _device));
    RETURN jsonb_build_object('status', 'conflict', 'error', SQLERRM);
  END;
  BEGIN
    INSERT INTO public.offline_ops(client_ref, branch_id, kind, payload, device, queued_at, status, result)
    VALUES (_client_ref, br, _kind, _payload, _device, _queued_at, 'applied', res);
  EXCEPTION WHEN unique_violation THEN
    -- Another device applied the same entry first — report what it did instead of failing.
    SELECT * INTO prev FROM public.offline_ops WHERE client_ref = _client_ref;
    RETURN jsonb_build_object('status', prev.status, 'result', prev.result, 'error', prev.error);
  END;
  RETURN jsonb_build_object('status', 'applied', 'result', res);
END $$;

-- ---------------------------------------------------------------------------
-- 10. The "first signup becomes super_admin" bootstrap must not race
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, full_name, email)
  values (new.id, coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email,'@',1)), new.email);
  perform pg_advisory_xact_lock(hashtext('dealer_erp_bootstrap_admin'));
  if not exists (select 1 from public.user_roles where role = 'super_admin') then
    insert into public.user_roles (user_id, role) values (new.id, 'super_admin');
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- 11. Money columns must hold sane values
-- ---------------------------------------------------------------------------
DO $$
DECLARE t record;
BEGIN
  FOR t IN
    SELECT * FROM (VALUES
      ('public.finance_cases',     'chk_finance_cases_amount',     'amount > 0'),
      ('public.finance_cases',     'chk_finance_cases_commission', 'commission >= 0'),
      ('public.finance_partners',  'chk_finance_partners_comm',    'commission_pct >= 0 AND commission_pct <= 100'),
      ('public.purchases',         'chk_purchases_total',          'total >= 0'),
      ('public.purchases',         'chk_purchases_returned',       'returned >= 0'),
      ('public.purchases',         'chk_purchases_paid',           'paid >= 0'),
      ('public.purchase_items',    'chk_purchase_items_cost',      'cost >= 0'),
      ('public.branches',          'chk_branches_max_discount',    'max_discount_pct >= 0 AND max_discount_pct <= 100'),
      ('public.branches',          'chk_branches_expense_limit',   'expense_limit >= 0'),
      ('public.products',          'chk_products_prices',          'purchase_price >= 0 AND sale_price >= 0'),
      ('public.sales',             'chk_sales_amounts',            'subtotal >= 0 AND discount >= 0 AND total >= 0 AND paid >= 0'),
      ('public.installment_plans', 'chk_installment_plans',        'financed_amount > 0 AND down_payment >= 0 AND months >= 1 AND months <= 36 AND monthly_amount > 0'),
      ('public.installments',      'chk_installments',             'amount > 0 AND paid_amount >= 0'),
      ('public.employees',         'chk_employees_salary',         'salary >= 0')
    ) AS v(tbl, cname, expr)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = t.cname) THEN
      EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I CHECK (%s) NOT VALID', t.tbl, t.cname, t.expr);
    END IF;
  END LOOP;
END $$;

ALTER TABLE public.installment_plans DROP CONSTRAINT IF EXISTS installment_plans_status_check;
ALTER TABLE public.installment_plans ADD CONSTRAINT installment_plans_status_check
  CHECK (status IN ('active','completed','cancelled'));

-- ---------------------------------------------------------------------------
-- 12. Relationships that must not block a legitimate delete
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sales_customer_id_fkey') THEN
    ALTER TABLE public.sales DROP CONSTRAINT IF EXISTS sales_customer_id_fkey;
    ALTER TABLE public.sales ADD CONSTRAINT sales_customer_id_fkey
      FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'finance_cases_sale_id_fkey') THEN
    ALTER TABLE public.finance_cases DROP CONSTRAINT IF EXISTS finance_cases_sale_id_fkey;
    ALTER TABLE public.finance_cases ADD CONSTRAINT finance_cases_sale_id_fkey
      FOREIGN KEY (sale_id) REFERENCES public.sales(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'finance_partner_ledger_case_id_fkey') THEN
    ALTER TABLE public.finance_partner_ledger DROP CONSTRAINT IF EXISTS finance_partner_ledger_case_id_fkey;
    ALTER TABLE public.finance_partner_ledger ADD CONSTRAINT finance_partner_ledger_case_id_fkey
      FOREIGN KEY (case_id) REFERENCES public.finance_cases(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'installment_plans_customer_id_fkey') THEN
    ALTER TABLE public.installment_plans DROP CONSTRAINT IF EXISTS installment_plans_customer_id_fkey;
    ALTER TABLE public.installment_plans DROP CONSTRAINT IF EXISTS installment_plans_customer_id_not_null;
    ALTER TABLE public.installment_plans ALTER COLUMN customer_id DROP NOT NULL;
    ALTER TABLE public.installment_plans ADD CONSTRAINT installment_plans_customer_id_fkey
      FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE SET NULL;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 13. Duplicates must be impossible
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sale_items_sale_item_key') THEN
    ALTER TABLE public.sale_items DROP CONSTRAINT IF EXISTS sale_items_sale_id_item_id_key;
    ALTER TABLE public.sale_items ADD CONSTRAINT sale_items_sale_item_key UNIQUE (sale_id, item_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'transfer_items_transfer_item_key') THEN
    ALTER TABLE public.transfer_items DROP CONSTRAINT IF EXISTS transfer_items_transfer_id_item_id_key;
    ALTER TABLE public.transfer_items ADD CONSTRAINT transfer_items_transfer_item_key UNIQUE (transfer_id, item_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'installments_plan_seq_key') THEN
    ALTER TABLE public.installments DROP CONSTRAINT IF EXISTS installments_plan_id_seq_key;
    ALTER TABLE public.installments ADD CONSTRAINT installments_plan_seq_key UNIQUE (plan_id, seq);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'customers_branch_phone_key') THEN
    IF NOT EXISTS (SELECT 1 FROM public.customers GROUP BY branch_id, phone HAVING count(*) > 1) THEN
      ALTER TABLE public.customers ADD CONSTRAINT customers_branch_phone_key UNIQUE (branch_id, phone);
    END IF;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'purchases_supplier_invoice_key') THEN
    IF NOT EXISTS (SELECT 1 FROM public.purchases GROUP BY branch_id, supplier_id, supplier_invoice HAVING count(*) > 1) THEN
      ALTER TABLE public.purchases ADD CONSTRAINT purchases_supplier_invoice_key
        UNIQUE (branch_id, supplier_id, supplier_invoice);
    END IF;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'purchases_seq_no_key') THEN
    ALTER TABLE public.purchases ADD CONSTRAINT purchases_seq_no_key UNIQUE (seq_no);
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 14. Indexes for the columns every list screen filters on
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_inventory_items_branch ON public.inventory_items (branch_id);
CREATE INDEX IF NOT EXISTS idx_inventory_items_branch_status ON public.inventory_items (branch_id, status);
CREATE INDEX IF NOT EXISTS idx_inventory_items_product ON public.inventory_items (product_id);
CREATE INDEX IF NOT EXISTS idx_sales_branch ON public.sales (branch_id);
CREATE INDEX IF NOT EXISTS idx_sales_branch_created ON public.sales (branch_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sales_customer ON public.sales (customer_id);
CREATE INDEX IF NOT EXISTS idx_sale_items_sale ON public.sale_items (sale_id);
CREATE INDEX IF NOT EXISTS idx_sale_items_item ON public.sale_items (item_id);
CREATE INDEX IF NOT EXISTS idx_customers_branch ON public.customers (branch_id);
CREATE INDEX IF NOT EXISTS idx_customers_phone ON public.customers (phone);
CREATE INDEX IF NOT EXISTS idx_customers_branch_phone ON public.customers (branch_id, phone);
CREATE INDEX IF NOT EXISTS idx_installment_plans_branch ON public.installment_plans (branch_id);
CREATE INDEX IF NOT EXISTS idx_installment_plans_sale ON public.installment_plans (sale_id);
CREATE INDEX IF NOT EXISTS idx_installment_plans_customer ON public.installment_plans (customer_id);
CREATE INDEX IF NOT EXISTS idx_installments_branch ON public.installments (branch_id);
CREATE INDEX IF NOT EXISTS idx_installments_plan ON public.installments (plan_id);
CREATE INDEX IF NOT EXISTS idx_installments_due ON public.installments (branch_id, due_date);
CREATE INDEX IF NOT EXISTS idx_transactions_branch ON public.transactions (branch_id);
CREATE INDEX IF NOT EXISTS idx_transactions_ref ON public.transactions (ref_id);
CREATE INDEX IF NOT EXISTS idx_transactions_created ON public.transactions (branch_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stock_transfers_from ON public.stock_transfers (from_branch_id);
CREATE INDEX IF NOT EXISTS idx_stock_transfers_to ON public.stock_transfers (to_branch_id);
CREATE INDEX IF NOT EXISTS idx_transfer_items_transfer ON public.transfer_items (transfer_id);
CREATE INDEX IF NOT EXISTS idx_transfer_items_item ON public.transfer_items (item_id);
CREATE INDEX IF NOT EXISTS idx_purchases_branch ON public.purchases (branch_id);
CREATE INDEX IF NOT EXISTS idx_purchases_supplier ON public.purchases (supplier_id);
CREATE INDEX IF NOT EXISTS idx_purchase_items_purchase ON public.purchase_items (purchase_id);
CREATE INDEX IF NOT EXISTS idx_purchase_items_item ON public.purchase_items (item_id);
CREATE INDEX IF NOT EXISTS idx_purchase_payments_purchase ON public.purchase_payments (purchase_id);
CREATE INDEX IF NOT EXISTS idx_expenses_branch ON public.expenses (branch_id);
CREATE INDEX IF NOT EXISTS idx_expenses_status ON public.expenses (status);
CREATE INDEX IF NOT EXISTS idx_expenses_date ON public.expenses (branch_id, expense_date);
CREATE INDEX IF NOT EXISTS idx_finance_cases_branch ON public.finance_cases (branch_id);
CREATE INDEX IF NOT EXISTS idx_finance_cases_partner ON public.finance_cases (partner_id);
CREATE INDEX IF NOT EXISTS idx_finance_cases_status ON public.finance_cases (status);
CREATE INDEX IF NOT EXISTS idx_finance_partner_ledger_branch ON public.finance_partner_ledger (branch_id);
CREATE INDEX IF NOT EXISTS idx_finance_partner_ledger_partner ON public.finance_partner_ledger (partner_id);
CREATE INDEX IF NOT EXISTS idx_finance_partner_ledger_case ON public.finance_partner_ledger (case_id);
CREATE INDEX IF NOT EXISTS idx_employees_branch ON public.employees (branch_id);
CREATE INDEX IF NOT EXISTS idx_attendance_branch ON public.attendance (branch_id);
CREATE INDEX IF NOT EXISTS idx_attendance_day ON public.attendance (day);
CREATE INDEX IF NOT EXISTS idx_offline_ops_branch ON public.offline_ops (branch_id);
CREATE INDEX IF NOT EXISTS idx_offline_ops_user ON public.offline_ops (user_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_user ON public.audit_logs (user_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON public.audit_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_profiles_branch ON public.profiles (branch_id);
CREATE INDEX IF NOT EXISTS idx_user_roles_user ON public.user_roles (user_id);
CREATE INDEX IF NOT EXISTS idx_user_roles_role ON public.user_roles (role);

-- ---------------------------------------------------------------------------
-- 15. Sequences stay out of reach of the client
-- ---------------------------------------------------------------------------
REVOKE ALL ON SEQUENCE public.sales_seq_no_seq FROM PUBLIC, anon;
REVOKE ALL ON SEQUENCE public.purchases_seq_no_seq FROM PUBLIC, anon;
GRANT USAGE, SELECT ON SEQUENCE public.sales_seq_no_seq TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.purchases_seq_no_seq TO service_role;

-- ---------------------------------------------------------------------------
-- 16. Only signed-in users may call the workflow functions
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.create_sale(uuid, uuid, jsonb, numeric, numeric, text, text, int, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.create_transfer(uuid, uuid, uuid[], text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.receive_transfer(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.pay_installment(uuid, numeric) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.settle_finance(uuid, numeric) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.create_purchase(uuid, uuid, text, jsonb, numeric, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.pay_supplier(uuid, numeric, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.return_purchase_item(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.submit_expense(uuid, text, numeric, date, text, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.decide_expense(uuid, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.return_sale(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.partner_payment(uuid, uuid, text, numeric, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_set_user(uuid, app_role, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.audit_branch_change() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.create_sale(uuid, uuid, jsonb, numeric, numeric, text, text, int, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_transfer(uuid, uuid, uuid[], text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.receive_transfer(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pay_installment(uuid, numeric) TO authenticated;
GRANT EXECUTE ON FUNCTION public.settle_finance(uuid, numeric) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_purchase(uuid, uuid, text, jsonb, numeric, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pay_supplier(uuid, numeric, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.return_purchase_item(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.submit_expense(uuid, text, numeric, date, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.decide_expense(uuid, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.return_sale(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.partner_payment(uuid, uuid, text, numeric, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_set_user(uuid, app_role, uuid) TO authenticated;
