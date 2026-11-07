-- 0029 — branch accounting corrections
--
-- Defects found while auditing each showroom's day book:
--
--   1. An unwritten day carried forward the last typed OPENING balance, not
--      the cash the till actually closed with. A branch that opened with 5000
--      on Monday and sold 12000 in cash still showed 5000 on Tuesday. The
--      carry-forward now uses the last counted drawer (or that day's computed
--      closing) plus every cash movement on the days in between.
--
--   2. settle_finance, run_payroll and return_sale always booked their money
--      as cash, so a bank settlement or a bKash salary left the drawer figure
--      wrong. Each gains a payment-method argument; the old signatures stay
--      and keep their previous behaviour.
--
--   3. reverse_manual_transaction and record_hq_deposit accepted anyone who
--      can operate the branch, so a salesman could reverse an income entry or
--      book an HQ deposit through the RPC even though the UI hides both. The
--      checks now match the UI: accountant, branch manager or HQ write.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- ---------------------------------------------------------------------------
-- 1. The opening balance carries the closing cash forward, not the opening
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.daily_cash_reconciliation(_branch uuid, _day date)
RETURNS TABLE(
  branch_id uuid, day date,
  opening_cash numeric,
  cash_sales numeric, bank_card_sales numeric, mfs_sales numeric,
  credit_sales numeric,
  collections numeric, cash_collections numeric, mfs_collections numeric,
  other_income numeric, cash_other_income numeric,
  expenses numeric, cash_expenses numeric,
  hq_deposits numeric, cash_deposits numeric,
  closing_cash numeric, counted_cash numeric, variance numeric, balanced boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  b uuid; d date;
  v_open numeric; v_counted numeric;
  v_rec_open numeric; v_rec_counted numeric;
  v_prev_day date; v_prev_open numeric; v_prev_counted numeric;
  v_from date;
  v_cash_sales numeric := 0; v_bank_sales numeric := 0; v_mfs_sales numeric := 0;
  v_credit numeric := 0;
  v_coll numeric := 0; v_coll_cash numeric := 0; v_coll_mfs numeric := 0;
  v_other numeric := 0; v_other_cash numeric := 0;
  v_exp numeric := 0; v_exp_cash numeric := 0; v_dep numeric := 0; v_dep_cash numeric := 0;
  v_close numeric;
BEGIN
  b := _branch;
  IF b IS NULL THEN
    IF public.is_hq(auth.uid()) THEN b := NULL;
    ELSE
      b := public.user_branch(auth.uid());
      IF b IS NULL THEN RAISE EXCEPTION 'No branch is assigned to your account'; END IF;
    END IF;
  ELSIF NOT public.can_access_branch(auth.uid(), b) THEN
    RAISE EXCEPTION 'Not allowed for this branch';
  END IF;
  d := coalesce(_day, (now() AT TIME ZONE 'Asia/Dhaka')::date);

  -- Today's money movements, split by where the cash actually landed. The day
  -- boundary is the Dhaka calendar day, not the server's UTC one.
  SELECT
    coalesce(sum(t.amount) FILTER (WHERE t.kind = 'income'
                                   AND t.category IN ('Sales','Down payment')
                                   AND t.method = 'cash'), 0),
    coalesce(sum(t.amount) FILTER (WHERE t.kind = 'income'
                                   AND t.category IN ('Sales','Down payment')
                                   AND t.method IN ('bank','card','cheque')), 0),
    coalesce(sum(t.amount) FILTER (WHERE t.kind = 'income'
                                   AND t.category IN ('Sales','Down payment')
                                   AND t.method IN ('bkash','nagad','rocket')), 0),
    coalesce(sum(t.amount) FILTER (WHERE t.kind = 'income' AND t.category = 'Installment'), 0),
    coalesce(sum(t.amount) FILTER (WHERE t.kind = 'income' AND t.category = 'Installment'
                                   AND t.method = 'cash'), 0),
    coalesce(sum(t.amount) FILTER (WHERE t.kind = 'income' AND t.category = 'Installment'
                                   AND t.method IN ('bkash','nagad','rocket')), 0),
    coalesce(sum(t.amount) FILTER (WHERE t.kind = 'income'
                                   AND t.category NOT IN ('Sales','Down payment','Installment')), 0),
    coalesce(sum(t.amount) FILTER (WHERE t.kind = 'income'
                                   AND t.category NOT IN ('Sales','Down payment','Installment')
                                   AND t.method = 'cash'), 0),
    coalesce(sum(t.amount) FILTER (WHERE t.kind = 'expense' AND t.category <> 'HQ deposit'), 0),
    coalesce(sum(t.amount) FILTER (WHERE t.kind = 'expense' AND t.category <> 'HQ deposit'
                                   AND t.method = 'cash'), 0),
    coalesce(sum(t.amount) FILTER (WHERE t.kind = 'expense' AND t.category = 'HQ deposit'), 0),
    coalesce(sum(t.amount) FILTER (WHERE t.kind = 'expense' AND t.category = 'HQ deposit'
                                   AND t.method = 'cash'), 0)
    INTO v_cash_sales, v_bank_sales, v_mfs_sales,
         v_coll, v_coll_cash, v_coll_mfs,
         v_other, v_other_cash,
         v_exp, v_exp_cash, v_dep, v_dep_cash
  FROM public.transactions t
  WHERE (b IS NULL OR t.branch_id = b)
    AND (t.created_at AT TIME ZONE 'Asia/Dhaka')::date = d;

  SELECT coalesce(sum(s.total - s.paid), 0) INTO v_credit
    FROM public.sales s
   WHERE (b IS NULL OR s.branch_id = b)
     AND s.sale_type = 'installment'
     AND (s.created_at AT TIME ZONE 'Asia/Dhaka')::date = d;

  -- The opening balance. A typed record for the day always wins. Otherwise
  -- the till starts with what it physically closed with last time: the counted
  -- drawer if there was one, else that day's computed closing. Cash movements
  -- on the days between that record and today are added on top, so a branch
  -- that only writes the day book once a week still keeps a continuous book.
  v_open := 0;
  v_counted := NULL;
  IF b IS NOT NULL THEN
    SELECT x.opening_cash, x.counted_cash INTO v_rec_open, v_rec_counted
      FROM public.daily_cash_records x WHERE x.branch_id = b AND x.day = d;
    IF FOUND THEN
      v_open := v_rec_open;
      v_counted := v_rec_counted;
    ELSE
      SELECT y.day, y.opening_cash, y.counted_cash INTO v_prev_day, v_prev_open, v_prev_counted
        FROM public.daily_cash_records y
       WHERE y.branch_id = b AND y.day < d
       ORDER BY y.day DESC LIMIT 1;
      IF FOUND THEN
        v_open := coalesce(v_prev_counted, v_prev_open);
        -- A counted drawer already includes that day's movements; an uncounted
        -- day's opening does not, so its own cash net has to be added.
        v_from := CASE WHEN v_prev_counted IS NOT NULL THEN v_prev_day + 1 ELSE v_prev_day END;
      ELSE
        v_open := 0;
        v_from := DATE '0001-01-01';
      END IF;
      SELECT v_open + coalesce(sum(CASE WHEN t.kind = 'income' THEN t.amount ELSE -t.amount END), 0)
        INTO v_open
        FROM public.transactions t
       WHERE t.branch_id = b AND t.method = 'cash'
         AND (t.created_at AT TIME ZONE 'Asia/Dhaka')::date >= v_from
         AND (t.created_at AT TIME ZONE 'Asia/Dhaka')::date < d;
    END IF;
  END IF;

  -- The drawer only ever holds cash, so the identity is built from the cash
  -- column of every line and nothing else:
  --   closing = opening + cash sales + cash collections + other cash in
  --             - cash expenses - cash paid to head office
  v_close := v_open + v_cash_sales + v_coll_cash + v_other_cash
             - v_exp_cash - v_dep_cash;

  RETURN QUERY SELECT
    b, d,
    v_open::numeric,
    v_cash_sales::numeric, v_bank_sales::numeric, v_mfs_sales::numeric,
    v_credit::numeric,
    v_coll::numeric, v_coll_cash::numeric, v_coll_mfs::numeric,
    v_other::numeric, v_other_cash::numeric,
    v_exp::numeric, v_exp_cash::numeric,
    v_dep::numeric, v_dep_cash::numeric,
    v_close::numeric,
    v_counted::numeric,
    (v_counted - v_close)::numeric,
    (v_counted IS NOT NULL AND abs(v_counted - v_close) < 0.005);
END $$;
REVOKE ALL ON FUNCTION public.daily_cash_reconciliation(uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.daily_cash_reconciliation(uuid, date) TO authenticated;

-- ---------------------------------------------------------------------------
-- 2. An HQ deposit is a cash-book job, not a salesman's
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_hq_deposit(_branch uuid, _amount numeric, _method text, _note text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE tx_id uuid; m text;
BEGIN
  IF NOT public.can_operate_branch(auth.uid(), _branch) THEN RAISE EXCEPTION 'Not allowed for this branch'; END IF;
  IF NOT public.can_write_hq(auth.uid())
     AND NOT (public.user_branch(auth.uid()) = _branch
              AND (public.has_role(auth.uid(), 'accountant')
                   OR public.has_role(auth.uid(), 'branch_manager'))) THEN
    RAISE EXCEPTION 'Only an accountant, branch manager or admin can record an HQ deposit';
  END IF;
  IF _amount IS NULL OR _amount <= 0 THEN RAISE EXCEPTION 'Amount must be greater than zero'; END IF;
  m := coalesce(nullif(trim(_method), ''), 'cash');
  IF m NOT IN ('cash','bank','bkash','nagad','rocket','card','cheque','online') THEN
    RAISE EXCEPTION 'Unknown payment method %', m;
  END IF;
  INSERT INTO public.transactions (branch_id, kind, category, amount, note, ref_id, method, created_by)
  VALUES (_branch, 'expense', 'HQ deposit', _amount, nullif(trim(_note), ''), NULL, m, auth.uid())
  RETURNING id INTO tx_id;
  INSERT INTO public.audit_logs (user_id, action, details)
    VALUES (auth.uid(), 'record_hq_deposit', jsonb_build_object(
      'transaction', tx_id, 'branch', _branch, 'amount', _amount, 'method', m, 'note', nullif(trim(_note), '')));
  RETURN tx_id;
END $$;
REVOKE ALL ON FUNCTION public.record_hq_deposit(uuid, numeric, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_hq_deposit(uuid, numeric, text, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- 3. Reversing an income entry is a cash-book job too
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reverse_manual_transaction(_transaction uuid, _reason text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE tx public.transactions;
BEGIN
  SELECT * INTO tx FROM public.transactions WHERE id = _transaction FOR UPDATE;
  IF tx.id IS NULL THEN RAISE EXCEPTION 'Transaction not found'; END IF;
  IF NOT public.can_operate_branch(auth.uid(), tx.branch_id) THEN RAISE EXCEPTION 'Not allowed for this branch'; END IF;
  IF NOT public.can_write_hq(auth.uid())
     AND NOT (public.user_branch(auth.uid()) = tx.branch_id
              AND (public.has_role(auth.uid(), 'accountant')
                   OR public.has_role(auth.uid(), 'branch_manager'))) THEN
    RAISE EXCEPTION 'Only an accountant, branch manager or admin can reverse an entry';
  END IF;
  IF tx.ref_id IS NOT NULL OR tx.category = 'Reversal' THEN RAISE EXCEPTION 'Only manual, unlinked entries can be reversed here'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.audit_logs
     WHERE action = 'add_manual_income'
       AND details->>'transaction' = tx.id::text
  ) THEN
    RAISE EXCEPTION 'Only manual, unlinked entries can be reversed here';
  END IF;
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

-- ---------------------------------------------------------------------------
-- 4. A partner settlement arrives in a method, not always in cash
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.settle_finance(_case uuid, _received numeric, _method text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE c public.finance_cases; m text;
BEGIN
  SELECT * INTO c FROM public.finance_cases WHERE id = _case FOR UPDATE;
  IF c.id IS NULL THEN RAISE EXCEPTION 'Case not found'; END IF;
  IF NOT public.can_operate_branch(auth.uid(), c.branch_id) THEN RAISE EXCEPTION 'Not allowed'; END IF;
  IF c.status <> 'pending' THEN RAISE EXCEPTION 'Already settled'; END IF;
  IF _received < 0 OR _received > c.amount THEN RAISE EXCEPTION 'Invalid amount'; END IF;
  m := coalesce(nullif(trim(_method), ''), 'cash');
  IF m NOT IN ('cash','bank','bkash','nagad','rocket','card','cheque','online') THEN
    RAISE EXCEPTION 'Unknown payment method %', m;
  END IF;
  UPDATE public.finance_cases SET status = 'settled', settled_at = now(), commission = c.amount - _received WHERE id = _case;
  IF _received > 0 THEN
    INSERT INTO public.transactions(branch_id, kind, category, amount, note, ref_id, method, created_by)
    VALUES (c.branch_id, 'income', 'finance_settlement', _received, coalesce(c.ref_no, '') || ' ' || c.customer_name, c.id, m, auth.uid());
    INSERT INTO public.finance_partner_ledger(partner_id, branch_id, kind, amount, note, case_id, created_by)
    VALUES (c.partner_id, c.branch_id, 'received', _received, 'Settlement ' || coalesce(c.ref_no,''), c.id, auth.uid());
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.settle_finance(_case uuid, _received numeric)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public.settle_finance(_case, _received, 'cash');
END $$;
REVOKE ALL ON FUNCTION public.settle_finance(uuid, numeric, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.settle_finance(uuid, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.settle_finance(uuid, numeric, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.settle_finance(uuid, numeric) TO authenticated;

-- ---------------------------------------------------------------------------
-- 5. Payroll can be paid from the bank or a wallet, not only the drawer
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.run_payroll(_branch uuid, _period text, _employee_ids uuid[], _note text, _method text)
RETURNS numeric LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r record; total numeric := 0; e_id uuid; v_no text; m text;
BEGIN
  IF NOT public.can_write_hq(auth.uid())
     AND NOT (public.user_branch(auth.uid()) = _branch AND public.has_role(auth.uid(), 'branch_manager')) THEN
    RAISE EXCEPTION 'Not allowed to run payroll for this branch';
  END IF;
  IF NOT (coalesce(_period,'') ~ '^\d{4}-\d{2}$') THEN RAISE EXCEPTION 'Period must look like 2026-01'; END IF;
  IF coalesce(array_length(_employee_ids, 1), 0) = 0 THEN RAISE EXCEPTION 'No staff selected'; END IF;
  m := coalesce(nullif(trim(_method), ''), 'cash');
  IF m NOT IN ('cash','bank','bkash','nagad','rocket','card','cheque','online') THEN
    RAISE EXCEPTION 'Unknown payment method %', m;
  END IF;

  INSERT INTO public.employee_payroll (employee_id, branch_id, period, amount, note, created_by)
  SELECT e.id, e.branch_id, _period, 0, nullif(trim(_note),''), auth.uid()
    FROM public.employees e WHERE e.id = any(_employee_ids)
  ON CONFLICT (employee_id, period) DO NOTHING;

  FOR r IN
    SELECT e.id, e.name, e.salary, e.branch_id FROM public.employees e WHERE e.id = any(_employee_ids)
  LOOP
    IF r.branch_id <> _branch THEN RAISE EXCEPTION '% is not in this branch', r.name; END IF;
    IF EXISTS (SELECT 1 FROM public.employee_payroll p
                WHERE p.employee_id = r.id AND p.period = _period AND p.amount > 0) THEN
      RAISE EXCEPTION '% was already paid for %', r.name, _period;
    END IF;
    UPDATE public.employee_payroll SET amount = r.salary, note = coalesce(nullif(trim(_note),''), note)
      WHERE employee_id = r.id AND period = _period;
    total := total + r.salary;
  END LOOP;

  IF total > 0 THEN
    v_no := 'EXP-' || to_char(now(), 'YYMMDD') || '-' || substr(gen_random_uuid()::text, 1, 6);
    INSERT INTO public.expenses (branch_id, category, amount, expense_date, method, note,
                                 bill_no, voucher_no, status, approved_by, approved_at, created_by)
    VALUES (_branch, 'Staff salary', total,
            (now() AT TIME ZONE 'Asia/Dhaka')::date, m,
            'Payroll ' || _period || coalesce(' — ' || nullif(trim(_note), ''), ''),
            _period, v_no, 'approved', auth.uid(), now(), auth.uid())
    RETURNING id INTO e_id;
    INSERT INTO public.transactions (branch_id, kind, category, amount, note, ref_id, method, created_by)
    VALUES (_branch, 'expense', 'Staff salary', total,
            'Payroll ' || _period || coalesce(' — ' || nullif(trim(_note), ''), ''),
            e_id, m, auth.uid());
  END IF;

  INSERT INTO public.audit_logs (user_id, action, details)
    VALUES (auth.uid(), 'run_payroll', jsonb_build_object(
      'branch', _branch, 'period', _period, 'total', total,
      'expense', e_id, 'voucher', v_no, 'method', m,
      'staff', coalesce(array_length(_employee_ids,1),0)));
  RETURN total;
END $$;

CREATE OR REPLACE FUNCTION public.run_payroll(_branch uuid, _period text, _employee_ids uuid[], _note text)
RETURNS numeric LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN public.run_payroll(_branch, _period, _employee_ids, _note, 'cash');
END $$;
REVOKE ALL ON FUNCTION public.run_payroll(uuid, text, uuid[], text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.run_payroll(uuid, text, uuid[], text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.run_payroll(uuid, text, uuid[], text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.run_payroll(uuid, text, uuid[], text) TO authenticated;

-- ---------------------------------------------------------------------------
-- 6. A refund leaves in the method it is handed back in
-- ---------------------------------------------------------------------------
-- Without an explicit method the refund keeps the sale's payment method, which
-- is what the old trigger backfill did. The trigger must not overwrite a
-- refund's chosen method: a bKash sale can be refunded in cash from the till.
CREATE OR REPLACE FUNCTION public.transactions_fill_method() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE m text;
BEGIN
  IF NEW.ref_id IS NOT NULL AND NEW.category <> 'Sale refund' THEN
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

CREATE OR REPLACE FUNCTION public.return_sale(_sale uuid, _reason text, _method text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE s public.sales; refund numeric; m text;
BEGIN
  SELECT * INTO s FROM public.sales WHERE id = _sale FOR UPDATE;
  IF s.id IS NULL THEN RAISE EXCEPTION 'Sale not found'; END IF;
  IF s.status = 'returned' THEN RAISE EXCEPTION 'Sale already returned'; END IF;
  IF NOT public.can_approve_branch(auth.uid(), s.branch_id) THEN RAISE EXCEPTION 'Only a branch manager or admin can return a sale'; END IF;
  IF coalesce(trim(_reason),'') = '' THEN RAISE EXCEPTION 'Reason is required'; END IF;
  m := coalesce(nullif(trim(_method), ''), s.payment_method, 'cash');
  IF m NOT IN ('cash','bank','bkash','nagad','rocket','card','cheque','online') THEN
    RAISE EXCEPTION 'Unknown payment method %', m;
  END IF;
  SELECT s.paid + coalesce((SELECT sum(i.paid_amount) FROM public.installments i JOIN public.installment_plans p ON p.id = i.plan_id WHERE p.sale_id = _sale),0) INTO refund;
  UPDATE public.inventory_items SET status = 'in_stock', branch_id = s.branch_id WHERE id IN (SELECT item_id FROM public.sale_items WHERE sale_id = _sale);
  UPDATE public.sales SET status = 'returned', returned_at = now(), return_reason = _reason WHERE id = _sale;
  UPDATE public.installments SET cancelled = true WHERE plan_id IN (SELECT id FROM public.installment_plans WHERE sale_id = _sale) AND paid_amount < amount;
  UPDATE public.installment_plans SET status = 'cancelled' WHERE sale_id = _sale AND status = 'active';
  IF refund > 0 THEN
    INSERT INTO public.transactions (branch_id, kind, category, amount, note, ref_id, method, created_by)
    VALUES (s.branch_id, 'expense', 'Sale refund', refund, _reason, _sale, m, auth.uid());
  END IF;
  INSERT INTO public.audit_logs (user_id, action, details) VALUES (auth.uid(), 'return_sale', jsonb_build_object('sale', _sale, 'refund', refund, 'method', m, 'reason', _reason));
END $$;

CREATE OR REPLACE FUNCTION public.return_sale(_sale uuid, _reason text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public.return_sale(_sale, _reason, NULL);
END $$;
REVOKE ALL ON FUNCTION public.return_sale(uuid, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.return_sale(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.return_sale(uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.return_sale(uuid, text) TO authenticated;