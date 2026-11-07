-- 0024 — daily cash and collection statement, per showroom
--
-- A showroom owner closes the day by writing nine numbers on paper: the cash
-- the till started with, today's cash sales, bank and card sales, the bKash /
-- Nagad / Rocket money that came in, credit (kisti) sales, what was collected
-- against older dues, today's expenses, what was deposited to head office, and
-- the cash left in hand. Nothing in the database could produce those nine
-- numbers: there was no opening-balance concept, no way to record an HQ
-- deposit, and the dashboard "cash balance" mixed every payment method and
-- every day into one lump.
--
-- The cash identity that has to hold, and that this function checks:
--   closing = opening + cash sales + cash collections - cash expenses - HQ deposit
-- Anything a till physically holds is only cash, so bank, card and wallet
-- money is reported separately and never added to the closing figure.

-- ---------------------------------------------------------------------------
-- 1. The day's opening and the physical count, one row per branch per day
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.daily_cash_records (
  branch_id uuid NOT NULL REFERENCES public.branches(id) ON DELETE CASCADE,
  day date NOT NULL,
  opening_cash numeric(12,2) NOT NULL DEFAULT 0 CHECK (opening_cash >= 0),
  counted_cash numeric(12,2) CHECK (counted_cash IS NULL OR counted_cash >= 0),
  note text,
  created_by uuid,
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (branch_id, day)
);
GRANT SELECT ON public.daily_cash_records TO authenticated;
GRANT ALL ON public.daily_cash_records TO service_role;
ALTER TABLE public.daily_cash_records ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "branch can read daily cash" ON public.daily_cash_records;
CREATE POLICY "branch can read daily cash" ON public.daily_cash_records FOR SELECT TO authenticated
  USING (public.can_access_branch(auth.uid(), branch_id));
-- Writes go through save_daily_cash_opening(); the browser gets no INSERT/UPDATE.
REVOKE INSERT, UPDATE, DELETE ON public.daily_cash_records FROM authenticated;

