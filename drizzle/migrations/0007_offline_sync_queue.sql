CREATE TABLE public.offline_ops (
  client_ref uuid PRIMARY KEY,
  user_id uuid NOT NULL DEFAULT auth.uid(),
  branch_id uuid,
  kind text NOT NULL CHECK (kind IN ('sale','kisti','expense')),
  payload jsonb NOT NULL,
  device text,
  queued_at timestamptz NOT NULL,
  synced_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL CHECK (status IN ('applied','conflict')),
  result jsonb,
  error text,
  resolved boolean NOT NULL DEFAULT false,
  resolved_by uuid
);
GRANT SELECT, UPDATE ON public.offline_ops TO authenticated;
GRANT ALL ON public.offline_ops TO service_role;
ALTER TABLE public.offline_ops ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own or branch managers read offline ops" ON public.offline_ops FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR (branch_id IS NOT NULL AND public.can_approve_branch(auth.uid(), branch_id)));
CREATE POLICY "managers resolve offline conflicts" ON public.offline_ops FOR UPDATE TO authenticated
  USING (branch_id IS NOT NULL AND public.can_approve_branch(auth.uid(), branch_id))
  WITH CHECK (branch_id IS NOT NULL AND public.can_approve_branch(auth.uid(), branch_id));

CREATE OR REPLACE FUNCTION public.apply_offline_op(_client_ref uuid, _kind text, _payload jsonb, _queued_at timestamptz, _device text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE prev public.offline_ops; res jsonb; br uuid; cust uuid; sale_id uuid; st text;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not signed in'; END IF;
  SELECT * INTO prev FROM public.offline_ops WHERE client_ref = _client_ref;
  IF FOUND THEN
    RETURN jsonb_build_object('status', prev.status, 'result', prev.result, 'error', prev.error);
  END IF;
  br := nullif(_payload->>'branch','')::uuid;
  BEGIN
    IF _kind = 'sale' THEN
      cust := nullif(_payload->>'customer','')::uuid;
      IF cust IS NULL AND coalesce(_payload->>'phone','') <> '' THEN
        IF NOT public.can_operate_branch(auth.uid(), br) THEN RAISE EXCEPTION 'Not allowed for this branch'; END IF;
        SELECT id INTO cust FROM public.customers WHERE phone = _payload->>'phone' ORDER BY created_at LIMIT 1;
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
      PERFORM public.pay_installment((_payload->>'inst')::uuid, (_payload->>'amount')::numeric);
      res := '{}'::jsonb;
    ELSIF _kind = 'expense' THEN
      st := public.submit_expense(br, _payload->>'category', (_payload->>'amount')::numeric, (_payload->>'date')::date,
        _payload->>'method', coalesce(_payload->>'note',''), coalesce(_payload->>'attachment',''));
      res := jsonb_build_object('expense_status', st);
    ELSE
      RAISE EXCEPTION 'Unknown offline action';
    END IF;
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO public.offline_ops(client_ref, branch_id, kind, payload, device, queued_at, status, error)
    VALUES (_client_ref, br, _kind, _payload, _device, _queued_at, 'conflict', SQLERRM);
    INSERT INTO public.audit_logs(user_id, action, details)
    VALUES (auth.uid(), 'offline_conflict', jsonb_build_object('kind', _kind, 'error', SQLERRM, 'queued_at', _queued_at, 'device', _device));
    RETURN jsonb_build_object('status', 'conflict', 'error', SQLERRM);
  END;
  INSERT INTO public.offline_ops(client_ref, branch_id, kind, payload, device, queued_at, status, result)
  VALUES (_client_ref, br, _kind, _payload, _device, _queued_at, 'applied', res);
  RETURN jsonb_build_object('status', 'applied', 'result', res);
END $$;
REVOKE ALL ON FUNCTION public.apply_offline_op(uuid, text, jsonb, timestamptz, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.apply_offline_op(uuid, text, jsonb, timestamptz, text) TO authenticated;