CREATE POLICY "delete customers" ON public.customers
FOR DELETE TO authenticated
USING (public.can_operate_branch(auth.uid(), branch_id));