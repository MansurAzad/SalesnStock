-- 0019 — feature additions that tie the modules together
--
-- Gaps found in the full functional audit:
--   1. transactions had no payment method, so the cash book could not separate
--      cash / bank / bkash / nagad and every balance was one lump sum.
--   2. products had no reorder level, so there was no low-stock warning.
--   3. customers had no notes, so the customer page had nothing to show.
--   4. finance cases were INSERTed straight from the browser: no audit trail and
--      no link to the POS invoice the case refers to.
--   5. Employees had attendance but no payroll, so the salary never reached
--      the cash book.
--   6. A finance case could be settled for an amount that never reached the
--      partner ledger.

-- ---------------------------------------------------------------------------
-- 1. Payment method on every money movement
-- ---------------------------------------------------------------------------
ALTER TABLE public.transactions ADD COLUMN IF NOT EXISTS method text NOT NULL DEFAULT 'cash';
ALTER TABLE public.transactions DROP CONSTRAINT IF EXISTS transactions_method_check;
ALTER TABLE public.transactions ADD CONSTRAINT transactions_method_check
  CHECK (method IN ('cash','bank','bkash','nagad','cheque','online'));
CREATE INDEX IF NOT EXISTS idx_transactions_method ON public.transactions (method);

-- Existing rows inherit the method of the document they came from.
UPDATE public.transactions t SET method = e.method
  FROM public.expenses e
 WHERE t.ref_id = e.id AND t.method = 'cash' AND e.method IS NOT NULL;

UPDATE public.transactions t SET method = pp.method
  FROM public.purchase_payments pp
 WHERE t.ref_id = pp.purchase_id AND t.method = 'cash'
   AND EXISTS (SELECT 1 FROM public.purchase_payments q WHERE q.purchase_id = pp.purchase_id AND q.id = pp.id)
   AND NOT EXISTS (
     SELECT 1 FROM public.purchase_payments q2
      WHERE q2.purchase_id = pp.purchase_id AND q2.created_at > pp.created_at);

UPDATE public.transactions t SET method = s.payment_method
  FROM public.sales s
 WHERE t.ref_id = s.id AND t.method = 'cash' AND s.payment_method IS NOT NULL;

-- Every transaction inserted from now on picks up its method from the source
-- document, so no money path can silently land in the wrong cash box.
CREATE OR REPLACE FUNCTION public.transactions_fill_method() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE m text;
BEGIN
  IF NEW.ref_id IS NOT NULL THEN
    SELECT payment_method INTO m FROM public.sales WHERE id = NEW.ref_id;
    IF m IS NULL THEN SELECT method INTO m FROM public.expenses WHERE id = NEW.ref_id; END IF;
    IF m IS NULL THEN
      SELECT method INTO m FROM public.purchase_payments
       WHERE purchase_id = NEW.ref_id ORDER BY created_at DESC LIMIT 1;
    END IF;
    IF m IS NOT NULL AND m <> 'cash' THEN NEW.method := m; END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS tr_transactions_fill_method ON public.transactions;
CREATE TRIGGER tr_transactions_fill_method
  BEFORE INSERT ON public.transactions
  FOR EACH ROW EXECUTE FUNCTION public.transactions_fill_method();

