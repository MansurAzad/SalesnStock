GRANT DELETE ON public.suppliers TO authenticated;

CREATE POLICY "hq delete unused suppliers" ON public.suppliers
FOR DELETE TO authenticated
USING (public.can_write_hq(auth.uid()));