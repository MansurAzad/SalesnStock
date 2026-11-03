-- 0020 — reporting aggregates that tie the modules together
--
-- The dashboard and the reports tab need answers that the browser cannot
-- compute cheaply: how much stock is on hand right now, which models are
-- below their reorder level, and how the unpaid kistis age. Doing this in the
-- database keeps the pages fast no matter how many showrooms are running.
--
-- All three functions are SECURITY DEFINER, so they bypass RLS — which means
-- they must do the branch check themselves. A caller that asks for every
-- branch is an HQ user; anyone else is quietly scoped to their own branch,
-- exactly like the rest of the app.

CREATE INDEX IF NOT EXISTS idx_inventory_items_product_status
  ON public.inventory_items (product_id, status);
CREATE INDEX IF NOT EXISTS idx_installments_open_due
  ON public.installments (due_date) WHERE cancelled = false;
CREATE INDEX IF NOT EXISTS idx_installments_plan ON public.installments (plan_id);
CREATE INDEX IF NOT EXISTS idx_sales_customer ON public.sales (customer_id);

-- ---------------------------------------------------------------------------
-- 1. Stock on hand, per branch and model
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.stock_on_hand(_branch uuid)
RETURNS TABLE(
  branch_id uuid, product_id uuid, brand text, model text, variant text,
  qty bigint, cost_value numeric, retail_value numeric)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE b uuid;
BEGIN
  b := _branch;
  IF b IS NULL THEN
    -- No branch given: HQ sees every branch, everyone else sees only theirs.
    IF public.is_hq(auth.uid()) THEN
      b := NULL; -- every branch
    ELSE
      b := public.user_branch(auth.uid());
      IF b IS NULL THEN RAISE EXCEPTION 'No branch is assigned to your account'; END IF;
    END IF;
  ELSIF NOT public.can_access_branch(auth.uid(), b) THEN
    RAISE EXCEPTION 'Not allowed for this branch';
  END IF;

  RETURN QUERY
  SELECT i.branch_id,
         p.id,
         p.brand,
         p.model,
         p.variant,
         count(*)::bigint,
         sum(i.purchase_price)::numeric,
         sum(p.sale_price)::numeric
    FROM public.inventory_items i
    JOIN public.products p ON p.id = i.product_id
   WHERE i.status = 'in_stock'
     AND (b IS NULL OR i.branch_id = b)
   GROUP BY i.branch_id, p.id, p.brand, p.model, p.variant
   ORDER BY p.brand, p.model;
END $$;
REVOKE ALL ON FUNCTION public.stock_on_hand(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.stock_on_hand(uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- 2. Low stock — products whose in-stock count fell below the reorder level
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.low_stock_products(_branch uuid)
RETURNS TABLE(
  product_id uuid, brand text, model text, variant text,
  min_stock integer, in_stock integer, shortage integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE b uuid;
BEGIN
  b := _branch;
  IF b IS NULL THEN
    IF public.is_hq(auth.uid()) THEN
      b := NULL; -- every branch
    ELSE
      b := public.user_branch(auth.uid());
      IF b IS NULL THEN RAISE EXCEPTION 'No branch is assigned to your account'; END IF;
    END IF;
  ELSIF NOT public.can_access_branch(auth.uid(), b) THEN
    RAISE EXCEPTION 'Not allowed for this branch';
  END IF;

  RETURN QUERY
  WITH counted AS (
    SELECT p.id AS pid, p.brand, p.model, p.variant, p.min_stock,
           (SELECT count(*)::integer FROM public.inventory_items i
             WHERE i.product_id = p.id
               AND i.status = 'in_stock'
               AND (b IS NULL OR i.branch_id = b)) AS qty
      FROM public.products p
     WHERE p.min_stock > 0
  )
  SELECT pid, brand, model, variant, min_stock, qty, (min_stock - qty)::integer
    FROM counted
   WHERE qty < min_stock
   ORDER BY (min_stock - qty) DESC, brand, model;
END $$;
REVOKE ALL ON FUNCTION public.low_stock_products(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.low_stock_products(uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- 3. Kisti ageing — how old the unpaid installments are
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.kisti_ageing(_branch uuid)
RETURNS TABLE(bucket text, cnt bigint, total numeric)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE b uuid;
BEGIN
  b := _branch;
  IF b IS NULL THEN
    IF public.is_hq(auth.uid()) THEN
      b := NULL; -- every branch
    ELSE
      b := public.user_branch(auth.uid());
      IF b IS NULL THEN RAISE EXCEPTION 'No branch is assigned to your account'; END IF;
    END IF;
  ELSIF NOT public.can_access_branch(auth.uid(), b) THEN
    RAISE EXCEPTION 'Not allowed for this branch';
  END IF;

  RETURN QUERY
  WITH open_due AS (
    SELECT (i.amount - i.paid_amount) AS due, i.due_date
      FROM public.installments i
     WHERE i.cancelled = false
       AND i.paid_amount < i.amount
       AND (b IS NULL OR i.branch_id = b)
  ), bucketed AS (
    SELECT CASE
             WHEN due_date < current_date THEN 'overdue'
             WHEN due_date <= current_date + 30 THEN 'next_30'
             WHEN due_date <= current_date + 60 THEN 'next_60'
             ELSE 'later'
           END AS bucket,
           due
      FROM open_due
  )
  SELECT bkt.bucket, count(*)::bigint, coalesce(sum(bkt.due), 0)::numeric
    FROM bucketed bkt
   GROUP BY bkt.bucket
   ORDER BY CASE bkt.bucket
              WHEN 'overdue' THEN 0 WHEN 'next_30' THEN 1
              WHEN 'next_60' THEN 2 ELSE 3 END;
END $$;
REVOKE ALL ON FUNCTION public.kisti_ageing(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.kisti_ageing(uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- 4. Receivables — what customers still owe, per customer
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.customer_dues(_branch uuid)
RETURNS TABLE(
  customer_id uuid, name text, phone text, branch_id uuid,
  due_count bigint, due_amount numeric,
  overdue_count bigint, overdue_amount numeric, oldest_due_date date)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE b uuid;
BEGIN
  b := _branch;
  IF b IS NULL THEN
    IF public.is_hq(auth.uid()) THEN
      b := NULL; -- every branch
    ELSE
      b := public.user_branch(auth.uid());
      IF b IS NULL THEN RAISE EXCEPTION 'No branch is assigned to your account'; END IF;
    END IF;
  ELSIF NOT public.can_access_branch(auth.uid(), b) THEN
    RAISE EXCEPTION 'Not allowed for this branch';
  END IF;

  RETURN QUERY
  SELECT c.id, c.name, c.phone, c.branch_id,
         count(*)::bigint,
         coalesce(sum(i.amount - i.paid_amount), 0)::numeric,
         count(*) FILTER (WHERE i.due_date < current_date)::bigint,
         coalesce(sum(i.amount - i.paid_amount) FILTER (WHERE i.due_date < current_date), 0)::numeric,
         min(i.due_date)
    FROM public.installments i
    JOIN public.installment_plans p ON p.id = i.plan_id
    JOIN public.customers c ON c.id = p.customer_id
   WHERE i.cancelled = false
     AND i.paid_amount < i.amount
     AND (b IS NULL OR i.branch_id = b)
   GROUP BY c.id, c.name, c.phone, c.branch_id
   ORDER BY 7 DESC, 5 DESC
   LIMIT 500;
END $$;
REVOKE ALL ON FUNCTION public.customer_dues(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.customer_dues(uuid) TO authenticated;
