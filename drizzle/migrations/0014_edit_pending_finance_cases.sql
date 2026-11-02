CREATE OR REPLACE FUNCTION public.update_pending_finance_case(
  _case uuid,
  _partner uuid,
  _customer_name text,
  _customer_phone text,
  _ref_no text,
  _amount numeric,
  _note text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  c public.finance_cases;
  partner_active boolean;
BEGIN
  SELECT * INTO c FROM public.finance_cases WHERE id = _case FOR UPDATE;
  IF c.id IS NULL OR c.status <> 'pending' THEN RAISE EXCEPTION 'Only pending finance cases can be edited'; END IF;
  IF NOT public.can_operate_branch(auth.uid(), c.branch_id) THEN RAISE EXCEPTION 'Not allowed for this branch'; END IF;
  IF c.created_by IS DISTINCT FROM auth.uid() AND NOT public.can_approve_branch(auth.uid(), c.branch_id) THEN RAISE EXCEPTION 'Only the creator, branch manager, or admin can edit this case'; END IF;
  SELECT active INTO partner_active FROM public.finance_partners WHERE id = _partner;
  IF partner_active IS DISTINCT FROM true THEN RAISE EXCEPTION 'Choose an active finance partner'; END IF;
  IF coalesce(trim(_customer_name), '') = '' OR _amount IS NULL OR _amount <= 0 THEN RAISE EXCEPTION 'Customer name and a positive amount are required'; END IF;

  UPDATE public.finance_cases
    SET partner_id = _partner, customer_name = trim(_customer_name), customer_phone = nullif(trim(_customer_phone), ''),
        ref_no = nullif(trim(_ref_no), ''), amount = _amount, note = nullif(trim(_note), '')
    WHERE id = _case;
  INSERT INTO public.audit_logs (user_id, action, details)
    VALUES (auth.uid(), 'update_pending_finance_case', jsonb_build_object(
      'case', _case,
      'old', jsonb_build_object('partner', c.partner_id, 'customer', c.customer_name, 'amount', c.amount),
      'new', jsonb_build_object('partner', _partner, 'customer', trim(_customer_name), 'amount', _amount)
    ));
END;
$$;

CREATE OR REPLACE FUNCTION public.cancel_pending_finance_case(_case uuid, _reason text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  c public.finance_cases;
BEGIN
  SELECT * INTO c FROM public.finance_cases WHERE id = _case FOR UPDATE;
  IF c.id IS NULL OR c.status <> 'pending' THEN RAISE EXCEPTION 'Only pending finance cases can be cancelled'; END IF;
  IF NOT public.can_operate_branch(auth.uid(), c.branch_id) THEN RAISE EXCEPTION 'Not allowed for this branch'; END IF;
  IF c.created_by IS DISTINCT FROM auth.uid() AND NOT public.can_approve_branch(auth.uid(), c.branch_id) THEN RAISE EXCEPTION 'Only the creator, branch manager, or admin can cancel this case'; END IF;
  IF coalesce(trim(_reason), '') = '' THEN RAISE EXCEPTION 'Cancellation reason is required'; END IF;

  UPDATE public.finance_cases SET status = 'cancelled' WHERE id = _case;
  INSERT INTO public.audit_logs (user_id, action, details)
    VALUES (auth.uid(), 'cancel_pending_finance_case', jsonb_build_object('case', _case, 'reason', trim(_reason)));
END;
$$;

REVOKE ALL ON FUNCTION public.update_pending_finance_case(uuid, uuid, text, text, text, numeric, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_pending_finance_case(uuid, uuid, text, text, text, numeric, text) TO authenticated;
REVOKE ALL ON FUNCTION public.cancel_pending_finance_case(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cancel_pending_finance_case(uuid, text) TO authenticated;