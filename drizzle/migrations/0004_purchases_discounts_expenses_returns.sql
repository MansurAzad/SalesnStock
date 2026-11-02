-- Branch policies
ALTER TABLE public.branches ADD COLUMN max_discount_pct numeric(5,2) NOT NULL DEFAULT 10;
ALTER TABLE public.branches ADD COLUMN expense_limit numeric(12,2) NOT NULL DEFAULT 5000;

-- Sale discount trail and status
ALTER TABLE public.sales ADD COLUMN status text NOT NULL DEFAULT 'completed' CHECK (status IN ('completed','returned'));
ALTER TABLE public.sales ADD COLUMN discount_reason text;
ALTER TABLE public.sales ADD COLUMN discount_approved_by uuid;
ALTER TABLE public.sales ADD COLUMN returned_at timestamptz;
ALTER TABLE public.sales ADD COLUMN return_reason text;

-- Suppliers & purchases
CREATE TABLE public.suppliers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  phone text,
  address text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.purchases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id uuid NOT NULL REFERENCES public.suppliers(id),
  branch_id uuid NOT NULL REFERENCES public.branches(id),
  supplier_invoice text,
  total numeric(12,2) NOT NULL DEFAULT 0,
  returned numeric(12,2) NOT NULL DEFAULT 0,
  paid numeric(12,2) NOT NULL DEFAULT 0,
  note text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.purchase_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_id uuid NOT NULL REFERENCES public.purchases(id) ON DELETE CASCADE,
  item_id uuid NOT NULL REFERENCES public.inventory_items(id),
  cost numeric(12,2) NOT NULL,
  returned boolean NOT NULL DEFAULT false
);
CREATE TABLE public.purchase_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_id uuid NOT NULL REFERENCES public.purchases(id) ON DELETE CASCADE,
  amount numeric(12,2) NOT NULL CHECK (amount > 0),
  method text NOT NULL DEFAULT 'cash',
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Expenses
CREATE TABLE public.expenses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id uuid NOT NULL REFERENCES public.branches(id),
  category text NOT NULL,
  amount numeric(12,2) NOT NULL CHECK (amount > 0),
  expense_date date NOT NULL DEFAULT current_date,
  method text NOT NULL DEFAULT 'cash',
  note text,
  attachment_url text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  approved_by uuid,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.suppliers, public.purchases, public.purchase_items, public.purchase_payments, public.expenses TO authenticated;
GRANT INSERT, UPDATE ON public.suppliers TO authenticated;
GRANT ALL ON public.suppliers, public.purchases, public.purchase_items, public.purchase_payments, public.expenses TO service_role;

ALTER TABLE public.suppliers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.purchases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.purchase_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.purchase_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.expenses ENABLE ROW LEVEL SECURITY;

CREATE POLICY "read suppliers" ON public.suppliers FOR SELECT TO authenticated USING (true);
CREATE POLICY "hq add suppliers" ON public.suppliers FOR INSERT TO authenticated WITH CHECK (public.can_write_hq(auth.uid()));
CREATE POLICY "hq edit suppliers" ON public.suppliers FOR UPDATE TO authenticated USING (public.can_write_hq(auth.uid())) WITH CHECK (public.can_write_hq(auth.uid()));
CREATE POLICY "read purchases" ON public.purchases FOR SELECT TO authenticated USING (public.can_access_branch(auth.uid(), branch_id));
CREATE POLICY "read purchase items" ON public.purchase_items FOR SELECT TO authenticated USING (EXISTS (SELECT 1 FROM public.purchases p WHERE p.id = purchase_id AND public.can_access_branch(auth.uid(), p.branch_id)));
CREATE POLICY "read purchase payments" ON public.purchase_payments FOR SELECT TO authenticated USING (EXISTS (SELECT 1 FROM public.purchases p WHERE p.id = purchase_id AND public.can_access_branch(auth.uid(), p.branch_id)));
CREATE POLICY "read expenses" ON public.expenses FOR SELECT TO authenticated USING (public.can_access_branch(auth.uid(), branch_id));

