CREATE OR REPLACE FUNCTION public.update_pending_expense(
  _expense uuid,
  _category text,
  _amount numeric,
  _date date,
  _method text,
  _note text,
  _attachment text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  e public.expenses;
BEGIN
  SELECT * INTO e FROM public.expenses WHERE id = _expense FOR UPDATE;
  IF e.id IS NULL OR e.status <> 'pending' THEN RAISE EXCEPTION 'Only pending expenses can be edited'; END IF;
  IF e.created_by IS DISTINCT FROM auth.uid() AND NOT public.can_write_hq(auth.uid()) THEN RAISE EXCEPTION 'Only the creator or an admin can edit this expense'; END IF;
  IF NOT public.can_operate_branch(auth.uid(), e.branch_id) THEN RAISE EXCEPTION 'Not allowed for this branch'; END IF;
  IF coalesce(trim(_category), '') = '' OR _amount IS NULL OR _amount <= 0 THEN RAISE EXCEPTION 'Category and a positive amount are required'; END IF;

  UPDATE public.expenses
    SET category = trim(_category), amount = _amount, expense_date = coalesce(_date, e.expense_date),
        method = coalesce(nullif(trim(_method), ''), e.method), note = nullif(trim(_note), ''),
        attachment_url = nullif(trim(_attachment), '')
    WHERE id = _expense;
  INSERT INTO public.audit_logs (user_id, action, details)
    VALUES (auth.uid(), 'update_pending_expense', jsonb_build_object(
      'expense', _expense,
      'old', jsonb_build_object('category', e.category, 'amount', e.amount, 'date', e.expense_date),
      'new', jsonb_build_object('category', trim(_category), 'amount', _amount, 'date', coalesce(_date, e.expense_date))
    ));
END;
$$;

REVOKE ALL ON FUNCTION public.update_pending_expense(uuid, text, numeric, date, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_pending_expense(uuid, text, numeric, date, text, text, text) TO authenticated;