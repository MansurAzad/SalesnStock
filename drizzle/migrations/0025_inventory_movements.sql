-- 0025 — the stock movement ledger and the reconciliation statement
--
-- The showroom owner's stock book has nine columns: opening, received,
-- transfer in, transfer out, sales, sales return, purchase return, damage and
-- closing. None of it could be produced, because inventory_items only keeps
-- the status an IMEI is in right now — every earlier state was overwritten. A
-- phone that was bought, transferred, sold, returned and sold again looks
-- exactly like one that was simply bought and sold.
--
-- Rather than change every RPC, one AFTER trigger on inventory_items watches
-- the status and branch columns. Every path that already exists — purchases,
-- POS sales, returns, transfers, cancellations, damage, the offline queue —
-- moves stock through those two columns, so all of them are captured without
-- touching a single function, and a future code path cannot be forgotten.
--
-- Damage and adjustments go on their own numbered voucher, as the requirement
-- asks. The function that makes one hands the reason and voucher number to the
-- trigger through a transaction-local setting.

-- ---------------------------------------------------------------------------
-- 1. The ledger
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.inventory_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id uuid NOT NULL REFERENCES public.inventory_items(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES public.products(id),
  branch_id uuid NOT NULL REFERENCES public.branches(id),
  movement_type text NOT NULL CHECK (movement_type IN
    ('opening','receive','transfer_in','transfer_out','transfer_cancel',
     'sale','sale_return','purchase_return','damage','damage_restore','adjustment')),
  -- Already signed: +1 brings the phone into the sellable stock of a branch,
  -- -1 takes it out, so the statement is a plain sum and never needs a CASE.
  qty integer NOT NULL CHECK (qty <> 0),
  imei text NOT NULL,
  ref_type text,
  ref_id uuid,
  voucher_no text,
  reason text,
  moved_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  source text NOT NULL DEFAULT 'auto' CHECK (source IN ('auto','backfill'))
);
CREATE INDEX IF NOT EXISTS idx_inv_mv_branch_time
  ON public.inventory_movements (branch_id, moved_at);
CREATE INDEX IF NOT EXISTS idx_inv_mv_product_time
  ON public.inventory_movements (branch_id, product_id, moved_at);
CREATE INDEX IF NOT EXISTS idx_inv_mv_item ON public.inventory_movements (item_id);
CREATE INDEX IF NOT EXISTS idx_inv_mv_ref ON public.inventory_movements (ref_id);

-- moved_at is the transaction timestamp, so every line written by one document
-- shares it. The trail of a single phone still has to come out in the order it
-- happened, which is what this counter is for.
ALTER TABLE public.inventory_movements
  ADD COLUMN IF NOT EXISTS seq bigint GENERATED ALWAYS AS IDENTITY;

GRANT SELECT ON public.inventory_movements TO authenticated;
GRANT ALL ON public.inventory_movements TO service_role;
ALTER TABLE public.inventory_movements ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "branch can read movements" ON public.inventory_movements;
CREATE POLICY "branch can read movements" ON public.inventory_movements FOR SELECT TO authenticated
  USING (public.can_access_branch(auth.uid(), branch_id));
-- Only the trigger and the SECURITY DEFINER functions write here.
REVOKE INSERT, UPDATE, DELETE ON public.inventory_movements FROM authenticated;

