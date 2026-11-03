-- 0018 — user & role administration hardening
--
-- admin_set_user() only checked can_write_hq(), so:
--   1. A dealer_admin could strip a super_admin's role (only *granting*
--      super_admin was guarded) and take over the system.
--   2. Nothing stopped the last super_admin/dealer_admin from being demoted,
--      which left nobody able to assign roles — the ERP became unusable.
--   3. Nothing stopped an admin from demoting themselves.
--   4. _branch was written straight into profiles.branch_id without checking
--      that the branch exists, and showroom roles (sales / branch_manager) could
--      be assigned with no branch at all — such a user can never work in a
--      showroom, because can_operate_branch() requires a matching branch.
-- admin_revoke_user_access() had the same asymmetry: a dealer_admin could
-- revoke a super_admin's access.
--
-- The rules applied from now on:
--   A. Only a super admin may hand out, change or take away the super admin
--      role. If no super admin exists at all, any HQ admin may appoint one
--      (recovery path).
--   B. The system must never be left without an HQ admin.
--   C. The last admin cannot demote themselves.
--   D. The branch must exist, and showroom roles must have one.

CREATE OR REPLACE FUNCTION public.admin_set_user(_user uuid, _role app_role, _branch uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  caller_is_super boolean;
  target_is_super boolean;
  any_super boolean;
  target_hq_admin boolean;
  new_hq_admin boolean;
  other_admins integer;
  prev_role app_role;
BEGIN
  IF NOT public.can_write_hq(auth.uid()) THEN
    RAISE EXCEPTION 'Not allowed';
  END IF;

  caller_is_super := public.has_role(auth.uid(), 'super_admin');
  target_is_super := public.has_role(_user, 'super_admin');
  any_super := EXISTS (SELECT 1 FROM public.user_roles WHERE role = 'super_admin');

  -- A. Only a super admin manages super admins.
  IF _role = 'super_admin' AND NOT caller_is_super AND any_super THEN
    RAISE EXCEPTION 'Only super admin can grant super admin';
  END IF;
  IF target_is_super AND NOT caller_is_super THEN
    RAISE EXCEPTION 'Only super admin can change a super admin';
  END IF;

  new_hq_admin := (_role = 'super_admin' OR _role = 'dealer_admin');
  target_hq_admin := EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user AND role IN ('super_admin', 'dealer_admin'));

  -- B. Never leave the system without an HQ admin.
  IF target_hq_admin AND NOT new_hq_admin THEN
    SELECT count(*) INTO other_admins FROM public.user_roles
      WHERE user_id <> _user AND role IN ('super_admin', 'dealer_admin');
    IF other_admins = 0 THEN
      RAISE EXCEPTION 'Cannot remove the last admin';
    END IF;
  END IF;

  -- C. The last admin cannot demote themselves.
  IF _user = auth.uid() AND public.can_write_hq(auth.uid()) AND NOT new_hq_admin THEN
    SELECT count(*) INTO other_admins FROM public.user_roles
      WHERE user_id <> _user AND role IN ('super_admin', 'dealer_admin');
    IF other_admins = 0 THEN
      RAISE EXCEPTION 'You cannot remove your own last admin role';
    END IF;
  END IF;

  -- D. The branch must exist, and showroom roles must have one.
  IF _branch IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.branches WHERE id = _branch) THEN
    RAISE EXCEPTION 'Unknown branch';
  END IF;
  IF (_role = 'sales' OR _role = 'branch_manager') AND _branch IS NULL THEN
    RAISE EXCEPTION 'This role needs a branch';
  END IF;

  SELECT role INTO prev_role FROM public.user_roles WHERE user_id = _user LIMIT 1;

  DELETE FROM public.user_roles WHERE user_id = _user;
  INSERT INTO public.user_roles (user_id, role) VALUES (_user, _role);
  UPDATE public.profiles SET branch_id = _branch WHERE id = _user;

  INSERT INTO public.audit_logs (user_id, action, details)
    VALUES (auth.uid(), 'set_user_role', jsonb_build_object(
      'user', _user, 'role', _role, 'previous_role', prev_role, 'branch', _branch));
END;
$$;

REVOKE ALL ON FUNCTION public.admin_set_user(uuid, app_role, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_user(uuid, app_role, uuid) TO authenticated;

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

  -- A dealer_admin must not be able to lock the super admin out.
  IF public.has_role(_user, 'super_admin')
     AND NOT public.has_role(auth.uid(), 'super_admin')
     AND EXISTS (SELECT 1 FROM public.user_roles WHERE role = 'super_admin') THEN
    RAISE EXCEPTION 'Only super admin can revoke a super admin';
  END IF;

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

REVOKE ALL ON FUNCTION public.admin_revoke_user_access(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_revoke_user_access(uuid) TO authenticated;
