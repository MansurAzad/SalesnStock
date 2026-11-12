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
  ["finance_cases", "payer_name"],
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

const VALIDATED_CHECKS = [
  ["finance_cases", "chk_finance_cases_amount"],
  ["finance_cases", "chk_finance_cases_commission"],
  ["finance_partners", "chk_finance_partners_comm"],
  ["purchases", "chk_purchases_total"],
  ["purchases", "chk_purchases_returned"],
  ["purchases", "chk_purchases_paid"],
  ["purchase_items", "chk_purchase_items_cost"],
  ["branches", "chk_branches_max_discount"],
  ["branches", "chk_branches_expense_limit"],
  ["products", "chk_products_prices"],
  ["sales", "chk_sales_amounts"],
  ["installment_plans", "chk_installment_plans"],
  ["installments", "chk_installments"],
  ["employees", "chk_employees_salary"],
];

const INTERNAL_FUNCTIONS = [
  "set_offline_replay",
  "clear_offline_replay",
  "inventory_movement_context",
  "take_inventory_movement_context",
];

const MANAGED_TABLES = [
  ["branches", "read branches"],
  ["products", "read products"],
  ["finance_partners", "read partners"],
  ["inventory_items", "read items"],
];

const EXPECTED_FUNCTIONS = [
  "create_sale",
  "create_partner_financed_sale",
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
  "audit_branch_change",
  "create_purchase",
  "pay_supplier",
  "return_purchase_item",
  "cancel_transfer",
  "update_pending_expense",
  "update_pending_finance_case",
  "cancel_pending_finance_case",
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
    select p.proname, p.oid::regprocedure::text as signature,
           p.prorettype = 'trigger'::regtype as is_trigger,
           exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                   where a.grantee = 0 and a.privilege_type = 'EXECUTE') as public_exec,
           has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec,
           has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_exec
    from pg_proc p
    join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.prokind = 'f'`;
  const fnSet = new Set(fns.map((r) => r.proname));
  const missingFn = EXPECTED_FUNCTIONS.filter((f) => !fnSet.has(f));
  console.log(`functions: ${fnSet.size} present`);
  if (missingFn.length) {
    bad++;
    console.log("  MISSING FUNCTIONS: " + missingFn.join(", "));
  }

  const permissionIssues = [];
  for (const fn of fns) {
    if (fn.public_exec) permissionIssues.push(`PUBLIC can execute ${fn.signature}`);
    if (fn.anon_exec) permissionIssues.push(`anon can execute ${fn.signature}`);
    const internal = fn.is_trigger || INTERNAL_FUNCTIONS.includes(fn.proname);
    if (internal && fn.auth_exec) {
      permissionIssues.push(`authenticated can execute internal ${fn.signature}`);
    } else if (!internal && EXPECTED_FUNCTIONS.includes(fn.proname) && !fn.auth_exec) {
      permissionIssues.push(`authenticated cannot execute ${fn.signature}`);
    }
  }
  const triggerFunctions = fns.filter((fn) => fn.is_trigger);
  if (triggerFunctions.length !== 7) {
    permissionIssues.push(`expected 7 trigger functions, found ${triggerFunctions.length}`);
  }
  console.log(`function permissions: ${permissionIssues.length} problem(s)`);
  if (permissionIssues.length) {
    bad++;
    for (const issue of permissionIssues) console.log(`  ${issue}`);
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

  if (noRls.length) bad++;

  const policies = await sql`
    select tablename, policyname, permissive, roles, cmd, qual, with_check
    from pg_policies where schemaname = 'public'`;
  const policyIssues = [];
  const uidSelect = /\(\s*SELECT\s+auth\.uid\(\)\s*(?:AS\s+\w+)?\s*\)/gi;
  const normalized = (expr) =>
    (expr ?? "")
      .replace(uidSelect, "auth.uid()")
      .replace(
        /\(\s*SELECT\s+(?:public\.)?can_write_hq\(auth\.uid\(\)\)\s*(?:AS\s+\w+)?\s*\)/gi,
        "can_write_hq(auth.uid())",
      )
      .replace(/public\.|[\s()]/g, "")
      .toLowerCase();
  for (const [table, readPolicy] of MANAGED_TABLES) {
    const rows = policies.filter((p) => p.tablename === table);
    if (rows.length !== 4 || rows.some((p) => p.cmd === "ALL")) {
      policyIssues.push(`${table}: expected SELECT plus separate INSERT/UPDATE/DELETE policies`);
    }
    for (const cmd of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
      const matches = rows.filter((p) => p.cmd === cmd);
      const p = matches[0];
      if (
        matches.length !== 1 ||
        p.permissive !== "PERMISSIVE" ||
        p.roles.length !== 1 ||
        p.roles[0] !== "authenticated"
      ) {
        policyIssues.push(`${table}: ${cmd} policy missing, duplicated or changed roles`);
        continue;
      }
      const hq = "can_write_hqauth.uid";
      const read = table === "inventory_items" ? "can_access_branchauth.uid,branch_id" : "true";
      const using = cmd === "INSERT" ? "" : cmd === "SELECT" ? read : hq;
      const check = cmd === "INSERT" || cmd === "UPDATE" ? hq : "";
      if (
        normalized(p.qual) !== using ||
        normalized(p.with_check) !== check ||
        (cmd === "SELECT" && p.policyname !== readPolicy)
      ) {
        policyIssues.push(`${table}: ${cmd} expressions changed`);
      }
    }
  }
  for (const p of policies) {
    for (const expr of [p.qual, p.with_check]) {
      if (!expr) continue;
      if (/auth\.uid\(\)/i.test(expr.replace(uidSelect, ""))) {
        policyIssues.push(`${p.tablename}.${p.policyname}: auth.uid() lacks scalar SELECT`);
      }
      if (/\bSELECT\s+(?:public\.)?can_(?:access|operate|approve)_branch\s*\(/i.test(expr)) {
        policyIssues.push(`${p.tablename}.${p.policyname}: branch predicate moved into SELECT`);
      }
    }
  }
  const duplicateReads = await sql`
    select c.relname, r.rolname, count(*)::int as n
    from pg_policy p
    join pg_class c on c.oid = p.polrelid
    join pg_namespace ns on ns.oid = c.relnamespace
    cross join pg_roles r
    where ns.nspname = 'public' and p.polpermissive and p.polcmd in ('r', '*')
      and r.rolname in ('anon', 'authenticated')
      and (0 = any(p.polroles) or exists (
        select 1 from unnest(p.polroles) pr(role_oid)
        where pg_has_role(r.oid, nullif(pr.role_oid, 0), 'USAGE')))
    group by c.relname, r.rolname having count(*) > 1`;
  for (const p of duplicateReads) {
    policyIssues.push(`${p.relname}: ${p.n} permissive SELECT policies for ${p.rolname}`);
  }
  console.log(`RLS policies: ${policyIssues.length} problem(s)`);
  if (policyIssues.length) {
    bad++;
    for (const issue of policyIssues) console.log(`  ${issue}`);
  }

  const grants = await sql`
    select c.relname, v.privilege,
           has_table_privilege('authenticated', c.oid, v.privilege) as allowed,
           case when v.privilege in ('INSERT', 'UPDATE')
             then has_any_column_privilege('authenticated', c.oid, v.privilege)
             else false
           end as column_write
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) v(privilege)
    where n.nspname = 'public'
      and c.relname = any(${MANAGED_TABLES.map(([table]) => table)}::text[])`;
  const changedGrants = grants.filter((g) => {
    const expected = g.relname !== "inventory_items" || ["SELECT", "DELETE"].includes(g.privilege);
    return g.allowed !== expected || (!expected && g.column_write);
  });
  console.log(`managed table grants: ${changedGrants.length} changed; ${grants.length}/16 checked`);
  if (changedGrants.length || grants.length !== 16) {
    bad++;
    for (const g of changedGrants) {
      console.log(
        `  ${g.relname}: ${g.privilege} = ${g.allowed}, column write = ${g.column_write}`,
      );
    }
  }

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
    select c.conname, c.convalidated, t.relname as table_name,
           pg_get_constraintdef(c.oid) as def
    from pg_constraint c left join pg_class t on t.oid = c.conrelid
    where c.connamespace = 'public'::regnamespace and c.contype = 'c'`;
  const defs = new Map(constraints.map((r) => [r.conname, r.def]));
  const unvalidated = constraints.filter((c) => !c.convalidated);
  const missingChecks = VALIDATED_CHECKS.filter(([table, name]) => {
    const matches = constraints.filter((c) => c.table_name === table && c.conname === name);
    return matches.length !== 1 || !matches[0].convalidated;
  });
  console.log(
    `validated money checks: ${14 - missingChecks.length}/14; unvalidated public checks: ${unvalidated.length}`,
  );
  if (missingChecks.length || unvalidated.length) {
    bad++;
    for (const [table, name] of missingChecks)
      console.log(`  MISSING OR UNVALIDATED ${table}.${name}`);
    for (const c of unvalidated) console.log(`  UNVALIDATED ${c.table_name}.${c.conname}`);
  }

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

  const [expenseIndexes] = await sql`
    select to_regclass('public.idx_expenses_branch_date') is null as duplicate_dropped,
           exists (
             select 1 from pg_index i
             join pg_class c on c.oid = i.indexrelid
             join pg_am am on am.oid = c.relam
             where i.indexrelid = to_regclass('public.idx_expenses_date')
               and i.indrelid = 'public.expenses'::regclass
               and i.indisvalid and i.indisready and not i.indisunique
               and i.indnatts = 2 and i.indnkeyatts = 2
               and i.indpred is null and i.indexprs is null and am.amname = 'btree'
               and pg_get_indexdef(i.indexrelid, 1, true) = 'branch_id'
               and pg_get_indexdef(i.indexrelid, 2, true) = 'expense_date'
           ) as equivalent_retained`;
  console.log(
    `expense indexes: duplicate dropped = ${expenseIndexes.duplicate_dropped}, equivalent retained = ${expenseIndexes.equivalent_retained}`,
  );
  if (!expenseIndexes.duplicate_dropped || !expenseIndexes.equivalent_retained) bad++;

  const counts = await sql`
    select (select count(*) from branches) as branches,
           (select count(*) from products) as products,
           (select count(*) from profiles) as profiles`;
  console.log("row counts: " + JSON.stringify(counts[0]));

  await sql.end();
  console.log(bad ? `\n${bad} PROBLEM(S)` : "\nDATABASE READY");
  process.exit(bad ? 1 : 0);
})();
