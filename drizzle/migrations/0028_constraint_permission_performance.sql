SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

ALTER TABLE public.finance_cases VALIDATE CONSTRAINT chk_finance_cases_amount;
ALTER TABLE public.finance_cases VALIDATE CONSTRAINT chk_finance_cases_commission;
ALTER TABLE public.finance_partners VALIDATE CONSTRAINT chk_finance_partners_comm;
ALTER TABLE public.purchases VALIDATE CONSTRAINT chk_purchases_total;
ALTER TABLE public.purchases VALIDATE CONSTRAINT chk_purchases_returned;
ALTER TABLE public.purchases VALIDATE CONSTRAINT chk_purchases_paid;
ALTER TABLE public.purchase_items VALIDATE CONSTRAINT chk_purchase_items_cost;
ALTER TABLE public.branches VALIDATE CONSTRAINT chk_branches_max_discount;
ALTER TABLE public.branches VALIDATE CONSTRAINT chk_branches_expense_limit;
ALTER TABLE public.products VALIDATE CONSTRAINT chk_products_prices;
ALTER TABLE public.sales VALIDATE CONSTRAINT chk_sales_amounts;
ALTER TABLE public.installment_plans VALIDATE CONSTRAINT chk_installment_plans;
ALTER TABLE public.installments VALIDATE CONSTRAINT chk_installments;
ALTER TABLE public.employees VALIDATE CONSTRAINT chk_employees_salary;

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION
  public.set_offline_replay(timestamptz, uuid),
  public.clear_offline_replay(),
  public.inventory_movement_context(text, text, text),
  public.take_inventory_movement_context(),
  public.apply_offline_actor(),
  public.apply_offline_timestamp(),
  public.audit_branch_change(),
  public.handle_new_user(),
  public.inventory_record_movement(),
  public.link_purchase_movement(),
  public.transactions_fill_method()
FROM authenticated;

DROP POLICY IF EXISTS "hq manage branches" ON public.branches;
DROP POLICY IF EXISTS "hq insert branches" ON public.branches;
CREATE POLICY "hq insert branches" ON public.branches FOR INSERT TO authenticated
  WITH CHECK ((SELECT public.can_write_hq((SELECT auth.uid()))));
DROP POLICY IF EXISTS "hq update branches" ON public.branches;
CREATE POLICY "hq update branches" ON public.branches FOR UPDATE TO authenticated
  USING ((SELECT public.can_write_hq((SELECT auth.uid()))))
  WITH CHECK ((SELECT public.can_write_hq((SELECT auth.uid()))));
DROP POLICY IF EXISTS "hq delete branches" ON public.branches;
CREATE POLICY "hq delete branches" ON public.branches FOR DELETE TO authenticated
  USING ((SELECT public.can_write_hq((SELECT auth.uid()))));

DROP POLICY IF EXISTS "hq manage partners" ON public.finance_partners;
DROP POLICY IF EXISTS "hq insert partners" ON public.finance_partners;
CREATE POLICY "hq insert partners" ON public.finance_partners FOR INSERT TO authenticated
  WITH CHECK ((SELECT public.can_write_hq((SELECT auth.uid()))));
DROP POLICY IF EXISTS "hq update partners" ON public.finance_partners;
CREATE POLICY "hq update partners" ON public.finance_partners FOR UPDATE TO authenticated
  USING ((SELECT public.can_write_hq((SELECT auth.uid()))))
  WITH CHECK ((SELECT public.can_write_hq((SELECT auth.uid()))));
DROP POLICY IF EXISTS "hq delete partners" ON public.finance_partners;
CREATE POLICY "hq delete partners" ON public.finance_partners FOR DELETE TO authenticated
  USING ((SELECT public.can_write_hq((SELECT auth.uid()))));

DROP POLICY IF EXISTS "hq manage products" ON public.products;
DROP POLICY IF EXISTS "hq insert products" ON public.products;
CREATE POLICY "hq insert products" ON public.products FOR INSERT TO authenticated
  WITH CHECK ((SELECT public.can_write_hq((SELECT auth.uid()))));
DROP POLICY IF EXISTS "hq update products" ON public.products;
CREATE POLICY "hq update products" ON public.products FOR UPDATE TO authenticated
  USING ((SELECT public.can_write_hq((SELECT auth.uid()))))
  WITH CHECK ((SELECT public.can_write_hq((SELECT auth.uid()))));