-- helper: manager-level approver for a branch
CREATE OR REPLACE FUNCTION public.can_approve_branch(_uid uuid, _branch uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.can_write_hq(_uid) OR (public.user_branch(_uid) = _branch AND public.has_role(_uid, 'branch_manager'))
$$;

-- Purchase: creates IMEI stock, records supplier payable and any payment
CREATE OR REPLACE FUNCTION public.create_purchase(_supplier uuid, _branch uuid, _invoice text, _items jsonb, _paid numeric, _method text, _note text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE p_id uuid; tot numeric := 0; e jsonb; it_id uuid; dup text;
BEGIN
  IF NOT public.can_write_hq(auth.uid()) AND NOT public.can_approve_branch(auth.uid(), _branch) THEN RAISE EXCEPTION 'Not allowed to purchase for this branch'; END IF;
  IF jsonb_array_length(coalesce(_items,'[]'::jsonb)) = 0 THEN RAISE EXCEPTION 'No items'; END IF;
  SELECT string_agg(i.imei, ', ') INTO dup FROM public.inventory_items i WHERE i.imei IN (SELECT x->>'imei' FROM jsonb_array_elements(_items) x);
  IF dup IS NOT NULL THEN RAISE EXCEPTION 'IMEI already exists: %', dup; END IF;
  IF (SELECT count(*) FROM jsonb_array_elements(_items)) <> (SELECT count(DISTINCT x->>'imei') FROM jsonb_array_elements(_items) x) THEN RAISE EXCEPTION 'Duplicate IMEI in list'; END IF;
  SELECT coalesce(sum((x->>'cost')::numeric),0) INTO tot FROM jsonb_array_elements(_items) x;
  IF coalesce(_paid,0) < 0 OR _paid > tot THEN RAISE EXCEPTION 'Invalid paid amount'; END IF;
  INSERT INTO public.purchases (supplier_id, branch_id, supplier_invoice, total, paid, note, created_by)
  VALUES (_supplier, _branch, nullif(_invoice,''), tot, coalesce(_paid,0), _note, auth.uid()) RETURNING id INTO p_id;
  FOR e IN SELECT * FROM jsonb_array_elements(_items) LOOP
    INSERT INTO public.inventory_items (product_id, branch_id, imei, imei2, purchase_price, supplier)
    VALUES ((e->>'product_id')::uuid, _branch, e->>'imei', nullif(e->>'imei2',''), (e->>'cost')::numeric, (SELECT name FROM public.suppliers WHERE id = _supplier))
    RETURNING id INTO it_id;
    INSERT INTO public.purchase_items (purchase_id, item_id, cost) VALUES (p_id, it_id, (e->>'cost')::numeric);
  END LOOP;
  IF coalesce(_paid,0) > 0 THEN
    INSERT INTO public.purchase_payments (purchase_id, amount, method, created_by) VALUES (p_id, _paid, coalesce(_method,'cash'), auth.uid());
    INSERT INTO public.transactions (branch_id, kind, category, amount, note, ref_id, created_by) VALUES (_branch, 'expense', 'Purchase payment', _paid, 'Supplier payment', p_id, auth.uid());
  END IF;
  INSERT INTO public.audit_logs (user_id, action, details) VALUES (auth.uid(), 'create_purchase', jsonb_build_object('purchase', p_id, 'total', tot, 'items', jsonb_array_length(_items)));
  RETURN p_id;
END $$;

CREATE OR REPLACE FUNCTION public.pay_supplier(_purchase uuid, _amount numeric, _method text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE p public.purchases;
BEGIN
  SELECT * INTO p FROM public.purchases WHERE id = _purchase FOR UPDATE;
  IF p.id IS NULL THEN RAISE EXCEPTION 'Purchase not found'; END IF;
  IF NOT public.can_write_hq(auth.uid()) AND NOT public.can_approve_branch(auth.uid(), p.branch_id) THEN RAISE EXCEPTION 'Not allowed'; END IF;
  IF _amount <= 0 OR _amount > p.total - p.returned - p.paid THEN RAISE EXCEPTION 'Amount exceeds supplier due'; END IF;
  UPDATE public.purchases SET paid = paid + _amount WHERE id = _purchase;
  INSERT INTO public.purchase_payments (purchase_id, amount, method, created_by) VALUES (_purchase, _amount, coalesce(_method,'cash'), auth.uid());
  INSERT INTO public.transactions (branch_id, kind, category, amount, note, ref_id, created_by) VALUES (p.branch_id, 'expense', 'Purchase payment', _amount, 'Supplier payment', _purchase, auth.uid());
  INSERT INTO public.audit_logs (user_id, action, details) VALUES (auth.uid(), 'pay_supplier', jsonb_build_object('purchase', _purchase, 'amount', _amount));
END $$;

CREATE OR REPLACE FUNCTION public.return_purchase_item(_purchase_item uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE pi public.purchase_items; p public.purchases; st text;
BEGIN
  SELECT * INTO pi FROM public.purchase_items WHERE id = _purchase_item FOR UPDATE;
  IF pi.id IS NULL OR pi.returned THEN RAISE EXCEPTION 'Item not found or already returned'; END IF;
  SELECT * INTO p FROM public.purchases WHERE id = pi.purchase_id FOR UPDATE;
  IF NOT public.can_write_hq(auth.uid()) AND NOT public.can_approve_branch(auth.uid(), p.branch_id) THEN RAISE EXCEPTION 'Not allowed'; END IF;
  SELECT status INTO st FROM public.inventory_items WHERE id = pi.item_id;
  IF st <> 'in_stock' THEN RAISE EXCEPTION 'Only in-stock items can be returned to supplier'; END IF;
  UPDATE public.inventory_items SET status = 'returned' WHERE id = pi.item_id;
  UPDATE public.purchase_items SET returned = true WHERE id = _purchase_item;
  UPDATE public.purchases SET returned = returned + pi.cost WHERE id = p.id;
  IF p.paid > p.total - p.returned - pi.cost THEN
    INSERT INTO public.transactions (branch_id, kind, category, amount, note, ref_id, created_by)
    VALUES (p.branch_id, 'income', 'Supplier refund', p.paid - (p.total - p.returned - pi.cost), 'Purchase return refund', p.id, auth.uid());
    UPDATE public.purchases SET paid = total - returned WHERE id = p.id;
  END IF;
  INSERT INTO public.audit_logs (user_id, action, details) VALUES (auth.uid(), 'purchase_return', jsonb_build_object('purchase', p.id, 'item', pi.item_id, 'cost', pi.cost));
END $$;

-- Expenses with approval limit
CREATE OR REPLACE FUNCTION public.submit_expense(_branch uuid, _category text, _amount numeric, _date date, _method text, _note text, _attachment text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE lim numeric; e_id uuid; auto boolean;
BEGIN
  IF NOT public.can_operate_branch(auth.uid(), _branch) THEN RAISE EXCEPTION 'Not allowed for this branch'; END IF;
  IF _amount IS NULL OR _amount <= 0 THEN RAISE EXCEPTION 'Invalid amount'; END IF;
  SELECT expense_limit INTO lim FROM public.branches WHERE id = _branch;
  auto := public.can_write_hq(auth.uid()) OR (public.can_approve_branch(auth.uid(), _branch) AND _amount <= lim);
  INSERT INTO public.expenses (branch_id, category, amount, expense_date, method, note, attachment_url, status, approved_by, created_by)
  VALUES (_branch, _category, _amount, coalesce(_date, current_date), coalesce(_method,'cash'), _note, nullif(_attachment,''),
    CASE WHEN auto THEN 'approved' ELSE 'pending' END, CASE WHEN auto THEN auth.uid() END, auth.uid()) RETURNING id INTO e_id;
  IF auto THEN
    INSERT INTO public.transactions (branch_id, kind, category, amount, note, ref_id, created_by) VALUES (_branch, 'expense', _category, _amount, _note, e_id, auth.uid());
  END IF;
  INSERT INTO public.audit_logs (user_id, action, details) VALUES (auth.uid(), 'submit_expense', jsonb_build_object('expense', e_id, 'amount', _amount, 'auto_approved', auto));
  RETURN CASE WHEN auto THEN 'approved' ELSE 'pending' END;
END $$;

CREATE OR REPLACE FUNCTION public.decide_expense(_expense uuid, _approve boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE x public.expenses;
BEGIN
  IF NOT public.can_write_hq(auth.uid()) THEN RAISE EXCEPTION 'Only admin can approve'; END IF;
  SELECT * INTO x FROM public.expenses WHERE id = _expense FOR UPDATE;
  IF x.id IS NULL OR x.status <> 'pending' THEN RAISE EXCEPTION 'Expense is not pending'; END IF;
  UPDATE public.expenses SET status = CASE WHEN _approve THEN 'approved' ELSE 'rejected' END, approved_by = auth.uid() WHERE id = _expense;
  IF _approve THEN
    INSERT INTO public.transactions (branch_id, kind, category, amount, note, ref_id, created_by) VALUES (x.branch_id, 'expense', x.category, x.amount, x.note, x.id, auth.uid());
  END IF;
  INSERT INTO public.audit_logs (user_id, action, details) VALUES (auth.uid(), CASE WHEN _approve THEN 'approve_expense' ELSE 'reject_expense' END, jsonb_build_object('expense', _expense, 'amount', x.amount));
END $$;

-- Sales with discount policy (replaces older signature)
DROP FUNCTION IF EXISTS public.create_sale(uuid, uuid, jsonb, numeric, numeric, text, text, int);
CREATE OR REPLACE FUNCTION public.create_sale(
  _branch uuid, _customer uuid, _items jsonb, _discount numeric, _paid numeric, _method text,
  _sale_type text, _months int, _discount_reason text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE s_id uuid; p_id uuid; sub numeric := 0; tot numeric; ids uuid[]; bad int; remaining numeric; monthly numeric; i int;
  cost numeric; maxpct numeric; approver uuid; needs boolean := false;
BEGIN
  IF NOT public.can_operate_branch(auth.uid(), _branch) THEN RAISE EXCEPTION 'Not allowed for this branch'; END IF;
  SELECT array_agg((e->>'item_id')::uuid), coalesce(sum((e->>'price')::numeric),0) INTO ids, sub FROM jsonb_array_elements(_items) e;
  IF ids IS NULL THEN RAISE EXCEPTION 'Cart is empty'; END IF;
  SELECT count(*) INTO bad FROM public.inventory_items WHERE id = any(ids) AND (branch_id <> _branch OR status <> 'in_stock');
  IF bad > 0 THEN RAISE EXCEPTION 'Some items are not available in this branch'; END IF;
  IF coalesce(_discount,0) < 0 OR _discount > sub THEN RAISE EXCEPTION 'Invalid discount'; END IF;
  tot := sub - coalesce(_discount,0);
  SELECT coalesce(sum(purchase_price),0) INTO cost FROM public.inventory_items WHERE id = any(ids);
  SELECT max_discount_pct INTO maxpct FROM public.branches WHERE id = _branch;
  IF coalesce(_discount,0) > 0 THEN
    IF coalesce(trim(_discount_reason),'') = '' THEN RAISE EXCEPTION 'Discount reason is required'; END IF;
    needs := _discount > round(sub * maxpct / 100, 2) OR tot < cost;
    IF needs THEN
      IF NOT public.can_approve_branch(auth.uid(), _branch) THEN
        RAISE EXCEPTION 'Discount above % or below cost needs manager approval — ask a branch manager or admin to complete this sale', maxpct || '%';
      END IF;
    END IF;
    approver := auth.uid();
  END IF;
  IF _paid < 0 OR _paid > tot THEN RAISE EXCEPTION 'Invalid paid amount'; END IF;
  IF _sale_type = 'cash' AND _paid <> tot THEN RAISE EXCEPTION 'Cash sale must be fully paid'; END IF;
  IF _sale_type = 'installment' THEN
    IF _customer IS NULL THEN RAISE EXCEPTION 'Customer is required for installment'; END IF;
    IF _months IS NULL OR _months < 1 OR _months > 36 THEN RAISE EXCEPTION 'Months must be 1-36'; END IF;
    IF _paid >= tot THEN RAISE EXCEPTION 'Down payment must be less than total'; END IF;
  END IF;

  INSERT INTO public.sales (branch_id, customer_id, sale_type, subtotal, discount, total, paid, payment_method, created_by, discount_reason, discount_approved_by)
  VALUES (_branch, _customer, _sale_type, sub, coalesce(_discount,0), tot, _paid, _method, auth.uid(), nullif(trim(_discount_reason),''), approver) RETURNING id INTO s_id;
  INSERT INTO public.sale_items (sale_id, item_id, price)
    SELECT s_id, (e->>'item_id')::uuid, (e->>'price')::numeric FROM jsonb_array_elements(_items) e;
  UPDATE public.inventory_items SET status = 'sold' WHERE id = any(ids);

  IF _paid > 0 THEN
    INSERT INTO public.transactions (branch_id, kind, category, amount, note, ref_id, created_by)
    VALUES (_branch, 'income', CASE WHEN _sale_type='installment' THEN 'Down payment' ELSE 'Sales' END, _paid, 'Invoice sale', s_id, auth.uid());
  END IF;

  IF _sale_type = 'installment' THEN
    remaining := tot - _paid;
    monthly := round(remaining / _months, 2);
    INSERT INTO public.installment_plans (sale_id, branch_id, customer_id, financed_amount, down_payment, months, monthly_amount)
    VALUES (s_id, _branch, _customer, remaining, _paid, _months, monthly) RETURNING id INTO p_id;
    FOR i IN 1.._months LOOP
      INSERT INTO public.installments (plan_id, branch_id, seq, due_date, amount)
      VALUES (p_id, _branch, i, (current_date + (i || ' month')::interval)::date,
        CASE WHEN i = _months THEN remaining - monthly * (_months - 1) ELSE monthly END);
    END LOOP;
  END IF;
  INSERT INTO public.audit_logs (user_id, action, details) VALUES (auth.uid(), 'create_sale',
    jsonb_build_object('sale', s_id, 'total', tot, 'original_price', sub, 'discount', coalesce(_discount,0), 'reason', _discount_reason, 'approved_by', approver));
  RETURN s_id;
END $$;

-- Sale return: items back to stock, refund recorded, open kisti cancelled. Nothing is deleted.
CREATE OR REPLACE FUNCTION public.return_sale(_sale uuid, _reason text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE s public.sales; refund numeric;
BEGIN
  SELECT * INTO s FROM public.sales WHERE id = _sale FOR UPDATE;
  IF s.id IS NULL THEN RAISE EXCEPTION 'Sale not found'; END IF;
  IF s.status = 'returned' THEN RAISE EXCEPTION 'Sale already returned'; END IF;
  IF NOT public.can_approve_branch(auth.uid(), s.branch_id) THEN RAISE EXCEPTION 'Only a branch manager or admin can return a sale'; END IF;
  IF coalesce(trim(_reason),'') = '' THEN RAISE EXCEPTION 'Reason is required'; END IF;
  SELECT s.paid + coalesce((SELECT sum(paid_amount) FROM public.installments i JOIN public.installment_plans p ON p.id = i.plan_id WHERE p.sale_id = _sale),0) INTO refund;
  UPDATE public.inventory_items SET status = 'in_stock', branch_id = s.branch_id WHERE id IN (SELECT item_id FROM public.sale_items WHERE sale_id = _sale);
  UPDATE public.sales SET status = 'returned', returned_at = now(), return_reason = _reason WHERE id = _sale;
  UPDATE public.installments SET status = 'cancelled' WHERE plan_id IN (SELECT id FROM public.installment_plans WHERE sale_id = _sale) AND status <> 'paid';
  IF refund > 0 THEN
    INSERT INTO public.transactions (branch_id, kind, category, amount, note, ref_id, created_by)
    VALUES (s.branch_id, 'expense', 'Sale refund', refund, _reason, _sale, auth.uid());
  END IF;
  INSERT INTO public.audit_logs (user_id, action, details) VALUES (auth.uid(), 'return_sale', jsonb_build_object('sale', _sale, 'refund', refund, 'reason', _reason));
END $$;

-- Branch policy edits are audited
CREATE OR REPLACE FUNCTION public.audit_branch_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.audit_logs (user_id, action, details) VALUES (auth.uid(), 'branch_update', jsonb_build_object('branch', NEW.id, 'old', to_jsonb(OLD), 'new', to_jsonb(NEW)));
  RETURN NEW;
END $$;
CREATE TRIGGER trg_audit_branch AFTER UPDATE ON public.branches FOR EACH ROW EXECUTE FUNCTION public.audit_branch_change();
