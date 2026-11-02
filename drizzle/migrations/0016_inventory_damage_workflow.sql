CREATE OR REPLACE FUNCTION public.mark_inventory_damaged(_item uuid, _reason text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  i public.inventory_items;
BEGIN
  SELECT * INTO i FROM public.inventory_items WHERE id = _item FOR UPDATE;
  IF i.id IS NULL OR i.status <> 'in_stock' THEN RAISE EXCEPTION 'Only in-stock items can be marked damaged'; END IF;
  IF NOT public.can_approve_branch(auth.uid(), i.branch_id) THEN RAISE EXCEPTION 'Only the branch manager or admin can update damage status'; END IF;
  IF coalesce(trim(_reason), '') = '' THEN RAISE EXCEPTION 'Damage reason is required'; END IF;
  UPDATE public.inventory_items SET status = 'damaged' WHERE id = _item;
  INSERT INTO public.audit_logs (user_id, action, details)
    VALUES (auth.uid(), 'mark_inventory_damaged', jsonb_build_object('item', _item, 'imei', i.imei, 'reason', trim(_reason)));
END;
$$;

CREATE OR REPLACE FUNCTION public.restore_damaged_inventory(_item uuid, _reason text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  i public.inventory_items;
BEGIN
  SELECT * INTO i FROM public.inventory_items WHERE id = _item FOR UPDATE;
  IF i.id IS NULL OR i.status <> 'damaged' THEN RAISE EXCEPTION 'Only damaged items can be restored'; END IF;
  IF NOT public.can_approve_branch(auth.uid(), i.branch_id) THEN RAISE EXCEPTION 'Only the branch manager or admin can restore stock'; END IF;
  IF coalesce(trim(_reason), '') = '' THEN RAISE EXCEPTION 'Restoration reason is required'; END IF;
  UPDATE public.inventory_items SET status = 'in_stock' WHERE id = _item;
  INSERT INTO public.audit_logs (user_id, action, details)
    VALUES (auth.uid(), 'restore_damaged_inventory', jsonb_build_object('item', _item, 'imei', i.imei, 'reason', trim(_reason)));
END;
$$;

REVOKE ALL ON FUNCTION public.mark_inventory_damaged(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mark_inventory_damaged(uuid, text) TO authenticated;
REVOKE ALL ON FUNCTION public.restore_damaged_inventory(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.restore_damaged_inventory(uuid, text) TO authenticated;