-- ---------------------------------------------------------------------------
-- 2. The voucher context a function can hand to the trigger
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.inventory_movement_context(_ref_type text, _reason text, _voucher text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  -- is_local: the setting dies with the transaction, so a pooled connection
  -- can never carry one showroom's voucher into another's statement.
  PERFORM set_config('erp.movement_ref_type', coalesce(_ref_type, ''), true);
  PERFORM set_config('erp.movement_reason', coalesce(_reason, ''), true);
  PERFORM set_config('erp.movement_voucher', coalesce(_voucher, ''), true);
END $$;
REVOKE ALL ON FUNCTION public.inventory_movement_context(text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.inventory_movement_context(text, text, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.take_inventory_movement_context()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v jsonb;
BEGIN
  v := jsonb_build_object(
    'ref_type', nullif(current_setting('erp.movement_ref_type', true), ''),
    'reason',   nullif(current_setting('erp.movement_reason', true), ''),
    'voucher',  nullif(current_setting('erp.movement_voucher', true), ''));
  PERFORM set_config('erp.movement_ref_type', '', true);
  PERFORM set_config('erp.movement_reason', '', true);
  PERFORM set_config('erp.movement_voucher', '', true);
  RETURN v;
END $$;
REVOKE ALL ON FUNCTION public.take_inventory_movement_context() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.take_inventory_movement_context() TO authenticated;

-- ---------------------------------------------------------------------------
-- 3. The trigger
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.inventory_record_movement() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  ctx jsonb; v_type text; v_qty int; v_branch uuid; v_ref_type text; v_ref_id uuid;
BEGIN
  ctx := public.take_inventory_movement_context();

  IF TG_OP = 'INSERT' THEN
    v_type := 'receive'; v_qty := 1; v_branch := NEW.branch_id;
  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
    -- An adjustment is the one event the status alone cannot name: the same
    -- 'returned' status is a supplier return on a purchase and a counted-away
    -- phone on an adjustment voucher. The calling function says which.
    IF ctx->>'ref_type' = 'adjustment' THEN
      v_type := 'adjustment';
      v_qty := CASE WHEN NEW.status = 'in_stock' THEN 1 ELSE -1 END;
      v_branch := NEW.branch_id;
    ELSIF NEW.status = 'in_transit' THEN
      v_type := 'transfer_out'; v_qty := -1; v_branch := OLD.branch_id;
    ELSIF OLD.status = 'in_transit' AND NEW.branch_id IS DISTINCT FROM OLD.branch_id THEN
      v_type := 'transfer_in'; v_qty := 1; v_branch := NEW.branch_id;
    ELSIF OLD.status = 'in_transit' THEN
      -- A cancelled transfer never left the shelf, so the stock simply returns.
      v_type := 'transfer_cancel'; v_qty := 1; v_branch := NEW.branch_id;
    ELSIF NEW.status = 'sold' THEN
      v_type := 'sale'; v_qty := -1; v_branch := NEW.branch_id;
    ELSIF NEW.status = 'returned' THEN
      v_type := 'purchase_return'; v_qty := -1; v_branch := NEW.branch_id;
    ELSIF NEW.status = 'damaged' THEN
      -- A damaged phone is off the sellable shelf even though it is still in
      -- the shop, which is why it counts as an outgoing movement.
      v_type := 'damage'; v_qty := -1; v_branch := NEW.branch_id;
    ELSIF NEW.status = 'in_stock' AND OLD.status = 'sold' THEN
      v_type := 'sale_return'; v_qty := 1; v_branch := NEW.branch_id;
    ELSIF NEW.status = 'in_stock' AND OLD.status = 'damaged' THEN
      v_type := 'damage_restore'; v_qty := 1; v_branch := NEW.branch_id;
    ELSE
      RETURN NULL;
    END IF;
  ELSIF NEW.branch_id IS DISTINCT FROM OLD.branch_id THEN
    -- Stock that changes branch with no transfer is a correction, and belongs
    -- on the adjustment line of both statements.
    INSERT INTO public.inventory_movements
      (item_id, product_id, branch_id, movement_type, qty, imei, ref_type, voucher_no, reason,
       moved_at, created_by, source)
    VALUES (NEW.id, NEW.product_id, OLD.branch_id, 'adjustment', -1, NEW.imei, 'correction',
            coalesce(ctx->>'voucher', 'ADJ-' || to_char(now(), 'YYMMDD') || '-' || substr(gen_random_uuid()::text, 1, 6)),
            ctx->>'reason', now(), auth.uid(), 'auto');
    v_type := 'adjustment'; v_qty := 1; v_branch := NEW.branch_id;
  ELSE
    RETURN NULL;
  END IF;

  -- Which document caused this? The newest one that names the phone, unless
  -- the calling function already said so through the context.
  v_ref_type := ctx->>'ref_type';
  IF v_ref_type IS NULL THEN
    IF v_type IN ('sale','sale_return') THEN
      SELECT 'sale', si.sale_id INTO v_ref_type, v_ref_id
        FROM public.sale_items si WHERE si.item_id = NEW.id ORDER BY si.id DESC LIMIT 1;
    ELSIF v_type IN ('transfer_in','transfer_out','transfer_cancel') THEN
      SELECT 'transfer', ti.transfer_id INTO v_ref_type, v_ref_id
        FROM public.transfer_items ti WHERE ti.item_id = NEW.id ORDER BY ti.id DESC LIMIT 1;
    ELSIF v_type = 'receive' OR v_type = 'purchase_return' THEN
      SELECT 'purchase', pi.purchase_id INTO v_ref_type, v_ref_id
        FROM public.purchase_items pi WHERE pi.item_id = NEW.id ORDER BY pi.id DESC LIMIT 1;
    END IF;
  END IF;

  INSERT INTO public.inventory_movements
    (item_id, product_id, branch_id, movement_type, qty, imei, ref_type, ref_id,
     voucher_no, reason, moved_at, created_by, source)
  VALUES (NEW.id, NEW.product_id, v_branch, v_type, v_qty, NEW.imei,
          v_ref_type, v_ref_id, ctx->>'voucher', ctx->>'reason', now(), auth.uid(), 'auto');
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS tr_inventory_record_movement ON public.inventory_items;
CREATE TRIGGER tr_inventory_record_movement
  AFTER INSERT OR UPDATE OF status, branch_id ON public.inventory_items
  FOR EACH ROW EXECUTE FUNCTION public.inventory_record_movement();

-- ---------------------------------------------------------------------------
-- 3b. Link a bought phone to the purchase that paid for it
--
-- create_purchase() writes the phone first and its purchase line right after,
-- so the receive row exists before the document behind it does. One trigger on
-- the purchase line closes that gap for every path that buys stock, offline
-- replays included, instead of asking each function to remember it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.link_purchase_movement() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.inventory_movements
     SET ref_type = 'purchase', ref_id = NEW.purchase_id
   WHERE item_id = NEW.item_id AND movement_type = 'receive' AND ref_id IS NULL;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.link_purchase_movement() FROM PUBLIC, anon;

DROP TRIGGER IF EXISTS tr_purchase_items_link_movement ON public.purchase_items;
CREATE TRIGGER tr_purchase_items_link_movement
  AFTER INSERT ON public.purchase_items
  FOR EACH ROW EXECUTE FUNCTION public.link_purchase_movement();

-- ---------------------------------------------------------------------------
-- 4. Damage on its own numbered voucher
-- ---------------------------------------------------------------------------
-- Both functions now answer with the voucher number they wrote, which means
-- the return type changed and Postgres needs the old signature dropped first.
DROP FUNCTION IF EXISTS public.mark_inventory_damaged(uuid, text);
CREATE OR REPLACE FUNCTION public.mark_inventory_damaged(_item uuid, _reason text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE i public.inventory_items; v_no text;
BEGIN
  SELECT * INTO i FROM public.inventory_items WHERE id = _item FOR UPDATE;
  IF i.id IS NULL OR i.status <> 'in_stock' THEN RAISE EXCEPTION 'Only in-stock items can be marked damaged'; END IF;
  IF NOT public.can_approve_branch(auth.uid(), i.branch_id) THEN RAISE EXCEPTION 'Only the branch manager or admin can update damage status'; END IF;
  IF coalesce(trim(_reason), '') = '' THEN RAISE EXCEPTION 'Damage reason is required'; END IF;
  v_no := 'DMG-' || to_char(now(), 'YYMMDD') || '-' || substr(gen_random_uuid()::text, 1, 6);
  PERFORM public.inventory_movement_context('damage', trim(_reason), v_no);
  UPDATE public.inventory_items SET status = 'damaged' WHERE id = _item;
  INSERT INTO public.audit_logs (user_id, action, details)
    VALUES (auth.uid(), 'mark_inventory_damaged',
            jsonb_build_object('item', _item, 'imei', i.imei, 'reason', trim(_reason), 'voucher', v_no));
  RETURN v_no;
END $$;

DROP FUNCTION IF EXISTS public.restore_damaged_inventory(uuid, text);
CREATE OR REPLACE FUNCTION public.restore_damaged_inventory(_item uuid, _reason text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE i public.inventory_items; v_no text;
BEGIN
  SELECT * INTO i FROM public.inventory_items WHERE id = _item FOR UPDATE;
  IF i.id IS NULL OR i.status <> 'damaged' THEN RAISE EXCEPTION 'Only damaged items can be restored'; END IF;
  IF NOT public.can_approve_branch(auth.uid(), i.branch_id) THEN RAISE EXCEPTION 'Only the branch manager or admin can restore stock'; END IF;
  IF coalesce(trim(_reason), '') = '' THEN RAISE EXCEPTION 'Restoration reason is required'; END IF;
  v_no := 'DMG-' || to_char(now(), 'YYMMDD') || '-' || substr(gen_random_uuid()::text, 1, 6);
  PERFORM public.inventory_movement_context('damage_restore', trim(_reason), v_no);
  UPDATE public.inventory_items SET status = 'in_stock' WHERE id = _item;
  INSERT INTO public.audit_logs (user_id, action, details)
    VALUES (auth.uid(), 'restore_damaged_inventory',
            jsonb_build_object('item', _item, 'imei', i.imei, 'reason', trim(_reason), 'voucher', v_no));
  RETURN v_no;
END $$;

-- ---------------------------------------------------------------------------
-- 5. Stock adjustment — a counted shelf that disagrees with the system
-- ---------------------------------------------------------------------------
-- The direction is what the count proved, not what somebody hopes: 'remove'
-- retires a phone the shelf has lost, 'add' brings back one that was written
-- off by mistake. Only the person who may approve a branch's stock may do
-- either, and a reason is never optional.
CREATE OR REPLACE FUNCTION public.adjust_inventory(_item uuid, _direction text, _reason text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE i public.inventory_items; v_no text;
BEGIN
  IF _direction NOT IN ('add','remove') THEN RAISE EXCEPTION 'Direction must be add or remove'; END IF;
  IF coalesce(trim(_reason), '') = '' THEN RAISE EXCEPTION 'A reason is required for a stock adjustment'; END IF;
  SELECT * INTO i FROM public.inventory_items WHERE id = _item FOR UPDATE;
  IF i.id IS NULL THEN RAISE EXCEPTION 'Item not found'; END IF;
  IF NOT public.can_approve_branch(auth.uid(), i.branch_id) THEN
    RAISE EXCEPTION 'Only the branch manager or admin can adjust stock';
  END IF;
  v_no := 'ADJ-' || to_char(now(), 'YYMMDD') || '-' || substr(gen_random_uuid()::text, 1, 6);
  IF _direction = 'remove' THEN
    IF i.status = 'sold' THEN RAISE EXCEPTION 'That phone is already sold — use a sales return instead'; END IF;
    IF i.status = 'in_transit' THEN RAISE EXCEPTION 'That phone is between branches — receive or cancel the transfer first'; END IF;
    IF i.status = 'damaged' THEN RAISE EXCEPTION 'That phone is already on a damage voucher'; END IF;
    IF i.status = 'returned' THEN RAISE EXCEPTION 'That phone is already out of stock'; END IF;
    PERFORM public.inventory_movement_context('adjustment', trim(_reason), v_no);
    UPDATE public.inventory_items SET status = 'returned' WHERE id = _item;
  ELSE
    IF i.status <> 'returned' THEN
      RAISE EXCEPTION 'Only a phone that was written off can be added back — damage and sales have their own vouchers';
    END IF;
    PERFORM public.inventory_movement_context('adjustment', trim(_reason), v_no);
    UPDATE public.inventory_items SET status = 'in_stock' WHERE id = _item;
  END IF;
  INSERT INTO public.audit_logs (user_id, action, details)
    VALUES (auth.uid(), 'adjust_inventory', jsonb_build_object(
      'item', _item, 'imei', i.imei, 'direction', _direction, 'reason', trim(_reason), 'voucher', v_no));
  RETURN v_no;
END $$;
REVOKE ALL ON FUNCTION public.adjust_inventory(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.adjust_inventory(uuid, text, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- 6. Backfill the ledger from the documents that already exist
--
-- Inserted so the running balance from the very first day matches what the
-- shelves have always shown. The date a returned sale came back was never
-- stored anywhere, so the return is booked on its invoice date — the totals
-- and the current position stay exact, only that one row can sit on an earlier
-- day than it really happened.
--
-- The whole section runs once: re-applying this file must not double the
-- ledger, so it stops as soon as any backfilled row is already there.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.inventory_movements WHERE source = 'backfill') THEN
    RETURN;
  END IF;

  INSERT INTO public.inventory_movements
  (item_id, product_id, branch_id, movement_type, qty, imei, ref_type, ref_id,
   moved_at, source)
SELECT i.id, i.product_id, i.branch_id, 'receive', 1, i.imei,
       'purchase', pi.purchase_id, i.created_at, 'backfill'
  FROM public.inventory_items i
  LEFT JOIN LATERAL (
    SELECT q.purchase_id FROM public.purchase_items q
     WHERE q.item_id = i.id ORDER BY q.id DESC LIMIT 1
  ) pi ON TRUE;

INSERT INTO public.inventory_movements
  (item_id, product_id, branch_id, movement_type, qty, imei, ref_type, ref_id,
   moved_at, source)
SELECT si.item_id, i.product_id, s.branch_id, 'sale', -1, i.imei,
       'sale', s.id, s.created_at, 'backfill'
  FROM public.sale_items si
  JOIN public.sales s ON s.id = si.sale_id
  JOIN public.inventory_items i ON i.id = si.item_id;

-- Every sale of the phone except the one it is still sitting behind.
INSERT INTO public.inventory_movements
  (item_id, product_id, branch_id, movement_type, qty, imei, ref_type, ref_id,
   moved_at, source)
SELECT x.item_id, i.product_id, x.branch_id, 'sale_return', 1, i.imei,
       'sale', x.sale_id, x.created_at, 'backfill'
  FROM (
    SELECT si.item_id, si.sale_id, s.branch_id, s.created_at,
           row_number() OVER (PARTITION BY si.item_id ORDER BY si.id DESC) AS newest
      FROM public.sale_items si
      JOIN public.sales s ON s.id = si.sale_id
  ) x
  JOIN public.inventory_items i ON i.id = x.item_id
 WHERE i.status <> 'sold' OR x.newest > 1;

INSERT INTO public.inventory_movements
  (item_id, product_id, branch_id, movement_type, qty, imei, ref_type, ref_id,
   moved_at, source)
SELECT pi.item_id, i.product_id, p.branch_id, 'purchase_return', -1, i.imei,
       'purchase', p.id, p.created_at, 'backfill'
  FROM public.purchase_items pi
  JOIN public.purchases p ON p.id = pi.purchase_id
  JOIN public.inventory_items i ON i.id = pi.item_id
 WHERE pi.returned = true;

INSERT INTO public.inventory_movements
  (item_id, product_id, branch_id, movement_type, qty, imei, ref_type, ref_id,
   moved_at, created_by, source)
SELECT ti.item_id, i.product_id, t.from_branch_id, 'transfer_out', -1, i.imei,
       'transfer', t.id, t.created_at, t.created_by, 'backfill'
  FROM public.transfer_items ti
  JOIN public.stock_transfers t ON t.id = ti.transfer_id
  JOIN public.inventory_items i ON i.id = ti.item_id;

INSERT INTO public.inventory_movements
  (item_id, product_id, branch_id, movement_type, qty, imei, ref_type, ref_id,
   moved_at, created_by, source)
SELECT ti.item_id, i.product_id, t.to_branch_id,
       CASE WHEN t.status = 'received' THEN 'transfer_in' ELSE 'transfer_cancel' END,
       1, i.imei, 'transfer', t.id,
       CASE WHEN t.status = 'received' THEN t.received_at ELSE now() END,
       CASE WHEN t.status = 'received' THEN t.received_by ELSE t.created_by END, 'backfill'
  FROM public.transfer_items ti
  JOIN public.stock_transfers t ON t.id = ti.transfer_id
  JOIN public.inventory_items i ON i.id = ti.item_id
 WHERE t.status <> 'in_transit';

INSERT INTO public.inventory_movements
  (item_id, product_id, branch_id, movement_type, qty, imei, ref_type,
   reason, moved_at, source)
SELECT i.id, i.product_id, i.branch_id, 'damage', -1, i.imei, 'damage',
       coalesce(d.reason, 'Damaged before the movement ledger existed'),
       coalesce(d.at, i.created_at), 'backfill'
  FROM public.inventory_items i
  LEFT JOIN LATERAL (
    SELECT x.details->>'reason' AS reason, x.created_at AS at
      FROM public.audit_logs x
     WHERE x.action = 'mark_inventory_damaged'
       AND (x.details->>'item')::uuid = i.id
     ORDER BY x.id DESC LIMIT 1
  ) d ON TRUE
 WHERE i.status = 'damaged';
END $$;

-- ---------------------------------------------------------------------------
-- 7. The stock statement, per branch and model
--
--   closing = opening + receive + transfer_in - transfer_out - sales
--             + sales_return - purchase_return + adjustment - damage
--             + damage_restore
-- which is the showroom book formula with the damage lines kept on their own
-- vouchers, exactly as asked. The last two columns prove the ledger against
-- the shelf, so a book that drifted is visible instead of quiet.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.stock_reconciliation(
  _branch uuid, _from date, _to date)
RETURNS TABLE(
  branch_id uuid, product_id uuid, brand text, model text, variant text,
  opening bigint, receive bigint, transfer_in bigint, transfer_out bigint,
  sales bigint, sales_return bigint, purchase_return bigint, damage bigint,
  damage_restore bigint, adjustment bigint, closing bigint, on_shelf bigint,
  matches boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE b uuid; d1 date; d2 date;
BEGIN
  b := _branch;
  IF b IS NULL THEN
    IF public.is_hq(auth.uid()) THEN b := NULL;
    ELSE
      b := public.user_branch(auth.uid());
      IF b IS NULL THEN RAISE EXCEPTION 'No branch is assigned to your account'; END IF;
    END IF;
  ELSIF NOT public.can_access_branch(auth.uid(), b) THEN
    RAISE EXCEPTION 'Not allowed for this branch';
  END IF;
  d2 := coalesce(_to, (now() AT TIME ZONE 'Asia/Dhaka')::date);
  d1 := coalesce(_from, d2);
  IF d1 > d2 THEN RAISE EXCEPTION 'The start date must not be after the end date'; END IF;

  RETURN QUERY
  WITH bucketed AS (
    SELECT m.branch_id, m.product_id,
      coalesce(sum(m.qty) FILTER (WHERE (m.moved_at AT TIME ZONE 'Asia/Dhaka')::date < d1), 0)::bigint AS opening,
      coalesce(sum(m.qty) FILTER (WHERE m.movement_type = 'receive'
              AND (m.moved_at AT TIME ZONE 'Asia/Dhaka')::date BETWEEN d1 AND d2), 0)::bigint AS receive,
      coalesce(sum(m.qty) FILTER (WHERE m.movement_type IN ('transfer_in','transfer_cancel')
              AND (m.moved_at AT TIME ZONE 'Asia/Dhaka')::date BETWEEN d1 AND d2), 0)::bigint AS transfer_in,
      coalesce(-sum(m.qty) FILTER (WHERE m.movement_type = 'transfer_out'
              AND (m.moved_at AT TIME ZONE 'Asia/Dhaka')::date BETWEEN d1 AND d2), 0)::bigint AS transfer_out,
      coalesce(-sum(m.qty) FILTER (WHERE m.movement_type = 'sale'
              AND (m.moved_at AT TIME ZONE 'Asia/Dhaka')::date BETWEEN d1 AND d2), 0)::bigint AS sales,
      coalesce(sum(m.qty) FILTER (WHERE m.movement_type = 'sale_return'
              AND (m.moved_at AT TIME ZONE 'Asia/Dhaka')::date BETWEEN d1 AND d2), 0)::bigint AS sales_return,
      coalesce(-sum(m.qty) FILTER (WHERE m.movement_type = 'purchase_return'
              AND (m.moved_at AT TIME ZONE 'Asia/Dhaka')::date BETWEEN d1 AND d2), 0)::bigint AS purchase_return,
      coalesce(-sum(m.qty) FILTER (WHERE m.movement_type = 'damage'
              AND (m.moved_at AT TIME ZONE 'Asia/Dhaka')::date BETWEEN d1 AND d2), 0)::bigint AS damage,
      coalesce(sum(m.qty) FILTER (WHERE m.movement_type = 'damage_restore'
              AND (m.moved_at AT TIME ZONE 'Asia/Dhaka')::date BETWEEN d1 AND d2), 0)::bigint AS damage_restore,
      coalesce(sum(m.qty) FILTER (WHERE m.movement_type = 'adjustment'
              AND (m.moved_at AT TIME ZONE 'Asia/Dhaka')::date BETWEEN d1 AND d2), 0)::bigint AS adjustment,
      coalesce(sum(m.qty) FILTER (WHERE (m.moved_at AT TIME ZONE 'Asia/Dhaka')::date <= d2), 0)::bigint AS closing
    FROM public.inventory_movements m
    WHERE (b IS NULL OR m.branch_id = b)
    GROUP BY m.branch_id, m.product_id
  ), on_hand AS (
    SELECT i.branch_id, i.product_id, count(*)::bigint AS shelf
      FROM public.inventory_items i
     WHERE i.status = 'in_stock' AND (b IS NULL OR i.branch_id = b)
     GROUP BY i.branch_id, i.product_id
  )
  SELECT p.branch_id, p.product_id, pr.brand, pr.model, pr.variant,
         p.opening, p.receive, p.transfer_in, p.transfer_out, p.sales,
         p.sales_return, p.purchase_return, p.damage, p.damage_restore,
         p.adjustment, p.closing,
         coalesce(o.shelf, 0)::bigint,
         (p.closing = coalesce(o.shelf, 0))
    FROM bucketed p
    JOIN public.products pr ON pr.id = p.product_id
    LEFT JOIN on_hand o ON o.branch_id = p.branch_id AND o.product_id = p.product_id
    ORDER BY pr.brand, pr.model, p.branch_id;
END $$;
REVOKE ALL ON FUNCTION public.stock_reconciliation(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.stock_reconciliation(uuid, date, date) TO authenticated;

-- ---------------------------------------------------------------------------
-- 8. The same statement one level down: every IMEI and its voucher trail
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.stock_imei_ledger(_branch uuid, _from date, _to date)
RETURNS TABLE(
  branch_id uuid, imei text, imei2 text, brand text, model text, variant text,
  movement_type text, qty integer, voucher_no text, reason text,
  ref_type text, ref_id uuid, moved_at timestamptz, status text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE b uuid; d1 date; d2 date;
BEGIN
  b := _branch;
  IF b IS NULL THEN
    IF public.is_hq(auth.uid()) THEN b := NULL;
    ELSE
      b := public.user_branch(auth.uid());
      IF b IS NULL THEN RAISE EXCEPTION 'No branch is assigned to your account'; END IF;
    END IF;
  ELSIF NOT public.can_access_branch(auth.uid(), b) THEN
    RAISE EXCEPTION 'Not allowed for this branch';
  END IF;
  d2 := coalesce(_to, (now() AT TIME ZONE 'Asia/Dhaka')::date);
  d1 := coalesce(_from, d2);
  IF d1 > d2 THEN RAISE EXCEPTION 'The start date must not be after the end date'; END IF;

  RETURN QUERY
  SELECT m.branch_id, i.imei, i.imei2, pr.brand, pr.model, pr.variant,
         m.movement_type, m.qty, m.voucher_no, m.reason, m.ref_type, m.ref_id,
         m.moved_at, i.status
    FROM public.inventory_movements m
    JOIN public.inventory_items i ON i.id = m.item_id
    JOIN public.products pr ON pr.id = m.product_id
   WHERE (b IS NULL OR m.branch_id = b)
     AND (m.moved_at AT TIME ZONE 'Asia/Dhaka')::date BETWEEN d1 AND d2
   ORDER BY i.imei, m.moved_at, m.seq
   LIMIT 5000;
END $$;
REVOKE ALL ON FUNCTION public.stock_imei_ledger(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.stock_imei_ledger(uuid, date, date) TO authenticated;
