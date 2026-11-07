-- 0026 — the showroom expense book, with proof
--
-- The requirement lists ten expense heads and one rule under them: every
-- expense carries its bill, its voucher or its approval as proof. Before this
-- the category was free text, so "Rent", "Shop rent" and "rent again" were
-- three different heads and no report could total them; there was no voucher
-- number at all; and although the database stored approved_by it never stored
-- when, so the screen could not show who signed off or when.
--
-- Staff salary was the odd one: payroll wrote straight to the cash book and
-- skipped the expense table, so the Expenses screen — the one a showroom
-- manager reads — never showed the largest cost of running a shop.

-- ---------------------------------------------------------------------------
-- 1. The ten heads, and the columns that carry the proof
-- ---------------------------------------------------------------------------
ALTER TABLE public.expenses ADD COLUMN IF NOT EXISTS voucher_no text;
ALTER TABLE public.expenses ADD COLUMN IF NOT EXISTS bill_no text;
ALTER TABLE public.expenses ADD COLUMN IF NOT EXISTS approved_at timestamptz;

-- One voucher per row, so an expense can be quoted on paper.
CREATE UNIQUE INDEX IF NOT EXISTS idx_expenses_voucher_no
  ON public.expenses (voucher_no) WHERE voucher_no IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_expenses_branch_date ON public.expenses (branch_id, expense_date);

-- The date a shopkeeper means is the Dhaka day, not the server's UTC day: an
-- expense entered at 01:00 on a Sunday morning would otherwise land on
-- Saturday and disappear from the day's statement.
ALTER TABLE public.expenses
  ALTER COLUMN expense_date SET DEFAULT ((now() AT TIME ZONE 'Asia/Dhaka')::date);

-- Anything typed before the list existed has to be moved into it, or the new
-- constraint would refuse to save the row the moment somebody edited it.
UPDATE public.expenses SET category = CASE
    WHEN category ILIKE '%rent%'                        THEN 'Shop rent'
    WHEN category ILIKE '%electric%' OR category ILIKE '%utility%' THEN 'Electricity bill'
    WHEN category ILIKE '%internet%' OR category ILIKE '%phone%'   THEN 'Internet bill'
    WHEN category ILIKE '%salar%' OR category ILIKE '%staff%' OR category ILIKE '%payroll%'
                                                        THEN 'Staff salary'
    WHEN category ILIKE '%food%' OR category ILIKE '%tea%' OR category ILIKE '%snack%'
                 OR category ILIKE '%lunch%'            THEN 'Food'
    WHEN category ILIKE '%transport%' OR category ILIKE '%taxi%' OR category ILIKE '%travel%'
                                                        THEN 'Transport'
    WHEN category ILIKE '%clean%'                       THEN 'Cleaning'
    WHEN category ILIKE '%repair%' OR category ILIKE '%maintenance%'
                                                        THEN 'Repair'
    WHEN category ILIKE '%market%' OR category ILIKE '%promo%' OR category ILIKE '%advertis%'
                                                        THEN 'Marketing'
    ELSE 'Other'
  END
 WHERE category NOT IN ('Shop rent','Electricity bill','Internet bill','Staff salary','Food',
                        'Transport','Cleaning','Repair','Marketing','Other');

ALTER TABLE public.expenses DROP CONSTRAINT IF EXISTS expenses_category_check;
ALTER TABLE public.expenses ADD CONSTRAINT expenses_category_check
  CHECK (category IN ('Shop rent','Electricity bill','Internet bill','Staff salary','Food',
                      'Transport','Cleaning','Repair','Marketing','Other'));

-- transactions.category is deliberately left open: a manual income entry is
-- whatever the accountant typed, so constraining it here would break a screen
-- that is meant to be free-form. The heads above are only what the expense
-- form can file.

