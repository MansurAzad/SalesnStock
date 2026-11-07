-- 0027 — an offline sale keeps the day and the person it really happened to
--
-- A showroom that loses internet keeps selling. The sale is queued on the
-- device and replayed the next time there is a connection — which can be two
-- days later. When it lands, create_sale() stamps it with now(), so a sale
-- made on Monday appears in Wednesday's day book and Wednesday's cash
-- statement, and Monday's closing cash is short by exactly that amount.
-- Nothing in the requirement breaks as loudly as the daily total lying.
--
-- The queue already carries the original moment (queued_at) and the original
-- owner (user_id); apply_offline_op simply never passed them down. Rather
-- than re-declare every document function with an extra timestamp argument,
-- apply_offline_op wraps the replay in a transaction-local setting and two
-- BEFORE INSERT triggers read it. The browser cannot set it: it is written
-- only inside this SECURITY DEFINER function, and it dies with the
-- transaction, so a pooled connection cannot leak it into someone else's save.

-- ---------------------------------------------------------------------------
-- 1. The setting apply_offline_op writes
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_offline_replay(_at timestamptz, _actor uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM set_config('erp.replay_at', coalesce(_at, now())::text, true);
  PERFORM set_config('erp.replay_actor', coalesce(_actor, auth.uid())::text, true);
END $$;
REVOKE ALL ON FUNCTION public.set_offline_replay(timestamptz, uuid) FROM PUBLIC, anon;
-- Deliberately not granted to authenticated: only apply_offline_op, which runs
-- as the owner of the queue, may reopen history.
GRANT EXECUTE ON FUNCTION public.set_offline_replay(timestamptz, uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.clear_offline_replay() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM set_config('erp.replay_at', '', true);
  PERFORM set_config('erp.replay_actor', '', true);
END $$;
REVOKE ALL ON FUNCTION public.clear_offline_replay() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.clear_offline_replay() TO service_role;

-- ---------------------------------------------------------------------------
-- 2. The triggers that read it
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.apply_offline_timestamp() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE at_iso text := current_setting('erp.replay_at', true);
BEGIN
  -- Never let a queued entry land in the future or rewrite history further
  -- back than a season, whatever the device clock said.
  IF coalesce(at_iso, '') <> ''
     AND (at_iso::timestamptz) < now()
     AND (at_iso::timestamptz) > now() - interval '400 days' THEN
    NEW.created_at := at_iso::timestamptz;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS tr_sales_offline_timestamp ON public.sales;
CREATE TRIGGER tr_sales_offline_timestamp BEFORE INSERT ON public.sales
  FOR EACH ROW EXECUTE FUNCTION public.apply_offline_timestamp();

DROP TRIGGER IF EXISTS tr_transactions_offline_timestamp ON public.transactions;
CREATE TRIGGER tr_transactions_offline_timestamp BEFORE INSERT ON public.transactions
  FOR EACH ROW EXECUTE FUNCTION public.apply_offline_timestamp();

DROP TRIGGER IF EXISTS tr_expenses_offline_timestamp ON public.expenses;
CREATE TRIGGER tr_expenses_offline_timestamp BEFORE INSERT ON public.expenses
  FOR EACH ROW EXECUTE FUNCTION public.apply_offline_timestamp();

-- The invoice, the cash-book line and the expense must name the person standing
-- at the counter, not whoever happened to be signed in when the internet came
-- back: the per-salesman figures in the reports read created_by.
CREATE OR REPLACE FUNCTION public.apply_offline_actor() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE who text := current_setting('erp.replay_actor', true);
BEGIN
  IF coalesce(who, '') <> '' THEN NEW.created_by := who::uuid; END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS tr_sales_offline_actor ON public.sales;
CREATE TRIGGER tr_sales_offline_actor BEFORE INSERT ON public.sales
  FOR EACH ROW EXECUTE FUNCTION public.apply_offline_actor();

DROP TRIGGER IF EXISTS tr_transactions_offline_actor ON public.transactions;
CREATE TRIGGER tr_transactions_offline_actor BEFORE INSERT ON public.transactions
  FOR EACH ROW EXECUTE FUNCTION public.apply_offline_actor();

DROP TRIGGER IF EXISTS tr_expenses_offline_actor ON public.expenses;
CREATE TRIGGER tr_expenses_offline_actor BEFORE INSERT ON public.expenses
  FOR EACH ROW EXECUTE FUNCTION public.apply_offline_actor();

-- ---------------------------------------------------------------------------
-- 3. apply_offline_op wraps the replay in it
--
-- The queue lives on the device that filled it and is replayed by whoever is
-- signed in when the internet returns, so `_actor` is the id the app opened
-- that queue under. It is checked, not trusted: an entry can only be replayed
-- by the account it belongs to, which is already how the outbox is keyed.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.apply_offline_op(uuid, text, jsonb, timestamptz, text, uuid);
CREATE OR REPLACE FUNCTION public.apply_offline_op(
  _client_ref uuid, _kind text, _payload jsonb, _queued_at timestamptz, _device text, _actor uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE prev public.offline_ops; res jsonb; br uuid; cust uuid; sale_id uuid; st text;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not signed in'; END IF;
  IF _actor IS NOT NULL AND _actor <> auth.uid() THEN
    RAISE EXCEPTION 'This queue belongs to another account';
  END IF;
  SELECT * INTO prev FROM public.offline_ops WHERE client_ref = _client_ref;
  IF FOUND THEN
    RETURN jsonb_build_object('status', prev.status, 'result', prev.result, 'error', prev.error);
  END IF;
  br := nullif(_payload->>'branch','')::uuid;

  PERFORM public.set_offline_replay(_queued_at, auth.uid());

  BEGIN
    IF _kind = 'sale' THEN
      cust := nullif(_payload->>'customer','')::uuid;
      -- The queue was filled on a device that may hold a customer from another
      -- showroom's screen; create_sale rejects a cross-branch customer, so an
      -- unverified id would turn a good sale into a conflict.
      IF cust IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.customers WHERE id = cust AND branch_id = br) THEN
        cust := NULL;
      END IF;
      IF cust IS NULL AND coalesce(_payload->>'phone','') <> '' THEN
        IF NOT public.can_operate_branch(auth.uid(), br) THEN RAISE EXCEPTION 'Not allowed for this branch'; END IF;
        -- Matched inside the branch: this function reads as the owner, so RLS
        -- does not narrow it, and a phone from another showroom would hijack
        -- the sale's customer.
        SELECT id INTO cust FROM public.customers WHERE phone = _payload->>'phone' AND branch_id = br ORDER BY created_at LIMIT 1;
        IF cust IS NULL THEN
          INSERT INTO public.customers(branch_id, name, phone, nid)
          VALUES (br, coalesce(nullif(_payload->>'cust_name',''), _payload->>'phone'), _payload->>'phone', nullif(_payload->>'nid',''))
          RETURNING id INTO cust;
        END IF;
      END IF;
      sale_id := public.create_sale(br, cust, _payload->'items', coalesce((_payload->>'discount')::numeric,0),
        coalesce((_payload->>'paid')::numeric,0), _payload->>'method', _payload->>'sale_type',
        nullif(_payload->>'months','')::int, nullif(_payload->>'discount_reason',''));
      res := jsonb_build_object('sale_id', sale_id);
    ELSIF _kind = 'kisti' THEN
      SELECT branch_id INTO br FROM public.installments WHERE id = (_payload->>'inst')::uuid;
      -- A collection that came in on bKash has to land on bKash: the day book
      -- splits the drawer from the wallet, and a replay that dropped the
      -- method turned every offline collection into cash.
      PERFORM public.pay_installment((_payload->>'inst')::uuid, (_payload->>'amount')::numeric,
        coalesce(nullif(_payload->>'method',''), 'cash'));
      res := '{}'::jsonb;
    ELSIF _kind = 'expense' THEN
      st := public.submit_expense(br, _payload->>'category', (_payload->>'amount')::numeric, (_payload->>'date')::date,
        _payload->>'method', coalesce(_payload->>'note',''), coalesce(_payload->>'attachment',''),
        nullif(_payload->>'bill_no',''));
      res := jsonb_build_object('expense_voucher', st);
    ELSE
      RAISE EXCEPTION 'Unknown offline action';
    END IF;
  EXCEPTION WHEN OTHERS THEN
    PERFORM public.clear_offline_replay();
    INSERT INTO public.offline_ops(client_ref, user_id, branch_id, kind, payload, device, queued_at, status, error)
    VALUES (_client_ref, auth.uid(), br, _kind, _payload, _device, _queued_at, 'conflict', SQLERRM);
    INSERT INTO public.audit_logs(user_id, action, details)
    VALUES (auth.uid(), 'offline_conflict', jsonb_build_object('kind', _kind, 'error', SQLERRM, 'queued_at', _queued_at, 'device', _device));
    RETURN jsonb_build_object('status', 'conflict', 'error', SQLERRM);
  END;

  PERFORM public.clear_offline_replay();
  INSERT INTO public.offline_ops(client_ref, user_id, branch_id, kind, payload, device, queued_at, status, result)
  VALUES (_client_ref, auth.uid(), br, _kind, _payload, _device, _queued_at, 'applied', res);
  INSERT INTO public.audit_logs(user_id, action, details)
  VALUES (auth.uid(), 'offline_sync', jsonb_build_object('kind', _kind, 'client_ref', _client_ref,
           'queued_at', _queued_at, 'result', res));
  RETURN jsonb_build_object('status', 'applied', 'result', res);
END $$;

-- The older five-argument call still works, so a device running a build from
-- before this change can still empty its queue.
CREATE OR REPLACE FUNCTION public.apply_offline_op(
  _client_ref uuid, _kind text, _payload jsonb, _queued_at timestamptz, _device text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN public.apply_offline_op(_client_ref, _kind, _payload, _queued_at, _device, auth.uid());
END $$;

REVOKE ALL ON FUNCTION public.apply_offline_op(uuid, text, jsonb, timestamptz, text, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.apply_offline_op(uuid, text, jsonb, timestamptz, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apply_offline_op(uuid, text, jsonb, timestamptz, text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.apply_offline_op(uuid, text, jsonb, timestamptz, text) TO authenticated;
