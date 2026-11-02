DROP POLICY IF EXISTS "insert tx" ON public.transactions;

CREATE POLICY "insert income tx" ON public.transactions
FOR INSERT TO authenticated
WITH CHECK (
  kind = 'income'
  AND public.can_operate_branch(auth.uid(), branch_id)
  AND created_by = auth.uid()
);