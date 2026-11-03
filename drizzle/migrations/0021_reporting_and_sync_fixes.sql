-- 0021 — reporting and offline-sync fixes
--
-- 1. low_stock_products() could not run at all. The query reads a CTE whose
--    columns (brand, model, variant, min_stock) carry the same names as the
--    function's output columns, so PostgreSQL could not tell which one the
--    query meant and refused with
--    `column reference "brand" is ambiguous`.
--    The dashboard low-stock alert and the reports page both call this
--    function, so the whole low-stock feature was dead. Qualifying the
--    references with the CTE alias makes the query unambiguous; the returned
--    column names are unchanged, because they come from RETURNS TABLE.
--
-- 2. apply_offline_op() could not record a conflict for an unknown action.
--    The error path stores the offending kind in offline_ops.kind, but that
--    column only accepts 'sale', 'kisti' and 'expense' — so the insert hit the
--    check constraint and the whole call blew up instead of reporting a
--    conflict, exactly the case the error path exists for. A conflict row may
--    now carry any kind; an applied row still has to use one of the three
--    real kinds.

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
  SELECT c.pid, c.brand, c.model, c.variant, c.min_stock, c.qty,
         (c.min_stock - c.qty)::integer
    FROM counted c
   WHERE c.qty < c.min_stock
   ORDER BY (c.min_stock - c.qty) DESC, c.brand, c.model;
END $$;
REVOKE ALL ON FUNCTION public.low_stock_products(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.low_stock_products(uuid) TO authenticated;

ALTER TABLE public.offline_ops DROP CONSTRAINT IF EXISTS offline_ops_kind_check;
ALTER TABLE public.offline_ops ADD CONSTRAINT offline_ops_kind_check
  CHECK (status = 'conflict' OR kind IN ('sale', 'kisti', 'expense'));
