CREATE OR REPLACE FUNCTION public.cancel_transfer(_transfer uuid, _reason text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  t public.stock_transfers;
  restored integer;
  expected integer;
BEGIN
  SELECT * INTO t FROM public.stock_transfers WHERE id = _transfer FOR UPDATE;
  IF t.id IS NULL OR t.status <> 'in_transit' THEN RAISE EXCEPTION 'Transfer is not in transit'; END IF;
  IF NOT public.can_approve_branch(auth.uid(), t.from_branch_id) THEN RAISE EXCEPTION 'Only the source branch manager or admin can cancel'; END IF;
  IF coalesce(trim(_reason), '') = '' THEN RAISE EXCEPTION 'Cancellation reason is required'; END IF;

  SELECT count(DISTINCT item_id) INTO expected FROM public.transfer_items WHERE transfer_id = _transfer;
  UPDATE public.inventory_items
    SET status = 'in_stock', branch_id = t.from_branch_id
    WHERE id IN (SELECT item_id FROM public.transfer_items WHERE transfer_id = _transfer)
      AND status = 'in_transit';
  GET DIAGNOSTICS restored = ROW_COUNT;
  IF restored <> expected THEN RAISE EXCEPTION 'Transfer items changed; refresh and try again'; END IF;

  UPDATE public.stock_transfers SET status = 'cancelled' WHERE id = _transfer;
  INSERT INTO public.audit_logs (user_id, action, details)
    VALUES (auth.uid(), 'cancel_transfer', jsonb_build_object('transfer', _transfer, 'reason', trim(_reason), 'items', restored));
END;
$$;

REVOKE ALL ON FUNCTION public.cancel_transfer(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cancel_transfer(uuid, text) TO authenticated;