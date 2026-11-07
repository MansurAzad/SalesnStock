/**
 * Checks the live database against what the app expects: every table in the
 * drizzle schema, the columns added by the feature migrations, and the
 * functions the front end calls.
 */
const postgres = require("postgres").default;

const sql = postgres(process.env.DB_URL, { max: 1 });

const EXPECTED_TABLES = [
  "app_settings",
  "attendance",
  "audit_logs",
  "branches",
  "customers",
  "daily_cash_records",
  "employee_payroll",
  "employees",
  "expenses",
  "finance_cases",
  "finance_partner_ledger",
  "finance_partners",
  "installment_plans",
  "installments",
  "inventory_items",
  "inventory_movements",
  "offline_ops",
  "products",
  "profiles",
  "purchase_items",
  "purchase_payments",
  "purchases",
  "sale_items",
  "sales",
  "stock_transfers",
  "suppliers",
  "transactions",
  "transfer_items",
  "user_roles",
];

const EXPECTED_COLUMNS = [
  ["transactions", "method"],
  ["products", "min_stock"],
  ["customers", "notes"],
  ["app_settings", "default_print_lang"],
  ["expenses", "voucher_no"],
  ["expenses", "bill_no"],
  ["expenses", "approved_at"],
  ["inventory_movements", "movement_type"],
  ["inventory_movements", "qty"],
  ["daily_cash_records", "opening_cash"],
  ["daily_cash_records", "counted_cash"],
  ["inventory_movements", "seq"],
];

// The ledger, the vouchers and the offline replay all hang off triggers; a
// migration that landed half-way leaves the books silently wrong.
const EXPECTED_TRIGGERS = [
  ["inventory_items", "tr_inventory_record_movement"],
  ["purchase_items", "tr_purchase_items_link_movement"],
  ["sales", "tr_sales_offline_timestamp"],
  ["sales", "tr_sales_offline_actor"],
  ["transactions", "tr_transactions_offline_timestamp"],
  ["transactions", "tr_transactions_offline_actor"],
  ["expenses", "tr_expenses_offline_timestamp"],
  ["expenses", "tr_expenses_offline_actor"],
];

const METHODS = ["cash", "bank", "bkash", "nagad", "rocket", "card", "cheque", "online"];
const METHOD_CHECKS = [
  "transactions_method_check",
  "sales_payment_method_check",
  "expenses_method_check",
  "purchase_payments_method_check",
  "finance_partner_ledger_method_check",
];
const HEADS = [
  "Shop rent",
  "Electricity bill",
  "Internet bill",
  "Staff salary",
  "Food",
  "Transport",
  "Cleaning",
  "Repair",
  "Marketing",
  "Other",
];

const EXPECTED_FUNCTIONS = [
  "create_sale",
  "create_transfer",
  "receive_transfer",
  "pay_installment",
  "admin_set_user",
  "admin_revoke_user_access",
  "apply_offline_op",
  "handle_new_user",
  "settle_finance",
  "return_sale",
  "add_manual_income",
  "reverse_manual_transaction",
  "partner_payment",
  "create_finance_case",
  "run_payroll",
  "transactions_fill_method",
  "has_role",
  "is_hq",
  "can_write_hq",
  "user_branch",
  "can_access_branch",
  "can_operate_branch",
  "can_approve_branch",
  "stock_on_hand",
  "low_stock_products",
  "kisti_ageing",
  "customer_dues",
  "daily_cash_reconciliation",
  "save_daily_cash_opening",
  "record_hq_deposit",
  "stock_reconciliation",
  "stock_imei_ledger",
  "adjust_inventory",
  "inventory_movement_context",
  "take_inventory_movement_context",
  "inventory_record_movement",
  "link_purchase_movement",
  "submit_expense",
  "decide_expense",
  "mark_inventory_damaged",
  "restore_damaged_inventory",
  "set_offline_replay",
  "clear_offline_replay",
  "apply_offline_timestamp",
  "apply_offline_actor",
];