-- ---------------------------------------------------------------------------
-- 2. submit_expense — the voucher is issued here, never typed
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.submit_expense(uuid, text, numeric, date, text, text, text);
CREATE OR REPLACE FUNCTION public.submit_expense(
  _branch uuid, _category text, _amount numeric, _date date, _method text,
  _note text, _attachment text, _bill_no text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE lim numeric; e_id uuid; auto boolean; v_no text; m text;
BEGIN
  IF NOT public.can_operate_branch(auth.uid(), _branch) THEN RAISE EXCEPTION 'Not allowed for this branch'; END IF;
  IF _amount IS NULL OR _amount <= 0 THEN RAISE EXCEPTION 'Invalid amount'; END IF;
  IF coalesce(trim(_category), '') = '' THEN RAISE EXCEPTION 'Category is required'; END IF;
  m := coalesce(nullif(trim(_method), ''), 'cash');
  SELECT expense_limit INTO lim FROM public.branches WHERE id = _branch;
  auto := public.can_write_hq(auth.uid()) OR (public.can_approve_branch(auth.uid(), _branch) AND _amount <= lim);
  v_no := 'EXP-' || to_char(now(), 'YYMMDD') || '-' || substr(gen_random_uuid()::text, 1, 6);
  INSERT INTO public.expenses (branch_id, category, amount, expense_date, method, note,
                               attachment_url, bill_no, voucher_no, status, approved_by, approved_at, created_by)
  VALUES (_branch, trim(_category), _amount,
          coalesce(_date, (now() AT TIME ZONE 'Asia/Dhaka')::date), m, nullif(trim(_note), ''),
          nullif(_attachment, ''), nullif(trim(_bill_no), ''), v_no,
          CASE WHEN auto THEN 'approved' ELSE 'pending' END,
          CASE WHEN auto THEN auth.uid() END, CASE WHEN auto THEN now() END, auth.uid())
  RETURNING id INTO e_id;
  IF auto THEN
    INSERT INTO public.transactions (branch_id, kind, category, amount, note, ref_id, method, created_by)
    VALUES (_branch, 'expense', trim(_category), _amount, nullif(trim(_note), ''), e_id, m, auth.uid());
  END IF;
  INSERT INTO public.audit_logs (user_id, action, details)
    VALUES (auth.uid(), 'submit_expense', jsonb_build_object(
      'expense', e_id, 'voucher', v_no, 'category', trim(_category),
      'amount', _amount, 'method', m, 'auto_approved', auto));
  RETURN v_no;
END $$;
REVOKE ALL ON FUNCTION public.submit_expense(uuid, text, numeric, date, text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_expense(uuid, text, numeric, date, text, text, text, text) TO authenticated;

-- The older 7-argument call still works, so no published client breaks.
CREATE OR REPLACE FUNCTION public.submit_expense(
  _branch uuid, _category text, _amount numeric, _date date, _method text, _note text, _attachment text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN public.submit_expense(_branch, _category, _amount, _date, _method, _note, _attachment, NULL);
END $$;
REVOKE ALL ON FUNCTION public.submit_expense(uuid, text, numeric, date, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_expense(uuid, text, numeric, date, text, text, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- 3. decide_expense now leaves a dated signature
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.decide_expense(_expense uuid, _approve boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE x public.expenses;
BEGIN
  IF NOT public.can_write_hq(auth.uid()) THEN RAISE EXCEPTION 'Only admin can approve'; END IF;
  SELECT * INTO x FROM public.expenses WHERE id = _expense FOR UPDATE;
  IF x.id IS NULL OR x.status <> 'pending' THEN RAISE EXCEPTION 'Expense is not pending'; END IF;
  UPDATE public.expenses
     SET status = CASE WHEN _approve THEN 'approved' ELSE 'rejected' END,
         approved_by = auth.uid(),
         approved_at = CASE WHEN _approve THEN now() ELSE NULL END
   WHERE id = _expense;
  IF _approve THEN
    INSERT INTO public.transactions (branch_id, kind, category, amount, note, ref_id, method, created_by)
    VALUES (x.branch_id, 'expense', x.category, x.amount, x.note, x.id, x.method, auth.uid());
  END IF;
  INSERT INTO public.audit_logs (user_id, action, details)
    VALUES (auth.uid(), CASE WHEN _approve THEN 'approve_expense' ELSE 'reject_expense' END,
            jsonb_build_object('expense', _expense, 'voucher', x.voucher_no,
                               'category', x.category, 'amount', x.amount));
END $$;

-- ---------------------------------------------------------------------------
-- 4. Editing a pending expense may change the bill number, not the voucher
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.update_pending_expense(
  _expense uuid, _category text, _amount numeric, _date date,
  _method text, _note text, _attachment text, _bill_no text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE e public.expenses;
BEGIN
  SELECT * INTO e FROM public.expenses WHERE id = _expense FOR UPDATE;
  IF e.id IS NULL OR e.status <> 'pending' THEN RAISE EXCEPTION 'Only pending expenses can be edited'; END IF;
  IF e.created_by IS DISTINCT FROM auth.uid() AND NOT public.can_write_hq(auth.uid()) THEN
    RAISE EXCEPTION 'Only the creator or an admin can edit this expense';
  END IF;
  IF NOT public.can_operate_branch(auth.uid(), e.branch_id) THEN RAISE EXCEPTION 'Not allowed for this branch'; END IF;
  IF coalesce(trim(_category), '') = '' OR _amount IS NULL OR _amount <= 0 THEN
    RAISE EXCEPTION 'Category and a positive amount are required';
  END IF;
  UPDATE public.expenses
     SET category = trim(_category), amount = _amount,
         expense_date = coalesce(_date, e.expense_date),
         method = coalesce(nullif(trim(_method), ''), e.method),
         note = nullif(trim(_note), ''), attachment_url = nullif(trim(_attachment), ''),
         bill_no = nullif(trim(_bill_no), '')
   WHERE id = _expense;
  INSERT INTO public.audit_logs (user_id, action, details)
    VALUES (auth.uid(), 'update_pending_expense', jsonb_build_object(
      'expense', _expense, 'voucher', e.voucher_no,
      'old', jsonb_build_object('category', e.category, 'amount', e.amount, 'date', e.expense_date),
      'new', jsonb_build_object('category', trim(_category), 'amount', _amount,
                               'date', coalesce(_date, e.expense_date))));
END $$;
REVOKE ALL ON FUNCTION public.update_pending_expense(uuid, text, numeric, date, text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_pending_expense(uuid, text, numeric, date, text, text, text, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.update_pending_expense(
  _expense uuid, _category text, _amount numeric, _date date,
  _method text, _note text, _attachment text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public.update_pending_expense(_expense, _category, _amount, _date,
                                        _method, _note, _attachment, NULL);
END $$;
REVOKE ALL ON FUNCTION public.update_pending_expense(uuid, text, numeric, date, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_pending_expense(uuid, text, numeric, date, text, text, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- 5. Payroll belongs in the expense book, not only in the cash book
-- ---------------------------------------------------------------------------
-- One row per branch per period, marked approved because the person who runs
-- payroll is the person who approves it. The cash book row now points at that
-- expense, so the Expenses screen, the daily statement and the reports all
-- agree on what the month cost in salaries.
CREATE OR REPLACE FUNCTION public.run_payroll(_branch uuid, _period text, _employee_ids uuid[], _note text)
RETURNS numeric LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r record; total numeric := 0; e_id uuid; v_no text;
BEGIN
  IF NOT public.can_write_hq(auth.uid())
     AND NOT (public.user_branch(auth.uid()) = _branch AND public.has_role(auth.uid(), 'branch_manager')) THEN
    RAISE EXCEPTION 'Not allowed to run payroll for this branch';
  END IF;
  IF NOT (coalesce(_period,'') ~ '^\d{4}-\d{2}$') THEN RAISE EXCEPTION 'Period must look like 2026-01'; END IF;
  IF coalesce(array_length(_employee_ids, 1), 0) = 0 THEN RAISE EXCEPTION 'No staff selected'; END IF;

  INSERT INTO public.employee_payroll (employee_id, branch_id, period, amount, note, created_by)
  SELECT e.id, e.branch_id, _period, 0, nullif(trim(_note),''), auth.uid()
    FROM public.employees e WHERE e.id = any(_employee_ids)
  ON CONFLICT (employee_id, period) DO NOTHING;

  FOR r IN
    SELECT e.id, e.name, e.salary, e.branch_id FROM public.employees e WHERE e.id = any(_employee_ids)
  LOOP
    IF r.branch_id <> _branch THEN RAISE EXCEPTION '% is not in this branch', r.name; END IF;
    IF EXISTS (SELECT 1 FROM public.employee_payroll p
                WHERE p.employee_id = r.id AND p.period = _period AND p.amount > 0) THEN
      RAISE EXCEPTION '% was already paid for %', r.name, _period;
    END IF;
    UPDATE public.employee_payroll SET amount = r.salary, note = coalesce(nullif(trim(_note),''), note)
      WHERE employee_id = r.id AND period = _period;
    total := total + r.salary;
  END LOOP;

  IF total > 0 THEN
    v_no := 'EXP-' || to_char(now(), 'YYMMDD') || '-' || substr(gen_random_uuid()::text, 1, 6);
    INSERT INTO public.expenses (branch_id, category, amount, expense_date, method, note,
                                 bill_no, voucher_no, status, approved_by, approved_at, created_by)
    VALUES (_branch, 'Staff salary', total,
            (now() AT TIME ZONE 'Asia/Dhaka')::date, 'cash',
            'Payroll ' || _period || coalesce(' — ' || nullif(trim(_note), ''), ''),
            _period, v_no, 'approved', auth.uid(), now(), auth.uid())
    RETURNING id INTO e_id;
    INSERT INTO public.transactions (branch_id, kind, category, amount, note, ref_id, method, created_by)
    VALUES (_branch, 'expense', 'Staff salary', total,
            'Payroll ' || _period || coalesce(' — ' || nullif(trim(_note), ''), ''),
            e_id, 'cash', auth.uid());
  END IF;

  INSERT INTO public.audit_logs (user_id, action, details)
    VALUES (auth.uid(), 'run_payroll', jsonb_build_object(
      'branch', _branch, 'period', _period, 'total', total,
      'expense', e_id, 'voucher', v_no,
      'staff', coalesce(array_length(_employee_ids,1),0)));
  RETURN total;
END $$;