DROP POLICY IF EXISTS "hq delete products" ON public.products;
CREATE POLICY "hq delete products" ON public.products FOR DELETE TO authenticated
  USING ((SELECT public.can_write_hq((SELECT auth.uid()))));

DROP POLICY IF EXISTS "hq manage items" ON public.inventory_items;
DROP POLICY IF EXISTS "hq insert items" ON public.inventory_items;
CREATE POLICY "hq insert items" ON public.inventory_items FOR INSERT TO authenticated
  WITH CHECK ((SELECT public.can_write_hq((SELECT auth.uid()))));
DROP POLICY IF EXISTS "hq update items" ON public.inventory_items;
CREATE POLICY "hq update items" ON public.inventory_items FOR UPDATE TO authenticated
  USING ((SELECT public.can_write_hq((SELECT auth.uid()))))
  WITH CHECK ((SELECT public.can_write_hq((SELECT auth.uid()))));
DROP POLICY IF EXISTS "hq delete items" ON public.inventory_items;
CREATE POLICY "hq delete items" ON public.inventory_items FOR DELETE TO authenticated
  USING ((SELECT public.can_write_hq((SELECT auth.uid()))));

ALTER POLICY "hq insert settings" ON public.app_settings
  WITH CHECK ((SELECT public.can_write_hq((SELECT auth.uid()))));
ALTER POLICY "hq update settings" ON public.app_settings
  USING ((SELECT public.can_write_hq((SELECT auth.uid()))))
  WITH CHECK ((SELECT public.can_write_hq((SELECT auth.uid()))));
ALTER POLICY "insert attendance" ON public.attendance
  WITH CHECK (public.can_operate_branch((SELECT auth.uid()), branch_id));
ALTER POLICY "read attendance" ON public.attendance
  USING (public.can_access_branch((SELECT auth.uid()), branch_id));
ALTER POLICY "update attendance" ON public.attendance
  USING (public.can_operate_branch((SELECT auth.uid()), branch_id))
  WITH CHECK (public.can_operate_branch((SELECT auth.uid()), branch_id));
ALTER POLICY "hq read audit" ON public.audit_logs
  USING ((SELECT public.is_hq((SELECT auth.uid()))));
ALTER POLICY "delete customers" ON public.customers
  USING (public.can_operate_branch((SELECT auth.uid()), branch_id));
ALTER POLICY "insert customers" ON public.customers
  WITH CHECK (public.can_operate_branch((SELECT auth.uid()), branch_id));
ALTER POLICY "read customers" ON public.customers
  USING (public.can_access_branch((SELECT auth.uid()), branch_id));
ALTER POLICY "update customers" ON public.customers
  USING (public.can_operate_branch((SELECT auth.uid()), branch_id))
  WITH CHECK (public.can_operate_branch((SELECT auth.uid()), branch_id));
ALTER POLICY "branch can read daily cash" ON public.daily_cash_records
  USING (public.can_access_branch((SELECT auth.uid()), branch_id));
ALTER POLICY "branch can read payroll" ON public.employee_payroll
  USING (public.can_access_branch((SELECT auth.uid()), branch_id));
ALTER POLICY "manage employees" ON public.employees
  WITH CHECK ((SELECT public.can_write_hq((SELECT auth.uid()))) OR
    ((SELECT public.user_branch((SELECT auth.uid()))) = branch_id AND
     (SELECT public.has_role((SELECT auth.uid()), 'branch_manager'::public.app_role))));
ALTER POLICY "read employees" ON public.employees
  USING (public.can_access_branch((SELECT auth.uid()), branch_id));
ALTER POLICY "update employees" ON public.employees
  USING ((SELECT public.can_write_hq((SELECT auth.uid()))) OR
    ((SELECT public.user_branch((SELECT auth.uid()))) = branch_id AND
     (SELECT public.has_role((SELECT auth.uid()), 'branch_manager'::public.app_role))))
  WITH CHECK ((SELECT public.can_write_hq((SELECT auth.uid()))) OR
    ((SELECT public.user_branch((SELECT auth.uid()))) = branch_id AND
     (SELECT public.has_role((SELECT auth.uid()), 'branch_manager'::public.app_role))));
ALTER POLICY "read expenses" ON public.expenses
  USING (public.can_access_branch((SELECT auth.uid()), branch_id));
ALTER POLICY "insert cases" ON public.finance_cases
  WITH CHECK (public.can_operate_branch((SELECT auth.uid()), branch_id)
    AND status = 'pending' AND created_by = (SELECT auth.uid()));
