ALTER TABLE public.installments ADD COLUMN cancelled boolean NOT NULL DEFAULT false;
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
  IF refund > 0 THEN
    INSERT INTO public.transactions (branch_id, kind, category, amount, note, ref_id, created_by)
    VALUES (s.branch_id, 'expense', 'Sale refund', refund, _reason, _sale, auth.uid());
  END IF;
  INSERT INTO public.audit_logs (user_id, action, details) VALUES (auth.uid(), 'return_sale', jsonb_build_object('sale', _sale, 'refund', refund, 'reason', _reason));
END $$;