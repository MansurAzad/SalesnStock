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
  "employee_payroll",
  "employees",
  "expenses",
  "finance_cases",
  "finance_partner_ledger",
  "finance_partners",
  "installment_plans",
  "installments",
  "inventory_items",
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

  const counts = await sql`
    select (select count(*) from branches) as branches,
           (select count(*) from products) as products,
           (select count(*) from profiles) as profiles`;
  console.log("row counts: " + JSON.stringify(counts[0]));

  await sql.end();
  console.log(bad ? `\n${bad} PROBLEM(S)` : "\nDATABASE READY");
  process.exit(bad ? 1 : 0);
})();