ALTER POLICY "read cases" ON public.finance_cases
  USING (public.can_access_branch((SELECT auth.uid()), branch_id));
ALTER POLICY "branch can read partner ledger" ON public.finance_partner_ledger
  USING (public.can_access_branch((SELECT auth.uid()), branch_id));
ALTER POLICY "read plans" ON public.installment_plans
  USING (public.can_access_branch((SELECT auth.uid()), branch_id));
ALTER POLICY "read installments" ON public.installments
  USING (public.can_access_branch((SELECT auth.uid()), branch_id));
ALTER POLICY "read items" ON public.inventory_items
  USING (public.can_access_branch((SELECT auth.uid()), branch_id));
ALTER POLICY "branch can read movements" ON public.inventory_movements
  USING (public.can_access_branch((SELECT auth.uid()), branch_id));
ALTER POLICY "managers resolve offline conflicts" ON public.offline_ops
  USING (branch_id IS NOT NULL AND public.can_approve_branch((SELECT auth.uid()), branch_id))
  WITH CHECK (branch_id IS NOT NULL AND public.can_approve_branch((SELECT auth.uid()), branch_id));
ALTER POLICY "own or branch managers read offline ops" ON public.offline_ops
  USING (user_id = (SELECT auth.uid()) OR
    (branch_id IS NOT NULL AND public.can_approve_branch((SELECT auth.uid()), branch_id)));
ALTER POLICY "read own or hq profiles" ON public.profiles
  USING (id = (SELECT auth.uid()) OR (SELECT public.is_hq((SELECT auth.uid()))));
ALTER POLICY "update own name" ON public.profiles
  USING (id = (SELECT auth.uid()) OR (SELECT public.can_write_hq((SELECT auth.uid()))))
  WITH CHECK (id = (SELECT auth.uid()) OR (SELECT public.can_write_hq((SELECT auth.uid()))));
ALTER POLICY "read purchase items" ON public.purchase_items
  USING (EXISTS (SELECT 1 FROM public.purchases p
    WHERE p.id = purchase_items.purchase_id AND public.can_access_branch((SELECT auth.uid()), p.branch_id)));
ALTER POLICY "read purchase payments" ON public.purchase_payments
  USING (EXISTS (SELECT 1 FROM public.purchases p
    WHERE p.id = purchase_payments.purchase_id AND public.can_access_branch((SELECT auth.uid()), p.branch_id)));
ALTER POLICY "read purchases" ON public.purchases
  USING (public.can_access_branch((SELECT auth.uid()), branch_id));
ALTER POLICY "read sale items" ON public.sale_items
  USING (EXISTS (SELECT 1 FROM public.sales s
    WHERE s.id = sale_items.sale_id AND public.can_access_branch((SELECT auth.uid()), s.branch_id)));
ALTER POLICY "read sales" ON public.sales
  USING (public.can_access_branch((SELECT auth.uid()), branch_id));
ALTER POLICY "read transfers" ON public.stock_transfers
  USING (public.can_access_branch((SELECT auth.uid()), from_branch_id)
    OR public.can_access_branch((SELECT auth.uid()), to_branch_id));
ALTER POLICY "hq add suppliers" ON public.suppliers
  WITH CHECK ((SELECT public.can_write_hq((SELECT auth.uid()))));
ALTER POLICY "hq delete unused suppliers" ON public.suppliers
  USING ((SELECT public.can_write_hq((SELECT auth.uid()))));
ALTER POLICY "hq edit suppliers" ON public.suppliers
  USING ((SELECT public.can_write_hq((SELECT auth.uid()))))
  WITH CHECK ((SELECT public.can_write_hq((SELECT auth.uid()))));
ALTER POLICY "read tx" ON public.transactions
  USING (public.can_access_branch((SELECT auth.uid()), branch_id));
ALTER POLICY "read transfer items" ON public.transfer_items
  USING (EXISTS (SELECT 1 FROM public.stock_transfers t
    WHERE t.id = transfer_items.transfer_id AND
      (public.can_access_branch((SELECT auth.uid()), t.from_branch_id)
       OR public.can_access_branch((SELECT auth.uid()), t.to_branch_id))));
ALTER POLICY "read own or hq roles" ON public.user_roles
  USING (user_id = (SELECT auth.uid()) OR (SELECT public.is_hq((SELECT auth.uid()))));

DROP INDEX IF EXISTS public.idx_expenses_branch_date;
