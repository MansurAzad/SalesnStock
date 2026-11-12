-- 0030 — third-party partner-financed POS sales
-- Block new showroom-owned customer installment plans. The partner-financed
-- sale RPC temporarily sets a transaction-local flag while reusing create_sale.
CREATE OR REPLACE FUNCTION public.guard_partner_financed_installment_plan()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $
BEGIN
  IF current_setting('app.partner_financing_workflow', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'Customer installment plans are disabled; use a financial partner sale';
  END IF;
  RETURN NEW;
END;
$;

DROP TRIGGER IF EXISTS trg_guard_partner_financed_installment_plan ON public.installment_plans;
CREATE TRIGGER trg_guard_partner_financed_installment_plan
BEFORE INSERT ON public.installment_plans
FOR EACH ROW EXECUTE FUNCTION public.guard_partner_financed_installment_plan();

REVOKE ALL ON FUNCTION public.guard_partner_financed_installment_plan() FROM PUBLIC, anon, authenticated;

-- The dealer receives only the discounted down payment from the customer.
-- The financing partner owes the original sale balance (sale subtotal minus
-- the pre-discount down payment). No customer installment schedule is created.

ALTER TABLE public.finance_cases
  ADD COLUMN IF NOT EXISTS payer_name text;

CREATE OR REPLACE FUNCTION public.create_partner_financed_sale(
  _branch uuid,
  _customer uuid,
  _items jsonb,
  _down_payment numeric,
  _down_payment_discount numeric,
  _method text,
  _partner uuid,
  _payer_name text DEFAULT NULL,
  _ref text DEFAULT NULL,
  _discount_reason text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_subtotal numeric := 0;
  v_partner_receivable numeric := 0;
  v_max_discount_pct numeric := 0;
  v_sale uuid;
  v_partner_name text;
BEGIN
  IF NOT public.can_operate_branch(auth.uid(), _branch) THEN
    RAISE EXCEPTION 'Not allowed for this branch';
  END IF;

  IF _customer IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.customers WHERE id = _customer AND branch_id = _branch
  ) THEN
    RAISE EXCEPTION 'A valid customer from this branch is required';
  END IF;

  SELECT name INTO v_partner_name
  FROM public.finance_partners
  WHERE id = _partner AND active = true;
  IF v_partner_name IS NULL THEN
    RAISE EXCEPTION 'Select an active financial partner';
  END IF;

  SELECT coalesce(sum((e->>'price')::numeric), 0)
  INTO v_subtotal
  FROM jsonb_array_elements(_items) e;

  IF v_subtotal <= 0 THEN RAISE EXCEPTION 'Sale total must be greater than zero'; END IF;
  IF _down_payment IS NULL OR _down_payment <= 0 OR _down_payment >= v_subtotal THEN
    RAISE EXCEPTION 'Down payment must be greater than zero and less than the sale subtotal';
  END IF;
  IF coalesce(_down_payment_discount, 0) < 0
     OR coalesce(_down_payment_discount, 0) > _down_payment THEN
    RAISE EXCEPTION 'Down payment discount cannot exceed the down payment';
  END IF;

  v_partner_receivable := v_subtotal - _down_payment;
  IF v_partner_receivable <= 0 THEN RAISE EXCEPTION 'Partner receivable must be positive'; END IF;

  SELECT coalesce(max_discount_pct, 0)
  INTO v_max_discount_pct
  FROM public.branches
  WHERE id = _branch;

  IF coalesce(_down_payment_discount, 0) > 0 THEN
    IF coalesce(trim(_discount_reason), '') = '' THEN
      RAISE EXCEPTION 'A reason is required for the down payment discount';
    END IF;
    IF _down_payment_discount > round(_down_payment * v_max_discount_pct / 100, 2)
       AND NOT public.can_approve_branch(auth.uid(), _branch) THEN
      RAISE EXCEPTION 'Down payment discount exceeds the branch limit of % and needs manager approval',
        v_max_discount_pct || '%';
    END IF;
  END IF;

  -- Reuse the established atomic sale/stock/discount/ledger workflow. The
  -- temporary one-month plan is removed inside this transaction immediately;
  -- the partner receivable is recorded instead.
  PERFORM set_config('app.partner_financing_workflow', 'on', true);
  v_sale := public.create_sale(
    _branch,
    _customer,
    _items,
    coalesce(_down_payment_discount, 0),
    _down_payment - coalesce(_down_payment_discount, 0),
    coalesce(nullif(trim(_method), ''), 'cash'),
    'installment',
    1,
    _discount_reason
  );
  PERFORM set_config('app.partner_financing_workflow', 'off', true);

  DELETE FROM public.installments
  WHERE plan_id IN (SELECT id FROM public.installment_plans WHERE sale_id = v_sale);
  DELETE FROM public.installment_plans WHERE sale_id = v_sale;

  INSERT INTO public.finance_cases (
    branch_id, partner_id, sale_id, customer_name, customer_phone,
    ref_no, amount, commission, status, note, payer_name, created_by
  )
  SELECT
    _branch, _partner, v_sale, c.name, c.phone,
    nullif(trim(_ref), ''), v_partner_receivable, 0, 'pending',
    'Automatically created from partner-financed POS sale',
    nullif(trim(_payer_name), ''), auth.uid()
  FROM public.customers c
  WHERE c.id = _customer;

  INSERT INTO public.audit_logs(user_id, action, details)
  VALUES (
    auth.uid(),
    'create_partner_financed_sale',
    jsonb_build_object(
      'sale', v_sale,
      'partner', _partner,
      'subtotal', v_subtotal,
      'down_payment_before_discount', _down_payment,
      'down_payment_discount', coalesce(_down_payment_discount, 0),
      'customer_down_payment_received', _down_payment - coalesce(_down_payment_discount, 0),
      'partner_receivable', v_partner_receivable,
      'payer_name', nullif(trim(_payer_name), '')
    )
  );

  RETURN v_sale;
END;
$$;

REVOKE ALL ON FUNCTION public.create_partner_financed_sale(uuid, uuid, jsonb, numeric, numeric, text, uuid, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_partner_financed_sale(uuid, uuid, jsonb, numeric, numeric, text, uuid, text, text, text) TO authenticated;

-- This business model never sends money to a financing partner.
CREATE OR REPLACE FUNCTION public.partner_payment(
  _partner uuid, _branch uuid, _kind text, _amount numeric, _method text, _note text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.can_operate_branch(auth.uid(), _branch) THEN
    RAISE EXCEPTION 'Not allowed for this branch';
  END IF;
  IF _kind <> 'received' THEN
    RAISE EXCEPTION 'Outgoing payments to financial partners are disabled for this business model';
  END IF;
  IF _amount IS NULL OR _amount <= 0 THEN RAISE EXCEPTION 'Amount must be positive'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.finance_partners WHERE id = _partner) THEN
    RAISE EXCEPTION 'Partner not found';
  END IF;

  INSERT INTO public.finance_partner_ledger(partner_id, branch_id, kind, amount, method, note, created_by)
  VALUES (_partner, _branch, 'received', _amount, coalesce(_method, 'bank'), _note, auth.uid());

  INSERT INTO public.transactions(branch_id, kind, category, amount, note, ref_id, method, created_by)
  SELECT _branch, 'income', 'Finance partner receipt', _amount,
         p.name || coalesce(' — ' || nullif(_note, ''), ''),
         _partner, coalesce(_method, 'bank'), auth.uid()
  FROM public.finance_partners p WHERE p.id = _partner;

  INSERT INTO public.audit_logs(user_id, action, details)
  VALUES (auth.uid(), 'partner_received', jsonb_build_object(
    'partner', _partner, 'branch', _branch, 'amount', _amount
  ));
END;
$$;

REVOKE ALL ON FUNCTION public.partner_payment(uuid, uuid, text, numeric, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.partner_payment(uuid, uuid, text, numeric, text, text) TO authenticated;


-- A normal settlement must clear the full receivable. Do not silently classify
-- an unexplained short payment as partner commission or as a completed case.
CREATE OR REPLACE FUNCTION public.settle_finance(_case uuid, _received numeric, _method text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  c public.finance_cases;
  m text;
BEGIN
  SELECT * INTO c FROM public.finance_cases WHERE id = _case FOR UPDATE;
  IF c.id IS NULL THEN RAISE EXCEPTION 'Finance case not found'; END IF;
  IF NOT public.can_operate_branch(auth.uid(), c.branch_id) THEN
    RAISE EXCEPTION 'Not allowed for this branch';
  END IF;
  IF c.status <> 'pending' THEN RAISE EXCEPTION 'Finance case is not pending'; END IF;
  IF _received IS NULL OR _received <= 0 OR _received <> c.amount THEN
    RAISE EXCEPTION 'Settlement must equal the full partner receivable of %', c.amount;
  END IF;

  m := coalesce(nullif(trim(_method), ''), 'bank');
  IF m NOT IN ('cash','bank','bkash','nagad','rocket','card','cheque','online') THEN
    RAISE EXCEPTION 'Unknown payment method %', m;
  END IF;

  UPDATE public.finance_cases
  SET status = 'settled', settled_at = now(), commission = 0
  WHERE id = _case;

  INSERT INTO public.transactions(branch_id, kind, category, amount, note, ref_id, method, created_by)
  VALUES (c.branch_id, 'income', 'finance_settlement', _received,
          coalesce(c.ref_no, '') || ' ' || c.customer_name, c.id, m, auth.uid());

  INSERT INTO public.finance_partner_ledger(partner_id, branch_id, kind, amount, method, note, case_id, created_by)
  VALUES (c.partner_id, c.branch_id, 'received', _received, m,
          'Full settlement ' || coalesce(c.ref_no, ''), c.id, auth.uid());

  INSERT INTO public.audit_logs(user_id, action, details)
  VALUES (auth.uid(), 'settle_finance', jsonb_build_object(
    'case', _case, 'partner', c.partner_id, 'amount', _received, 'method', m
  ));
END;
$$;

REVOKE ALL ON FUNCTION public.settle_finance(uuid, numeric, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.settle_finance(uuid, numeric, text) TO authenticated;

-- The showroom no longer collects customer installments. Keep historical rows
-- for audit, but prevent direct authenticated calls to the legacy collection RPC.
REVOKE ALL ON FUNCTION public.pay_installment(uuid, numeric) FROM authenticated;
REVOKE ALL ON FUNCTION public.pay_installment(uuid, numeric, text) FROM authenticated;