(async () => {
  let bad = 0;

  const tables = await sql`
    select table_name from information_schema.tables
    where table_schema='public' and table_type='BASE TABLE'`;
  const have = new Set(tables.map((r) => r.table_name));
  const missingTables = EXPECTED_TABLES.filter((t) => !have.has(t));
  console.log(`tables: ${have.size} present`);
  if (missingTables.length) {
    bad++;
    console.log("  MISSING TABLES: " + missingTables.join(", "));
  }

  const cols = await sql`
    select table_name, column_name from information_schema.columns
    where table_schema='public'`;
  const colSet = new Set(cols.map((r) => `${r.table_name}.${r.column_name}`));
  for (const [t, c] of EXPECTED_COLUMNS) {
    if (!colSet.has(`${t}.${c}`)) {
      bad++;
      console.log(`  MISSING COLUMN ${t}.${c}`);
    }
  }

  const fns = await sql`
    select p.proname from pg_proc p
    join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public'`;
  const fnSet = new Set(fns.map((r) => r.proname));
  const missingFn = EXPECTED_FUNCTIONS.filter((f) => !fnSet.has(f));
  console.log(`functions: ${fnSet.size} present`);
  if (missingFn.length) {
    bad++;
    console.log("  MISSING FUNCTIONS: " + missingFn.join(", "));
  }

  // apply_offline_op reads as the owner of the queue, so RLS never narrows its
  // customer lookup. A rewrite once dropped both branch guards and every offline
  // sale to a phone held by another showroom turned into a conflict, so the
  // shipped body is checked for them.
  const [replay] = await sql`
    select pg_get_functiondef(p.oid) as body from pg_proc p
    join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='apply_offline_op' and p.pronargs=6`;
  const replayBody = replay?.body ?? "";
  const lostGuards = [
    "WHERE id = cust AND branch_id = br",
    "AND branch_id = br ORDER BY created_at",
  ].filter((needle) => !replayBody.includes(needle));
  console.log(
    `replay branch guards: ${lostGuards.length ? "MISSING " + lostGuards.join(" | ") : "2/2 in place"}`,
  );
  if (lostGuards.length) bad++;

  const noRls = await sql`
    select c.relname from pg_class c
    join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relkind='r' and not c.relrowsecurity`;
  console.log(
    `tables without RLS: ${noRls.length}` +
      (noRls.length ? " -> " + noRls.map((r) => r.relname).join(", ") : ""),
  );

  const trig = await sql`
    select t.tgname from pg_trigger t
    join pg_class c on c.oid=t.tgrelid
    join pg_namespace n on n.oid=c.relnamespace
    where not t.tgisinternal and n.nspname='auth' and c.relname='users'`;
  console.log("auth trigger: " + (trig.map((r) => r.tgname).join(", ") || "none"));
  if (!trig.length) bad++;

  const appTriggers = await sql`
    select n.nspname || '.' || c.relname as table_name, t.tgname
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where not t.tgisinternal and n.nspname = 'public'`;
  const triggerSet = new Set(appTriggers.map((r) => `${r.table_name}#${r.tgname}`));
  const missingTriggers = EXPECTED_TRIGGERS.filter(
    ([table, name]) => !triggerSet.has(`public.${table}#${name}`),
  );
  console.log(`app triggers: ${triggerSet.size} present`);
  if (missingTriggers.length) {
    bad++;
    console.log("  MISSING TRIGGERS: " + missingTriggers.map((x) => x.join(".")).join(", "));
  }

  const constraints = await sql`
    select conname, pg_get_constraintdef(oid) as def from pg_constraint
    where connamespace = 'public'::regnamespace and contype = 'c'`;
  const defs = new Map(constraints.map((r) => [r.conname, r.def]));

  const badMethods = [];
  for (const name of METHOD_CHECKS) {
    const def = defs.get(name);
    if (!def) badMethods.push(`${name} (missing)`);
    else for (const m of METHODS) if (!def.includes(`'${m}'`)) badMethods.push(`${name}: ${m}`);
  }
  const brokenChecks = new Set(badMethods.map((b) => b.split(":")[0])).size;
  console.log(
    `method checks: ${METHOD_CHECKS.length - brokenChecks}/${METHOD_CHECKS.length} complete`,
  );
  if (badMethods.length) {
    bad++;
    console.log("  MISSING METHODS: " + badMethods.join(", "));
  }

  // The same ten heads as EXPENSE_HEADS in src/lib/expense-heads.ts: a head on
  // the Expenses screen must be a head the constraint allows.
  const headDef = defs.get("expenses_category_check");
  const badHeads = !headDef ? HEADS : HEADS.filter((h) => !headDef.includes(`'${h}'`));
  console.log(`expense heads: ${HEADS.length - badHeads.length}/${HEADS.length} allowed`);
  if (badHeads.length) {
    bad++;
    console.log("  MISSING HEADS: " + badHeads.join(", "));
  }

  const counts = await sql`
    select (select count(*) from branches) as branches,
           (select count(*) from products) as products,
           (select count(*) from profiles) as profiles`;
  console.log("row counts: " + JSON.stringify(counts[0]));

  await sql.end();
  console.log(bad ? `\n${bad} PROBLEM(S)` : "\nDATABASE READY");
  process.exit(bad ? 1 : 0);
})();
