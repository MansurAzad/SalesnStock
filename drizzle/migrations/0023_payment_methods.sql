-- 0023 — payment methods the tills actually take
--
-- The POS has offered "card" since the first version, but transactions.method
-- only allowed cash/bank/bkash/nagad/cheque/online. The BEFORE INSERT trigger
-- copies the sale's method verbatim, so every card sale that took money was
-- rejected by the CHECK constraint — the invoice never saved. Rocket was
-- missing everywhere, although it is one of the three wallets a Bangladeshi
-- showroom takes.
--
-- Nothing is narrowed here: the accepted list only grows, so no existing row
-- can fail the new constraints.

-- ---------------------------------------------------------------------------
-- 1. Widen transactions.method
-- ---------------------------------------------------------------------------
ALTER TABLE public.transactions DROP CONSTRAINT IF EXISTS transactions_method_check;
ALTER TABLE public.transactions ADD CONSTRAINT transactions_method_check
  CHECK (method IN ('cash','bank','bkash','nagad','rocket','card','cheque','online'));

-- ---------------------------------------------------------------------------
-- 2. Constrain the documents that feed it, so a typo cannot reach the cash book
-- ---------------------------------------------------------------------------
ALTER TABLE public.sales DROP CONSTRAINT IF EXISTS sales_payment_method_check;
ALTER TABLE public.sales ADD CONSTRAINT sales_payment_method_check
  CHECK (payment_method IN ('cash','bank','bkash','nagad','rocket','card','cheque','online'));

ALTER TABLE public.expenses DROP CONSTRAINT IF EXISTS expenses_method_check;
ALTER TABLE public.expenses ADD CONSTRAINT expenses_method_check
  CHECK (method IN ('cash','bank','bkash','nagad','rocket','card','cheque','online'));

ALTER TABLE public.purchase_payments DROP CONSTRAINT IF EXISTS purchase_payments_method_check;
ALTER TABLE public.purchase_payments ADD CONSTRAINT purchase_payments_method_check
  CHECK (method IN ('cash','bank','bkash','nagad','rocket','card','cheque','online'));

ALTER TABLE public.finance_partner_ledger DROP CONSTRAINT IF EXISTS finance_partner_ledger_method_check;
ALTER TABLE public.finance_partner_ledger ADD CONSTRAINT finance_partner_ledger_method_check
  CHECK (method IN ('cash','bank','bkash','nagad','rocket','card','cheque','online'));