-- ---------------------------------------------------------------------------
-- 2. A deposit to head office is an expense of the till, never a free-typed row
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_hq_deposit(_branch uuid, _amount numeric, _method text, _note text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE tx_id uuid; m text;
BEGIN
  IF NOT public.can_operate_branch(auth.uid(), _branch) THEN RAISE EXCEPTION 'Not allowed for this branch'; END IF;
  IF _amount IS NULL OR _amount <= 0 THEN RAISE EXCEPTION 'Amount must be greater than zero'; END IF;
  m := coalesce(nullif(trim(_method), ''), 'cash');
  IF m NOT IN ('cash','bank','bkash','nagad','rocket','card','cheque','online') THEN
    RAISE EXCEPTION 'Unknown payment method %', m;
  END IF;
  INSERT INTO public.transactions (branch_id, kind, category, amount, note, ref_id, method, created_by)
  VALUES (_branch, 'expense', 'HQ deposit', _amount, nullif(trim(_note), ''), NULL, m, auth.uid())
  RETURNING id INTO tx_id;
  INSERT INTO public.audit_logs (user_id, action, details)
    VALUES (auth.uid(), 'record_hq_deposit', jsonb_build_object(
      'transaction', tx_id, 'branch', _branch, 'amount', _amount, 'method', m, 'note', nullif(trim(_note), '')));
  RETURN tx_id;
END $$;
REVOKE ALL ON FUNCTION public.record_hq_deposit(uuid, numeric, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_hq_deposit(uuid, numeric, text, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- 3. Save the opening balance and, at the end of the day, the counted cash
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.save_daily_cash_opening(
  _branch uuid, _day date, _opening numeric, _counted numeric, _note text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE d date;
BEGIN
  IF NOT public.can_operate_branch(auth.uid(), _branch) THEN RAISE EXCEPTION 'Not allowed for this branch'; END IF;
  -- The same people who may post an income entry may set the till's opening.
  IF NOT public.can_write_hq(auth.uid())
     AND NOT (public.user_branch(auth.uid()) = _branch
              AND (public.has_role(auth.uid(), 'accountant')
                   OR public.has_role(auth.uid(), 'branch_manager'))) THEN
    RAISE EXCEPTION 'Only an accountant, branch manager or admin can set the daily cash opening';
  END IF;
  d := coalesce(_day, (now() AT TIME ZONE 'Asia/Dhaka')::date);
  -- Both bounds, never a single comparison: NaN fails every comparison, so a
  -- plain "< 0" test lets it through, and this server has no isfinite(numeric).
  IF _opening IS NOT NULL AND NOT (_opening >= 0 AND _opening <= 9999999999.99) THEN
    RAISE EXCEPTION 'Opening cash must be a real amount of zero or more';
  END IF;
  IF _counted IS NOT NULL AND NOT (_counted >= 0 AND _counted <= 9999999999.99) THEN
    RAISE EXCEPTION 'Counted cash must be a real amount of zero or more';
  END IF;
  INSERT INTO public.daily_cash_records (branch_id, day, opening_cash, counted_cash, note, created_by, updated_by)
  VALUES (_branch, d, coalesce(_opening, 0), _counted, nullif(trim(_note), ''), auth.uid(), auth.uid())
  ON CONFLICT (branch_id, day) DO UPDATE
    SET opening_cash = coalesce(_opening, public.daily_cash_records.opening_cash),
        counted_cash = CASE WHEN _counted IS NULL AND _opening IS NOT NULL
                            THEN public.daily_cash_records.counted_cash ELSE _counted END,
        note         = coalesce(nullif(trim(_note), ''), public.daily_cash_records.note),
        updated_by   = auth.uid(),
        updated_at   = now();
  INSERT INTO public.audit_logs (user_id, action, details)
    VALUES (auth.uid(), 'save_daily_cash_opening', jsonb_build_object(
      'branch', _branch, 'day', d, 'opening', _opening, 'counted', _counted));
END $$;
REVOKE ALL ON FUNCTION public.save_daily_cash_opening(uuid, date, numeric, numeric, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_daily_cash_opening(uuid, date, numeric, numeric, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- 4. The statement itself
--
-- When nobody typed an opening balance for the day, the most recent one before
-- it is carried forward, so the book stays continuous without daily entry.
-- Everything is bucketed by the Dhaka calendar day, because the server runs on
-- UTC and a six-hour offset would otherwise split one showroom day across two.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.daily_cash_reconciliation(uuid, date);
CREATE OR REPLACE FUNCTION public.daily_cash_reconciliation(_branch uuid, _day date)
RETURNS TABLE(
  branch_id uuid, day date,
  opening_cash numeric,
  cash_sales numeric, bank_card_sales numeric, mfs_sales numeric,
  credit_sales numeric,
  collections numeric, cash_collections numeric, mfs_collections numeric,
  other_income numeric, cash_other_income numeric,
  expenses numeric, cash_expenses numeric,
  hq_deposits numeric, cash_deposits numeric,
  closing_cash numeric, counted_cash numeric, variance numeric, balanced boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  b uuid; d date;
  v_open numeric; v_counted numeric;
  v_cash_sales numeric := 0; v_bank_sales numeric := 0; v_mfs_sales numeric := 0;
  v_credit numeric := 0;
  v_coll numeric := 0; v_coll_cash numeric := 0; v_coll_mfs numeric := 0;
  v_other numeric := 0; v_other_cash numeric := 0;
  v_exp numeric := 0; v_exp_cash numeric := 0; v_dep numeric := 0; v_dep_cash numeric := 0;
  v_close numeric;
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
  d := coalesce(_day, (now() AT TIME ZONE 'Asia/Dhaka')::date);

  -- Today's money movements, split by where the cash actually landed. The day
  -- boundary is the Dhaka calendar day, not the server's UTC one.
  --
  -- A cash sale and the down payment of a credit sale are the same thing to
  -- the till — money in, method attached — so both feed the sales buckets.
  -- Anything else that brought cash in (a service charge, a partner receipt)
  -- has to reach the closing figure too, or the book quietly disagrees with
  -- the money in the drawer.
  SELECT
    coalesce(sum(t.amount) FILTER (WHERE t.kind = 'income'
                                   AND t.category IN ('Sales','Down payment')
                                   AND t.method = 'cash'), 0),
    coalesce(sum(t.amount) FILTER (WHERE t.kind = 'income'
                                   AND t.category IN ('Sales','Down payment')
                                   AND t.method IN ('bank','card','cheque')), 0),
    coalesce(sum(t.amount) FILTER (WHERE t.kind = 'income'
                                   AND t.category IN ('Sales','Down payment')
                                   AND t.method IN ('bkash','nagad','rocket')), 0),
    coalesce(sum(t.amount) FILTER (WHERE t.kind = 'income' AND t.category = 'Installment'), 0),
    coalesce(sum(t.amount) FILTER (WHERE t.kind = 'income' AND t.category = 'Installment'
                                   AND t.method = 'cash'), 0),
    coalesce(sum(t.amount) FILTER (WHERE t.kind = 'income' AND t.category = 'Installment'
                                   AND t.method IN ('bkash','nagad','rocket')), 0),
    coalesce(sum(t.amount) FILTER (WHERE t.kind = 'income'
                                   AND t.category NOT IN ('Sales','Down payment','Installment')), 0),
    coalesce(sum(t.amount) FILTER (WHERE t.kind = 'income'
                                   AND t.category NOT IN ('Sales','Down payment','Installment')
                                   AND t.method = 'cash'), 0),
    coalesce(sum(t.amount) FILTER (WHERE t.kind = 'expense' AND t.category <> 'HQ deposit'), 0),
    coalesce(sum(t.amount) FILTER (WHERE t.kind = 'expense' AND t.category <> 'HQ deposit'
                                   AND t.method = 'cash'), 0),
    coalesce(sum(t.amount) FILTER (WHERE t.kind = 'expense' AND t.category = 'HQ deposit'), 0),
    coalesce(sum(t.amount) FILTER (WHERE t.kind = 'expense' AND t.category = 'HQ deposit'
                                   AND t.method = 'cash'), 0)
    INTO v_cash_sales, v_bank_sales, v_mfs_sales,
         v_coll, v_coll_cash, v_coll_mfs,
         v_other, v_other_cash,
         v_exp, v_exp_cash, v_dep, v_dep_cash
  FROM public.transactions t
  WHERE (b IS NULL OR t.branch_id = b)
    AND (t.created_at AT TIME ZONE 'Asia/Dhaka')::date = d;

  -- 5. What was sold on credit today — the financed part still to collect. Its
  --    down payment is already counted in cash_sales above, so only the
  --    remaining promise is reported here.
  SELECT coalesce(sum(s.total - s.paid), 0) INTO v_credit
    FROM public.sales s
   WHERE (b IS NULL OR s.branch_id = b)
     AND s.sale_type = 'installment'
     AND (s.created_at AT TIME ZONE 'Asia/Dhaka')::date = d;

  -- 1. The opening balance. When today has no record yet, the most recent
  --    earlier one is carried forward, so a branch that only writes the
  --    opening on the first day of business keeps a continuous book.
  v_open := 0;
  IF b IS NOT NULL THEN
    SELECT coalesce(max(x.opening_cash) FILTER (WHERE x.day = d),
                    (SELECT y.opening_cash FROM public.daily_cash_records y
                      WHERE y.branch_id = b AND y.day < d
                   ORDER BY y.day DESC LIMIT 1), 0)
      INTO v_open
      FROM public.daily_cash_records x WHERE x.branch_id = b AND x.day <= d;
    SELECT x.counted_cash INTO v_counted
      FROM public.daily_cash_records x WHERE x.branch_id = b AND x.day = d;
  END IF;

  -- The drawer only ever holds cash, so the identity is built from the cash
  -- column of every line and nothing else:
  --   closing = opening + cash sales + cash collections + other cash in
  --             - cash expenses - cash paid to head office
  v_close := v_open + v_cash_sales + v_coll_cash + v_other_cash
             - v_exp_cash - v_dep_cash;

  RETURN QUERY SELECT
    b, d,
    v_open::numeric,
    v_cash_sales::numeric, v_bank_sales::numeric, v_mfs_sales::numeric,
    v_credit::numeric,
    v_coll::numeric, v_coll_cash::numeric, v_coll_mfs::numeric,
    v_other::numeric, v_other_cash::numeric,
    v_exp::numeric, v_exp_cash::numeric,
    v_dep::numeric, v_dep_cash::numeric,
    v_close::numeric,
    -- A day nobody has counted has no counted figure, which is a different
    -- thing from a day counted at zero — so it stays NULL instead of becoming
    -- 0 and looking like a missing drawer.
    v_counted::numeric,
    (v_counted - v_close)::numeric,
    -- Without a physical count there is nothing to reconcile against, so the
    -- day is only called balanced once the till has actually been counted.
    (v_counted IS NOT NULL AND abs(v_counted - v_close) < 0.005);
END $$;
REVOKE ALL ON FUNCTION public.daily_cash_reconciliation(uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.daily_cash_reconciliation(uuid, date) TO authenticated;
