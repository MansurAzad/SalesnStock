-- 0022 — reversal and manual-income permissions
--
-- Two holes found while auditing the money paths:
--
--   1. reverse_manual_transaction only refused rows that carry a document link
--      (ref_id). A payroll run writes its salary row with ref_id = NULL, so the
--      payroll expense could be "reversed" — which flips an expense into an
--      income of the same amount and inflates the cash balance. Only a hand
--      written income entry may be reversed now.
--
--   2. add_manual_income promised "an accountant, branch manager or admin" in
--      its error message and the UI offers the form to a branch manager, but
--      the check only accepted the accountant role, so a branch manager always
--      got an error. The check now matches what it says.

-- ---------------------------------------------------------------------------
-- 1. Only a manual income entry can be reversed
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reverse_manual_transaction(_transaction uuid, _reason text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE tx public.transactions;
BEGIN
  SELECT * INTO tx FROM public.transactions WHERE id = _transaction FOR UPDATE;
  IF tx.id IS NULL THEN RAISE EXCEPTION 'Transaction not found'; END IF;
  IF NOT public.can_operate_branch(auth.uid(), tx.branch_id) THEN RAISE EXCEPTION 'Not allowed for this branch'; END IF;
  IF tx.ref_id IS NOT NULL OR tx.category = 'Reversal' THEN RAISE EXCEPTION 'Only manual, unlinked entries can be reversed here'; END IF;
  -- A row without a document link is not automatically a manual entry: the
  -- payroll salary is written the same way. Only an entry that add_manual_income
  -- recorded may be reversed, so a system expense can never become income.
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
-- 2. A branch manager may add an income entry for their own branch
-- ---------------------------------------------------------------------------
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
              AND (public.has_role(auth.uid(), 'accountant')
                   OR public.has_role(auth.uid(), 'branch_manager'))) THEN
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