-- Manual income keeps its 4-argument signature and gains a 5-argument one.
CREATE OR REPLACE FUNCTION public.add_manual_income(_branch uuid, _category text, _amount numeric, _note text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN public.add_manual_income(_branch, _category, _amount, _note, 'cash');
END $$;

CREATE OR REPLACE FUNCTION public.add_manual_income(_branch uuid, _category text, _amount numeric, _note text, _method text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE tx_id uuid;
BEGIN
  IF NOT public.can_operate_branch(auth.uid(), _branch) THEN RAISE EXCEPTION 'Not allowed for this branch'; END IF;
  IF NOT public.can_write_hq(auth.uid())
     AND NOT (public.user_branch(auth.uid()) = _branch
              AND public.has_role(auth.uid(), 'accountant')) THEN
    RAISE EXCEPTION 'Only an accountant, branch manager or admin can add an income entry';
  END IF;
  IF coalesce(trim(_category),'') = '' THEN RAISE EXCEPTION 'Category is required'; END IF;
  IF _amount IS NULL OR _amount <= 0 THEN RAISE EXCEPTION 'Amount must be positive'; END IF;
  INSERT INTO public.transactions (branch_id, kind, category, amount, note, ref_id, method, created_by)
  VALUES (_branch, 'income', trim(_category), _amount, nullif(trim(_note),''), NULL, coalesce(_method,'cash'), auth.uid())
  RETURNING id INTO tx_id;
  INSERT INTO public.audit_logs (user_id, action, details)
    VALUES (auth.uid(), 'add_manual_income', jsonb_build_object('transaction', tx_id, 'branch', _branch, 'amount', _amount, 'method', coalesce(_method,'cash')));
  RETURN tx_id;
END $$;

REVOKE ALL ON FUNCTION public.add_manual_income(uuid, text, numeric, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.add_manual_income(uuid, text, numeric, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.add_manual_income(uuid, text, numeric, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.add_manual_income(uuid, text, numeric, text, text) TO authenticated;

-- Kisti collection keeps its 2-argument signature and gains a 3-argument one.
CREATE OR REPLACE FUNCTION public.pay_installment(_inst uuid, _amount numeric)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public.pay_installment(_inst, _amount, 'cash');
END $$;

CREATE OR REPLACE FUNCTION public.pay_installment(_inst uuid, _amount numeric, _method text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r record; due numeric;
BEGIN
  SELECT * INTO r FROM public.installments WHERE id = _inst FOR UPDATE;
  IF r IS NULL THEN RAISE EXCEPTION 'Not found'; END IF;
  IF NOT public.can_operate_branch(auth.uid(), r.branch_id) THEN RAISE EXCEPTION 'Not allowed'; END IF;
  IF r.cancelled THEN RAISE EXCEPTION 'This installment belongs to a returned sale'; END IF;
  IF EXISTS (SELECT 1 FROM public.installment_plans p WHERE p.id = r.plan_id AND p.status = 'cancelled') THEN
    RAISE EXCEPTION 'This installment plan was cancelled';
  END IF;
  due := r.amount - r.paid_amount;
  IF _amount IS NULL OR _amount <= 0 OR _amount > due THEN
    RAISE EXCEPTION 'Amount must be between 1 and %', due;
  END IF;
  UPDATE public.installments SET paid_amount = paid_amount + _amount,
         paid_at = CASE WHEN paid_amount + _amount >= amount THEN now() ELSE paid_at END
    WHERE id = _inst;
  INSERT INTO public.transactions (branch_id, kind, category, amount, note, ref_id, method, created_by)
  VALUES (r.branch_id, 'income', 'Installment', _amount, 'Installment #' || r.seq, r.plan_id, coalesce(_method,'cash'), auth.uid());
  IF NOT EXISTS (SELECT 1 FROM public.installments WHERE plan_id = r.plan_id AND paid_amount < amount) THEN
    UPDATE public.installment_plans SET status = 'completed' WHERE id = r.plan_id;
  END IF;
  INSERT INTO public.audit_logs (user_id, action, details)
    VALUES (auth.uid(), 'pay_installment', jsonb_build_object('installment', _inst, 'amount', _amount, 'method', coalesce(_method,'cash')));
END $$;

REVOKE ALL ON FUNCTION public.pay_installment(uuid, numeric) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.pay_installment(uuid, numeric, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pay_installment(uuid, numeric) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pay_installment(uuid, numeric, text) TO authenticated;

-- A reversal must land in the same cash box as the entry it reverses.
CREATE OR REPLACE FUNCTION public.reverse_manual_transaction(_transaction uuid, _reason text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE tx public.transactions;
BEGIN
  SELECT * INTO tx FROM public.transactions WHERE id = _transaction FOR UPDATE;
  IF tx.id IS NULL THEN RAISE EXCEPTION 'Transaction not found'; END IF;
  IF NOT public.can_operate_branch(auth.uid(), tx.branch_id) THEN RAISE EXCEPTION 'Not allowed for this branch'; END IF;
  IF tx.ref_id IS NOT NULL OR tx.category = 'Reversal' THEN RAISE EXCEPTION 'Only manual, unlinked entries can be reversed here'; END IF;
  IF coalesce(trim(_reason), '') = '' THEN RAISE EXCEPTION 'Reversal reason is required'; END IF;
  IF EXISTS (SELECT 1 FROM public.transactions WHERE ref_id = _transaction AND category = 'Reversal') THEN
    RAISE EXCEPTION 'Transaction has already been reversed';
  END IF;
  INSERT INTO public.transactions (branch_id, kind, category, amount, note, ref_id, method, created_by)
    VALUES (tx.branch_id, CASE WHEN tx.kind = 'income' THEN 'expense' ELSE 'income' END,
      'Reversal', tx.amount, 'Reversal of ' || tx.category || ': ' || trim(_reason), tx.id, tx.method, auth.uid());
  INSERT INTO public.audit_logs (user_id, action, details)
    VALUES (auth.uid(), 'reverse_manual_transaction', jsonb_build_object(
      'transaction', tx.id, 'branch', tx.branch_id, 'kind', tx.kind, 'amount', tx.amount, 'reason', trim(_reason)
    ));
END $$;

REVOKE ALL ON FUNCTION public.reverse_manual_transaction(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reverse_manual_transaction(uuid, text) TO authenticated;

-- Partner money keeps the method the user picked.
CREATE OR REPLACE FUNCTION public.partner_payment(_partner uuid, _branch uuid, _kind text, _amount numeric, _method text, _note text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE pname text;
BEGIN
  IF NOT public.can_operate_branch(auth.uid(), _branch) THEN RAISE EXCEPTION 'Not allowed'; END IF;
  IF _kind NOT IN ('received','paid') THEN RAISE EXCEPTION 'Invalid kind'; END IF;
  IF _amount IS NULL OR _amount <= 0 THEN RAISE EXCEPTION 'Amount must be positive'; END IF;
  SELECT name INTO pname FROM public.finance_partners WHERE id = _partner;
  IF pname IS NULL THEN RAISE EXCEPTION 'Partner not found'; END IF;
  INSERT INTO public.finance_partner_ledger(partner_id, branch_id, kind, amount, method, note, created_by)
    VALUES (_partner, _branch, _kind, _amount, coalesce(_method,'cash'), _note, auth.uid());
  INSERT INTO public.transactions(branch_id, kind, category, amount, note, ref_id, method, created_by)
    VALUES (_branch, CASE WHEN _kind = 'received' THEN 'income' ELSE 'expense' END,
            CASE WHEN _kind = 'received' THEN 'Finance partner receipt' ELSE 'Finance partner payment' END,
            _amount, pname || coalesce(' — ' || nullif(_note,''), ''), _partner, coalesce(_method,'cash'), auth.uid());
  INSERT INTO public.audit_logs(user_id, action, details) VALUES (auth.uid(), 'partner_' || _kind, jsonb_build_object('partner', _partner, 'branch', _branch, 'amount', _amount));
END $$;

REVOKE ALL ON FUNCTION public.partner_payment(uuid, uuid, text, numeric, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.partner_payment(uuid, uuid, text, numeric, text, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- 2. Reorder level on products — the low-stock warning
-- ---------------------------------------------------------------------------
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS min_stock integer NOT NULL DEFAULT 0;
ALTER TABLE public.products DROP CONSTRAINT IF EXISTS products_min_stock_check;
ALTER TABLE public.products ADD CONSTRAINT products_min_stock_check CHECK (min_stock >= 0);

-- ---------------------------------------------------------------------------
-- 3. Notes on customers
-- ---------------------------------------------------------------------------
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS notes text;

-- ---------------------------------------------------------------------------
-- 4. Default print language for receipts (falls back from the seller's own)
-- ---------------------------------------------------------------------------
ALTER TABLE public.app_settings ADD COLUMN IF NOT EXISTS default_print_lang text NOT NULL DEFAULT 'en';
ALTER TABLE public.app_settings DROP CONSTRAINT IF EXISTS app_settings_default_print_lang_check;
ALTER TABLE public.app_settings ADD CONSTRAINT app_settings_default_print_lang_check
  CHECK (default_print_lang IN ('en','bn'));

-- ---------------------------------------------------------------------------
-- 5. Finance cases are created through a function, so they get an audit trail
--    and can point at the POS invoice they refer to.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_finance_case(_branch uuid, _partner uuid, _customer text, _phone text,
                                                      _ref text, _amount numeric, _note text, _sale uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE c_id uuid;
BEGIN
  IF NOT public.can_operate_branch(auth.uid(), _branch) THEN RAISE EXCEPTION 'Not allowed for this branch'; END IF;
  IF coalesce(trim(_customer),'') = '' THEN RAISE EXCEPTION 'Customer name is required'; END IF;
  IF _amount IS NULL OR _amount <= 0 THEN RAISE EXCEPTION 'Amount must be positive'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.finance_partners WHERE id = _partner) THEN RAISE EXCEPTION 'Partner not found'; END IF;
  IF _sale IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.sales WHERE id = _sale AND branch_id = _branch) THEN
    RAISE EXCEPTION 'That invoice does not belong to this branch';
  END IF;
  INSERT INTO public.finance_cases (branch_id, partner_id, sale_id, customer_name, customer_phone, ref_no, amount, note, created_by)
  VALUES (_branch, _partner, _sale, trim(_customer), nullif(trim(_phone),''), nullif(trim(_ref),''), _amount, nullif(trim(_note),''), auth.uid())
  RETURNING id INTO c_id;
  INSERT INTO public.audit_logs (user_id, action, details)
    VALUES (auth.uid(), 'create_finance_case', jsonb_build_object('case', c_id, 'branch', _branch, 'partner', _partner, 'amount', _amount, 'sale', _sale));
  RETURN c_id;
END $$;

REVOKE ALL ON FUNCTION public.create_finance_case(uuid, uuid, text, text, text, numeric, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_finance_case(uuid, uuid, text, text, text, numeric, text, uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- 6. Payroll — the salary of the staff finally reaches the cash book
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.employee_payroll (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  branch_id uuid NOT NULL REFERENCES public.branches(id),
  period text NOT NULL,
  amount numeric(12,2) NOT NULL CHECK (amount >= 0),
  note text,
  paid_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (employee_id, period)
);
GRANT SELECT ON public.employee_payroll TO authenticated;
GRANT ALL ON public.employee_payroll TO service_role;
ALTER TABLE public.employee_payroll ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "branch can read payroll" ON public.employee_payroll;
CREATE POLICY "branch can read payroll" ON public.employee_payroll FOR SELECT TO authenticated
  USING (public.can_access_branch(auth.uid(), branch_id));

CREATE OR REPLACE FUNCTION public.run_payroll(_branch uuid, _period text, _employee_ids uuid[], _note text)
RETURNS numeric LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r record; total numeric := 0;
BEGIN
  IF NOT public.can_write_hq(auth.uid())
     AND NOT (public.user_branch(auth.uid()) = _branch AND public.has_role(auth.uid(), 'branch_manager')) THEN
    RAISE EXCEPTION 'Not allowed to run payroll for this branch';
  END IF;
  IF NOT (coalesce(_period,'') ~ '^\d{4}-\d{2}$') THEN RAISE EXCEPTION 'Period must look like 2026-01'; END IF;
  IF coalesce(array_length(_employee_ids, 1), 0) = 0 THEN RAISE EXCEPTION 'No staff selected'; END IF;

  INSERT INTO public.employee_payroll (employee_id, branch_id, period, amount, note, created_by)
  SELECT e.id, e.branch_id, _period, 0, nullif(trim(_note),''), auth.uid()
    FROM public.employees e WHERE e.id = any(_employee_ids)
  ON CONFLICT (employee_id, period) DO NOTHING;

  FOR r IN
    SELECT e.id, e.name, e.salary, e.branch_id FROM public.employees e WHERE e.id = any(_employee_ids)
  LOOP
    IF r.branch_id <> _branch THEN RAISE EXCEPTION '% is not in this branch', r.name; END IF;
    IF EXISTS (SELECT 1 FROM public.employee_payroll p WHERE p.employee_id = r.id AND p.period = _period AND p.amount > 0) THEN
      RAISE EXCEPTION '% was already paid for %', r.name, _period;
    END IF;
    UPDATE public.employee_payroll SET amount = r.salary, note = coalesce(nullif(trim(_note),''), note)
      WHERE employee_id = r.id AND period = _period;
    total := total + r.salary;
  END LOOP;

  IF total > 0 THEN
    INSERT INTO public.transactions (branch_id, kind, category, amount, note, ref_id, method, created_by)
      VALUES (_branch, 'expense', 'Staff salary', total, 'Payroll ' || _period || coalesce(' — ' || nullif(trim(_note),''), ''), NULL, 'cash', auth.uid());
  END IF;

  INSERT INTO public.audit_logs (user_id, action, details)
    VALUES (auth.uid(), 'run_payroll', jsonb_build_object('branch', _branch, 'period', _period, 'total', total, 'staff', coalesce(array_length(_employee_ids,1),0)));
  RETURN total;
END $$;
REVOKE ALL ON FUNCTION public.run_payroll(uuid, text, uuid[], text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.run_payroll(uuid, text, uuid[], text) TO authenticated;
