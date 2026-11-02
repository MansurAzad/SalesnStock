CREATE OR REPLACE FUNCTION public.reverse_manual_transaction(_transaction uuid, _reason text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  tx public.transactions;
BEGIN
  SELECT * INTO tx FROM public.transactions WHERE id = _transaction FOR UPDATE;
  IF tx.id IS NULL THEN RAISE EXCEPTION 'Transaction not found'; END IF;
  IF NOT public.can_operate_branch(auth.uid(), tx.branch_id) THEN RAISE EXCEPTION 'Not allowed for this branch'; END IF;
  IF tx.ref_id IS NOT NULL OR tx.category = 'Reversal' THEN RAISE EXCEPTION 'Only manual, unlinked entries can be reversed here'; END IF;
  IF coalesce(trim(_reason), '') = '' THEN RAISE EXCEPTION 'Reversal reason is required'; END IF;
  IF EXISTS (SELECT 1 FROM public.transactions WHERE ref_id = _transaction AND category = 'Reversal') THEN
    RAISE EXCEPTION 'Transaction has already been reversed';
  END IF;

  INSERT INTO public.transactions (branch_id, kind, category, amount, note, ref_id, created_by)
    VALUES (tx.branch_id, CASE WHEN tx.kind = 'income' THEN 'expense' ELSE 'income' END,
      'Reversal', tx.amount, 'Reversal of ' || tx.category || ': ' || trim(_reason), tx.id, auth.uid());
  INSERT INTO public.audit_logs (user_id, action, details)
    VALUES (auth.uid(), 'reverse_manual_transaction', jsonb_build_object(
      'transaction', tx.id, 'branch', tx.branch_id, 'kind', tx.kind, 'amount', tx.amount, 'reason', trim(_reason)
    ));
END;
$$;

REVOKE ALL ON FUNCTION public.reverse_manual_transaction(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reverse_manual_transaction(uuid, text) TO authenticated;