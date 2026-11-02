CREATE OR REPLACE FUNCTION public.admin_revoke_user_access(_user uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  removed_roles text[];
  remaining_admins integer;
BEGIN
  IF NOT public.can_write_hq(auth.uid()) THEN RAISE EXCEPTION 'Only an admin can revoke user access'; END IF;
  IF _user = auth.uid() THEN RAISE EXCEPTION 'You cannot revoke your own access'; END IF;

  SELECT array_agg(role::text) INTO removed_roles FROM public.user_roles WHERE user_id = _user;
  IF coalesce(removed_roles, ARRAY[]::text[]) && ARRAY['super_admin', 'dealer_admin'] THEN
    SELECT count(*) INTO remaining_admins FROM public.user_roles
      WHERE user_id <> _user AND role IN ('super_admin', 'dealer_admin');
    IF remaining_admins = 0 THEN RAISE EXCEPTION 'Cannot revoke the last HQ admin'; END IF;
  END IF;

  DELETE FROM public.user_roles WHERE user_id = _user;
  UPDATE public.profiles SET branch_id = NULL WHERE id = _user;
  INSERT INTO public.audit_logs (user_id, action, details)
    VALUES (auth.uid(), 'admin_revoke_user_access', jsonb_build_object('user', _user, 'roles', removed_roles));
END;
$$;

REVOKE ALL ON FUNCTION public.admin_revoke_user_access(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_revoke_user_access(uuid) TO authenticated;