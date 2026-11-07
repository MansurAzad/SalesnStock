/**
 * End-to-end smoke test for the live database.
 *
 * Every scenario runs inside one transaction that is rolled back when the run
 * ends, so the live data is never touched and the first-signup Super Admin
 * slot stays free. Users are simulated with `SET ROLE authenticated` plus a
 * fake JWT, so RLS and every permission check behave exactly as they do in
 * the browser.
 *
 * Usage: DB_URL="postgres://…" node scripts/db-smoke-test.cjs
 */
const postgres = require("postgres").default;

const sql = postgres(process.env.DB_URL, { max: 1 });

const U = {
  super: "00000000-0000-0000-0000-000000000001",
  dealer: "00000000-0000-0000-0000-000000000002",
  manager: "00000000-0000-0000-0000-000000000003",
  salesA: "00000000-0000-0000-0000-000000000004",
  salesB: "00000000-0000-0000-0000-000000000005",
  accountant: "00000000-0000-0000-0000-000000000006",
  helper: "00000000-0000-0000-0000-000000000007",
};

const results = [];

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function eq(actual, expected, msg) {
  const a = String(actual);
  const e = String(expected);
  const na = Number(a);
  const ne = Number(e);
  if (a.trim() !== "" && e.trim() !== "" && Number.isFinite(na) && Number.isFinite(ne)) {
    assert(Math.abs(na - ne) < 1e-9, `${msg} — expected ${expected}, got ${actual}`);
    return;
  }
  assert(a === e, `${msg} — expected ${expected}, got ${actual}`);
}

function near(actual, expected, msg, tol = 0.005) {
  const a = Number(actual);
  const e = Number(expected);
  assert(Math.abs(a - e) <= tol, `${msg} — expected ~${e}, got ${a}`);
}

let txRef = null;
let savepointSeq = 0;

/**
 * Runs one scenario inside its own savepoint, so a failing scenario is undone
 * and the scenarios after it still run against a usable transaction.
 */
async function step(name, fn) {
  const sp = `smoke_sp_${(savepointSeq += 1)}`;
  try {
    await txRef.unsafe(`savepoint ${sp}`);
  } catch {
    /* the transaction is already broken, the failure below will report it */
  }
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`PASS  ${name}`);
  } catch (err) {
    results.push({ name, ok: false, error: err.message });
    console.log(`FAIL  ${name}\n      ${err.message}`);
    try {
      await txRef.unsafe(`rollback to savepoint ${sp}`);
    } catch {
      /* nothing else can be done for this transaction */
    }
  }
}

const as = async (tx, uid) => {
  await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: uid, role: "authenticated" })}, true)`;
  await tx`set local role authenticated`;
};

const asDb = async (tx) => {
  await tx`set local role postgres`;
};

/**
 * Runs a call that is expected to fail and returns the error message.
 * The call happens inside a PL/pgSQL block with an exception handler, so the
 * failure does not abort the surrounding transaction.
 */
async function expectError(tx, label, fnName, args, expected) {
  const rows =
    await tx`select pg_temp.smoke_try(${fnName}, ${JSON.stringify(args)}::text::jsonb) as msg`;
  const msg = rows[0].msg;
  if (msg === "NO ERROR") throw new Error(`${label} — the call was expected to fail but succeeded`);
  if (expected && !msg.includes(expected)) {
    throw new Error(`${label} — expected an error containing "${expected}", got "${msg}"`);
  }
  return msg;
}

async function seed(tx) {
  // The test is the only admin team it knows about, so the roles that already
  // exist on the live database are cleared for the duration of the run. The
  // whole run lives in one transaction that is rolled back at the end, so the
  // real accounts keep their roles.
  await tx`delete from public.user_roles`;

  const [brA] = await tx`
    insert into public.branches (name, code, max_discount_pct, expense_limit)
    values ('Smoke Branch A', 'SMK-A', 10, 5000) returning id`;
  const [brB] = await tx`
    insert into public.branches (name, code, max_discount_pct, expense_limit)
    values ('Smoke Branch B', 'SMK-B', 5, 1000) returning id`;

  const [prod] = await tx`
    insert into public.products (brand, model, variant, purchase_price, sale_price, min_stock)
    values ('SmokeBrand', 'ModelX', '8/128', 10000, 12000, 2) returning id`;
  const [prodLow] = await tx`
    insert into public.products (brand, model, variant, purchase_price, sale_price, min_stock)
    values ('SmokeBrand', 'ModelY', '8/256', 20000, 24000, 10) returning id`;

  const [custA] = await tx`
    insert into public.customers (branch_id, name, phone) values (${brA.id}, 'Smoke Customer A', '01700000001') returning id`;
  const [custDue] = await tx`
    insert into public.customers (branch_id, name, phone) values (${brA.id}, 'Smoke Customer Due', '01700000003') returning id`;
  const [custB] = await tx`
    insert into public.customers (branch_id, name, phone) values (${brB.id}, 'Smoke Customer B', '01700000002') returning id`;

  const [supplier] = await tx`
    insert into public.suppliers (name, phone) values ('Smoke Supplier', '01800000001') returning id`;

  const [partner] = await tx`
    insert into public.finance_partners (name, contact, commission_pct) values ('Smoke Finance', '01900000001', 5) returning id`;

  const staff = [];
  for (let i = 1; i <= 2; i += 1) {
    const [row] = await tx`
      insert into public.employees (branch_id, name, salary, designation)
      values (${brA.id}, ${`Smoke Staff ${i}`}, ${10000 * i}, 'Sales Executive') returning id`;
    staff.push(row);
  }

  const users = [
    [U.super, "HQ Super Admin", "super_admin", null],
    [U.dealer, "Dealer Admin", "dealer_admin", null],
    [U.manager, "Manager A", "branch_manager", brA.id],
    [U.salesA, "Sales A", "sales", brA.id],
    [U.salesB, "Sales B", "sales", brB.id],
    [U.accountant, "Accountant A", "accountant", brA.id],
    [U.helper, "Helper A", "sales", brA.id],
  ];
  for (const [id, name, role, branch] of users) {
    await tx`
      insert into auth.users (id, aud, role, email, encrypted_password, email_confirmed_at,
                              raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
      values (${id}, 'authenticated', 'authenticated', ${`${id}@example.test`}, 'x', now(),
              '{"provider":"email","providers":["email"]}'::jsonb,
              ${JSON.stringify({ full_name: name })}::text::jsonb, now(), now())`;
    // The signup trigger already made a profile and may have granted the first
    // account the super admin role. Both rows go away with the rollback, but
    // the test wants exactly the roles it sets up itself.
    await tx`delete from public.user_roles where user_id = ${id}`;
    await tx`delete from public.profiles where id = ${id}`;
    await tx`
      insert into public.profiles (id, full_name, email, branch_id)
      values (${id}, ${name}, ${`${id}@example.test`}, ${branch})`;
    await tx`insert into public.user_roles (user_id, role) values (${id}, ${role})`;
  }

  // Fresh stock for every scenario, so one sold item never breaks the next
  // check. Stock is inserted as the database owner — the app never creates
  // inventory rows without going through a purchase.
  let seq = 0;
  const mintItem = async (branchId, price = 10000) => {
    seq += 1;
    await tx`set local role postgres`;
    const [row] = await tx`
      insert into public.inventory_items (product_id, branch_id, imei, purchase_price)
      values (${prod.id}, ${branchId}, ${`SMK-STOCK-${seq}`}, ${price}) returning id`;
    await tx`set local role authenticated`;
    return row;
  };

  return {
    brA,
    brB,
    prod,
    prodLow,
    custA,
    custDue,
    custB,
    supplier,
    partner,
    staff,
    mintItem,
  };
}

async function runAll(tx) {
  txRef = tx;
  // A leaked idle transaction would keep its locks and block the next run, so
  // the database is asked to drop it if this one is ever left hanging.
  await tx`set local idle_in_transaction_session_timeout = '60s'`;
  await tx`
    create function pg_temp.smoke_try(p_fn text, p_args jsonb) returns text
    language plpgsql as $$
    declare
      types text[];
      cats  text[];
      elems text[];
      vals  text[];
      parts text[];
      stmt  text;
    begin
      -- the argument types come from the function itself, so the test never
      -- has to spell out a cast for every call
      select array_agg(t.typname order by u.ord),
             array_agg(t.typcategory order by u.ord),
             array_agg(et.typname order by u.ord),
             array_agg(x.val order by u.ord)
        into types, cats, elems, vals
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        cross join lateral unnest(p.proargtypes) with ordinality as u(oid, ord)
        join pg_type t on t.oid = u.oid
        left join pg_type et on et.oid = t.typelem
        cross join lateral jsonb_array_elements_text(p_args) with ordinality as x(val, ord)
       where n.nspname = 'public'
         and p.proname = p_fn
         and u.ord = x.ord
         and (select count(*) from unnest(p.proargtypes)) = jsonb_array_length(p_args)
       group by p.oid;

      if types is null then return 'NO FUNCTION ' || p_fn; end if;

      select array_agg(
        case when cats[i] = 'A'
             then format('ARRAY[%s]::%s',
                  (select string_agg(format('%L::%s', e.val #>> '{}', elems[i]), ', ')
                     from jsonb_array_elements(vals[i]::jsonb) as e(val)),
                  types[i])
             else format('%L::%s', vals[i], types[i])
        end order by i)
        into parts
        from generate_series(1, array_length(types, 1)) as g(i);

      stmt := format('select public.%I(%s)', p_fn, array_to_string(parts, ', '));
      begin
        execute stmt;
        return 'NO ERROR';
      exception when others then
        return sqlerrm;
      end;
    end $$`;

  const ctx = await seed(tx);
  const { brA, brB, prod, prodLow, custA, custDue, custB, supplier, partner, staff, mintItem } =
    ctx;

  const cart = (itemId, price = 12000) => JSON.stringify([{ item_id: itemId, price }]);

  // ---------------------------------------------------------------------
  // 1. Cash sale
  // ---------------------------------------------------------------------
  let saleId = null;
  await step("cash sale is recorded, the item is sold and the money is booked", async () => {
    const item = await mintItem(brA.id);
    await as(tx, U.salesA);
    const rows = await tx`
      select public.create_sale(${brA.id}, ${custA.id}, ${cart(item.id)}::text::jsonb, 0, 12000, 'cash', 'cash', null, null) as id`;
    saleId = rows[0].id;
    assert(saleId, "create_sale returned no id");

    await asDb(tx);
    const [sale] = await tx`select * from public.sales where id = ${saleId}`;
    eq(sale.subtotal, 12000, "sales.subtotal");
    eq(sale.discount, 0, "sales.discount");
    eq(sale.total, 12000, "sales.total");
    eq(sale.paid, 12000, "sales.paid");
    eq(sale.status, "completed", "sales.status");

    const [line] = await tx`select price from public.sale_items where sale_id = ${saleId}`;
    eq(line.price, 12000, "sale_items.price");

    const [stock] = await tx`select status from public.inventory_items where id = ${item.id}`;
    eq(stock.status, "sold", "inventory_items.status");

    const [entry] = await tx`
      select * from public.transactions where ref_id = ${saleId} and kind = 'income'`;
    eq(entry.amount, 12000, "transactions.amount");
    eq(entry.category, "Sales", "transactions.category");
    eq(entry.method, "cash", "transactions.method");
  });

  await step("a cash sale that is not fully paid is refused", async () => {
    const item = await mintItem(brA.id);
    await as(tx, U.salesA);
    await expectError(
      tx,
      "cash sale not fully paid",
      "create_sale",
      [brA.id, custA.id, JSON.parse(cart(item.id)), 0, 5000, "cash", "cash", null, null],
      "Cash sale must be fully paid",
    );
  });

  await step("a discount without a reason is refused", async () => {
    const item = await mintItem(brA.id);
    await as(tx, U.salesA);
    await expectError(
      tx,
      "discount without reason",
      "create_sale",
      [brA.id, custA.id, JSON.parse(cart(item.id)), 1000, 11000, "cash", "cash", null, null],
      "A reason is required for this discount",
    );
  });

  await step("a discount above the branch limit needs a manager", async () => {
    const item = await mintItem(brA.id);
    await as(tx, U.salesA);
    await expectError(
      tx,
      "discount above limit",
      "create_sale",
      [
        brA.id,
        custA.id,
        JSON.parse(cart(item.id)),
        2000,
        10000,
        "cash",
        "cash",
        null,
        "manager deal",
      ],
      "needs manager approval",
    );
  });

  await step("the branch manager can complete the same discount", async () => {
    const item = await mintItem(brA.id);
    await as(tx, U.manager);
    const rows = await tx`
      select public.create_sale(${brA.id}, ${custA.id}, ${cart(item.id)}::text::jsonb, 2000, 10000, 'cash', 'cash', null, 'manager deal') as id`;
    assert(rows[0].id, "the manager's sale was not created");
    await asDb(tx);
    const [sale] = await tx`select * from public.sales where id = ${rows[0].id}`;
    eq(sale.discount, 2000, "the manager's sale discount");
    eq(sale.total, 10000, "the manager's sale total");
    eq(sale.discount_reason, "manager deal", "the manager's sale reason");
    assert(sale.discount_approved_by === U.manager, "the approver was not recorded");
  });

  await step("stock from another branch cannot be sold", async () => {
    const item = await mintItem(brB.id);
    await as(tx, U.salesA);
    await expectError(
      tx,
      "foreign stock",
      "create_sale",
      [brA.id, null, JSON.parse(cart(item.id)), 0, 12000, "cash", "cash", null, null],
      "Some items are not available in this branch",
    );
  });

  await step("a branch cannot be operated by another branch's user", async () => {
    await as(tx, U.salesA);
    await expectError(
      tx,
      "foreign branch",
      "create_sale",
      [
        brB.id,
        null,
        JSON.parse(cart("00000000-0000-0000-0000-000000009999")),
        0,
        12000,
        "cash",
        "cash",
        null,
        null,
      ],
      "Not allowed for this branch",
    );
  });

  await step("a customer of another branch cannot be used", async () => {
    const item = await mintItem(brA.id);
    await as(tx, U.salesA);
    await expectError(
      tx,
      "foreign customer",
      "create_sale",
      [brA.id, custB.id, JSON.parse(cart(item.id)), 0, 12000, "cash", "cash", null, null],
      "Customer does not belong to this branch",
    );
  });

  await step("the same item cannot be added to the cart twice", async () => {
    const item = await mintItem(brA.id);
    const twins = JSON.stringify([
      { item_id: item.id, price: 12000 },
      { item_id: item.id, price: 12000 },
    ]);
    await as(tx, U.salesA);
    await expectError(
      tx,
      "duplicate cart line",
      "create_sale",
      [brA.id, custA.id, JSON.parse(twins), 0, 24000, "cash", "cash", null, null],
      "The same item was added to the cart twice",
    );
  });

  // ---------------------------------------------------------------------
  // 2. Installments
  // ---------------------------------------------------------------------
  let planId = null;
  let firstInst = null;
  await step("an installment sale builds a schedule that adds up exactly", async () => {
    const item = await mintItem(brA.id);
    await as(tx, U.salesA);
    const rows = await tx`
      select public.create_sale(${brA.id}, ${custA.id}, ${cart(item.id)}::text::jsonb, 0, 4000, 'cash', 'installment', 3, null) as id`;
    const instSaleId = rows[0].id;
    assert(instSaleId, "the installment sale was not created");

    await asDb(tx);
    const [plan] = await tx`select * from public.installment_plans where sale_id = ${instSaleId}`;
    planId = plan.id;
    eq(plan.financed_amount, 8000, "installment_plans.financed_amount");
    eq(plan.down_payment, 4000, "installment_plans.down_payment");
    eq(plan.months, 3, "installment_plans.months");
    eq(plan.status, "active", "installment_plans.status");

    const schedule =
      await tx`select * from public.installments where plan_id = ${planId} order by seq`;
    eq(schedule.length, 3, "the number of installments");
    const sum = schedule.reduce((acc, row) => acc + Number(row.amount), 0);
    near(sum, 8000, "the schedule adds up to the financed amount");
    assert(
      schedule.every((row) => Number(row.amount) > 0),
      "the schedule has a zero installment",
    );
    firstInst = schedule[0];

    const [down] = await tx`
      select * from public.transactions where ref_id = ${instSaleId} and kind = 'income'`;
    eq(down.amount, 4000, "the down payment");
    eq(down.category, "Down payment", "the down payment category");
  });

  await step("an installment can be paid and the money is booked", async () => {
    await as(tx, U.salesA);
    await tx`select public.pay_installment(${firstInst.id}, 2666.66, 'cash')`;
    await asDb(tx);
    const [row] = await tx`select * from public.installments where id = ${firstInst.id}`;
    near(row.paid_amount, 2666.66, "installments.paid_amount");
    const [entry] = await tx`
      select * from public.transactions where ref_id = ${planId} and kind = 'income'`;
    near(entry.amount, 2666.66, "the installment transaction");
    eq(entry.category, "Installment", "the installment category");
  });

  await step("an installment cannot be overpaid", async () => {
    await as(tx, U.salesA);
    await expectError(
      tx,
      "overpayment",
      "pay_installment",
      [firstInst.id, 999999, "cash"],
      "Amount must be between",
    );
  });

  await step("an installment of another branch cannot be paid", async () => {
    await as(tx, U.salesB);
    await expectError(
      tx,
      "foreign installment",
      "pay_installment",
      [firstInst.id, 100, "cash"],
      "Not allowed",
    );
  });

  await step("paying every installment closes the plan", async () => {
    await as(tx, U.salesA);
    const rest =
      await tx`select * from public.installments where plan_id = ${planId} and paid_amount < amount order by seq`;
    for (const row of rest) {
      const due = Number(row.amount) - Number(row.paid_amount);
      await tx`select public.pay_installment(${row.id}, ${due}, 'cash')`;
    }
    await asDb(tx);
    const [plan] = await tx`select * from public.installment_plans where id = ${planId}`;
    eq(plan.status, "completed", "the finished plan status");
  });

  await step("an unpaid kisti stays on the books of the customer", async () => {
    const item = await mintItem(brA.id);
    await as(tx, U.salesA);
    const rows = await tx`
      select public.create_sale(${brA.id}, ${custDue.id}, ${cart(item.id)}::text::jsonb, 0, 2000, 'cash', 'installment', 2, null) as id`;
    assert(rows[0].id, "the second installment sale was not created");

    await asDb(tx);
    const [plan] = await tx`select * from public.installment_plans where sale_id = ${rows[0].id}`;
    eq(plan.financed_amount, 10000, "the financed amount");
    eq(plan.months, 2, "the number of months");
    const schedule =
      await tx`select * from public.installments where plan_id = ${plan.id} order by seq`;
    eq(schedule.length, 2, "the number of installments");
    near(schedule[0].amount, 5000, "the first installment");
    near(schedule[1].amount, 5000, "the last installment");
    assert(schedule[0].due_date > new Date(), "the first due date is not in the future");
  });

  // ---------------------------------------------------------------------
  // 3. Transfers
  // ---------------------------------------------------------------------
  await step("stock can be transferred between branches", async () => {
    const item = await mintItem(brA.id);
    await as(tx, U.salesA);
    const rows = await tx`
      select public.create_transfer(${brA.id}, ${brB.id}, ${[item.id]}::uuid[], 'moving stock') as id`;
    const transferId = rows[0].id;
    assert(transferId, "the transfer was not created");

    await asDb(tx);
    const [transfer] = await tx`select * from public.stock_transfers where id = ${transferId}`;
    eq(transfer.status, "in_transit", "the transfer status");
    const [moved] = await tx`select status from public.inventory_items where id = ${item.id}`;
    eq(moved.status, "in_transit", "the item status while in transit");

    await as(tx, U.salesB);
    await tx`select public.receive_transfer(${transferId})`;
    await asDb(tx);
    const [after] = await tx`select * from public.stock_transfers where id = ${transferId}`;
    eq(after.status, "received", "the transfer status after receiving");
    const [stock] = await tx`select * from public.inventory_items where id = ${item.id}`;
    eq(stock.branch_id, brB.id, "the item branch after receiving");
    eq(stock.status, "in_stock", "the item status after receiving");
  });

  await step("a transfer to the same branch is refused", async () => {
    const item = await mintItem(brA.id);
    await as(tx, U.salesA);
    await expectError(
      tx,
      "same branch transfer",
      "create_transfer",
      [brA.id, brA.id, [item.id], "x"],
      "Source and destination must differ",
    );
  });

  await step("a transfer can be cancelled and the stock returns to the source", async () => {
    const item = await mintItem(brA.id);
    await as(tx, U.salesA);
    const rows = await tx`
      select public.create_transfer(${brA.id}, ${brB.id}, ${[item.id]}::uuid[], 'cancelling') as id`;
    const transferId = rows[0].id;

    await as(tx, U.manager);
    await expectError(
      tx,
      "cancel without a reason",
      "cancel_transfer",
      [transferId, "   "],
      "Cancellation reason is required",
    );

    await tx`select public.cancel_transfer(${transferId}, 'changed plans')`;
    await asDb(tx);
    const [transfer] = await tx`select * from public.stock_transfers where id = ${transferId}`;
    eq(transfer.status, "cancelled", "the cancelled transfer status");
    const [stock] = await tx`select * from public.inventory_items where id = ${item.id}`;
    eq(stock.branch_id, brA.id, "the item branch after cancelling");
    eq(stock.status, "in_stock", "the item status after cancelling");
  });

  await step("only the source branch manager can cancel a transfer", async () => {
    const item = await mintItem(brA.id);
    await as(tx, U.salesA);
    const rows = await tx`
      select public.create_transfer(${brA.id}, ${brB.id}, ${[item.id]}::uuid[], 'to be cancelled') as id`;
    await expectError(
      tx,
      "salesman cancels",
      "cancel_transfer",
      [rows[0].id, "not allowed"],
      "Only the source branch manager or admin can cancel",
    );
  });

  // ---------------------------------------------------------------------
  // 4. Sale return
  // ---------------------------------------------------------------------
  await step("a returned sale puts the stock back and books the refund", async () => {
    await as(tx, U.manager);
    await tx`select public.return_sale(${saleId}, 'customer changed mind')`;
    await asDb(tx);
    const [sale] = await tx`select * from public.sales where id = ${saleId}`;
    eq(sale.status, "returned", "the returned sale status");
    eq(sale.return_reason, "customer changed mind", "the return reason");
    const [refund] = await tx`
      select * from public.transactions where ref_id = ${saleId} and kind = 'expense'`;
    near(refund.amount, 12000, "the refund amount");
    eq(refund.category, "Sale refund", "the refund category");
  });

  await step("a sale cannot be returned twice", async () => {
    await as(tx, U.manager);
    await expectError(
      tx,
      "double return",
      "return_sale",
      [saleId, "again"],
      "Sale already returned",
    );
  });

  await step("a return without a reason is refused", async () => {
    const item = await mintItem(brA.id);
    await as(tx, U.salesA);
    const rows = await tx`
      select public.create_sale(${brA.id}, ${custA.id}, ${cart(item.id)}::text::jsonb, 0, 12000, 'cash', 'cash', null, null) as id`;
    const otherSale = rows[0].id;
    await as(tx, U.manager);
    await expectError(
      tx,
      "return without reason",
      "return_sale",
      [otherSale, ""],
      "Reason is required",
    );
  });

  await step("a salesman cannot return a sale", async () => {
    const item = await mintItem(brA.id);
    await as(tx, U.salesA);
    const rows = await tx`
      select public.create_sale(${brA.id}, ${custA.id}, ${cart(item.id)}::text::jsonb, 0, 12000, 'cash', 'cash', null, null) as id`;
    const otherSale = rows[0].id;
    await expectError(
      tx,
      "salesman return",
      "return_sale",
      [otherSale, "not allowed"],
      "Only a branch manager or admin can return a sale",
    );
  });

  // ---------------------------------------------------------------------
  // 5. Expenses — the ten heads, the voucher, the signature
  // ---------------------------------------------------------------------
  let voucherPending = null;
  let voucherSmall = null;
  let voucherTravel = null;

  await step("an expense below the branch limit is approved straight away", async () => {
    await as(tx, U.manager);
    const rows = await tx`
      select public.submit_expense(${brA.id}, 'Food', 500, current_date, 'cash', 'client visit', '', 'BILL-1') as voucher`;
    const voucher = rows[0].voucher;
    assert(/^EXP-/.test(voucher), `the voucher is not an expense voucher: ${voucher}`);
    voucherSmall = voucher;
    await asDb(tx);
    const [expense] = await tx`select * from public.expenses where voucher_no = ${voucher}`;
    assert(expense, "the expense row was not written");
    eq(expense.status, "approved", "the stored expense status");
    eq(expense.approved_by, U.manager, "the auto approval is not signed by the submitter");
    assert(expense.approved_at, "the auto approval has no date");
    eq(expense.bill_no, "BILL-1", "the bill number on the expense");
    const [entry] = await tx`select * from public.transactions where ref_id = ${expense.id}`;
    near(entry.amount, 500, "the expense transaction");
    eq(entry.category, "Food", "the expense cash book head");
  });

  await step("an expense above the branch limit waits for the head office", async () => {
    await as(tx, U.manager);
    const rows = await tx`
      select public.submit_expense(${brA.id}, 'Transport', 9000, current_date, 'cash', 'travel', '') as voucher`;
    voucherPending = rows[0].voucher;
    await asDb(tx);
    const [expense] = await tx`select * from public.expenses where voucher_no = ${voucherPending}`;
    eq(expense.status, "pending", "an oversized expense must wait");
    assert(expense.approved_by === null, "a pending expense already has an approver");
    assert(expense.approved_at === null, "a pending expense already has an approval date");
    const [entry] =
      await tx`select count(*)::int as n from public.transactions where ref_id = ${expense.id}`;
    eq(entry.n, 0, "a pending expense must not touch the cash book");
  });

  await step("a salesman cannot approve an expense", async () => {
    await as(tx, U.salesA);
    const rows = await tx`
      select public.submit_expense(${brA.id}, 'Food', 200, current_date, 'cash', 'lunch', '') as voucher`;
    const voucher = rows[0].voucher;
    assert(voucher !== voucherSmall, "two expenses were issued the same voucher");
    voucherTravel = voucher;
    await asDb(tx);
    const [expense] = await tx`select * from public.expenses where voucher_no = ${voucher}`;
    eq(expense.status, "pending", "a salesman expense must wait for approval");
    await as(tx, U.salesA);
    await expectError(
      tx,
      "salesman approves",
      "decide_expense",
      [expense.id, true],
      "Only admin can approve",
    );
  });

  await step("a head that is not one of the ten is refused", async () => {
    await as(tx, U.manager);
    await expectError(
      tx,
      "unknown expense head",
      "submit_expense",
      [
        brA.id,
        "Tea and snacks for the shop",
        500,
        new Date().toISOString().slice(0, 10),
        "cash",
        "note",
        "",
        "",
      ],
      "expenses_category_check",
    );
  });

  await step("the head office approves a pending expense and signs it", async () => {
    await asDb(tx);
    const [expense] = await tx`select * from public.expenses where voucher_no = ${voucherPending}`;
    await as(tx, U.super);
    await tx`select public.decide_expense(${expense.id}, true)`;
    await asDb(tx);
    const [after] = await tx`select * from public.expenses where id = ${expense.id}`;
    eq(after.status, "approved", "the approved expense status");
    eq(after.approved_by, U.super, "the approver of the expense");
    assert(after.approved_at, "the approval date of the expense");
    const [entry] = await tx`select * from public.transactions where ref_id = ${expense.id}`;
    near(entry.amount, 9000, "the approved expense transaction");
  });

  await step("a rejected expense never reaches the cash book", async () => {
    await asDb(tx);
    const [expense] = await tx`select * from public.expenses where voucher_no = ${voucherTravel}`;
    await as(tx, U.super);
    await tx`select public.decide_expense(${expense.id}, false)`;
    await asDb(tx);
    const [after] = await tx`select * from public.expenses where id = ${expense.id}`;
    eq(after.status, "rejected", "the rejected expense status");
    assert(after.approved_at === null, "a rejected expense must not carry an approval date");
    const [entry] =
      await tx`select count(*)::int as n from public.transactions where ref_id = ${expense.id}`;
    eq(entry.n, 0, "a rejected expense must not touch the cash book");
  });

  await step("only the creator or an admin may edit a pending expense", async () => {
    await as(tx, U.salesA);
    const rows = await tx`
      select public.submit_expense(${brA.id}, 'Transport', 300, current_date, 'cash', 'home', '', 'BILL-2') as voucher`;
    const voucher = rows[0].voucher;
    await asDb(tx);
    const [expense] = await tx`select * from public.expenses where voucher_no = ${voucher}`;

    await as(tx, U.helper);
    await expectError(
      tx,
      "helper edits",
      "update_pending_expense",
      [expense.id, "Transport", 300, "2026-11-03", "cash", "home", "", ""],
      "Only the creator or an admin can edit this expense",
    );

    await as(tx, U.salesA);
    await tx`select public.update_pending_expense(${expense.id}, 'Repair', 350, '2026-11-03', 'cash', 'home', '', 'BILL-3')`;
    await asDb(tx);
    const [after] = await tx`select * from public.expenses where id = ${expense.id}`;
    eq(after.category, "Repair", "the edited category");
    near(after.amount, 350, "the edited amount");
    eq(after.bill_no, "BILL-3", "the edited bill number");
    eq(after.voucher_no, voucher, "the voucher of an edited expense");
  });

  // ---------------------------------------------------------------------
  // 6. Purchases
  // ---------------------------------------------------------------------
  let purchaseId = null;
  await step("a purchase adds stock and records the supplier due", async () => {
    await as(tx, U.manager);
    const rows = await tx`
      select public.create_purchase(${supplier.id}, ${brA.id}, 'SMK-INV-1',
        ${JSON.stringify([
          { product_id: prod.id, imei: "SMK-P-1", imei2: "", cost: 10000 },
          { product_id: prod.id, imei: "SMK-P-2", imei2: "", cost: 10000 },
        ])}::text::jsonb, 0, 'cash', 'opening stock') as id`;
    purchaseId = rows[0].id;
    assert(purchaseId, "the purchase was not created");

    await asDb(tx);
    const [purchase] = await tx`select * from public.purchases where id = ${purchaseId}`;
    eq(purchase.total, 20000, "purchases.total");
    eq(purchase.paid, 0, "purchases.paid");
    const lines = await tx`select * from public.purchase_items where purchase_id = ${purchaseId}`;
    eq(lines.length, 2, "the number of purchase lines");
    const stock = await tx`select * from public.inventory_items where imei like 'SMK-P-%'`;
    eq(stock.length, 2, "the number of new stock rows");
    assert(
      stock.every((row) => row.status === "in_stock"),
      "the new stock must be in stock",
    );
  });

  await step("the same IMEI cannot be bought twice", async () => {
    await as(tx, U.manager);
    await expectError(
      tx,
      "duplicate IMEI",
      "create_purchase",
      [
        supplier.id,
        brA.id,
        "SMK-INV-2",
        [{ product_id: prod.id, imei: "SMK-P-1", imei2: "", cost: 10000 }],
        0,
        "cash",
        "duplicate",
      ],
      "IMEI already exists",
    );
  });

  await step("a salesman cannot buy stock", async () => {
    await as(tx, U.salesA);
    await expectError(
      tx,
      "salesman buys",
      "create_purchase",
      [
        supplier.id,
        brA.id,
        "SMK-INV-3",
        [{ product_id: prod.id, imei: "SMK-P-9", imei2: "", cost: 10000 }],
        0,
        "cash",
        "",
      ],
      "Not allowed to purchase for this branch",
    );
  });

  await step("the supplier can be paid and the money leaves the cash book", async () => {
    await as(tx, U.manager);
    await tx`select public.pay_supplier(${purchaseId}, 15000, 'cash')`;
    await asDb(tx);
    const [purchase] = await tx`select * from public.purchases where id = ${purchaseId}`;
    eq(purchase.paid, 15000, "purchases.paid after the payment");
    const [entry] = await tx`
      select * from public.transactions where ref_id = ${purchaseId} and kind = 'expense'`;
    near(entry.amount, 15000, "the supplier payment transaction");
  });

  await step("paying more than the supplier due is refused", async () => {
    await as(tx, U.manager);
    await expectError(
      tx,
      "overpay supplier",
      "pay_supplier",
      [purchaseId, 999999, "cash"],
      "Amount exceeds supplier due",
    );
  });

  await step("a bought item can be returned to the supplier", async () => {
    await asDb(tx);
    const [line] =
      await tx`select * from public.purchase_items where purchase_id = ${purchaseId} limit 1`;
    await as(tx, U.manager);
    await tx`select public.return_purchase_item(${line.id})`;
    await asDb(tx);
    const [after] = await tx`select * from public.purchase_items where id = ${line.id}`;
    eq(after.returned, true, "the purchase line returned flag");
    const [stock] = await tx`select * from public.inventory_items where id = ${line.item_id}`;
    eq(stock.status, "returned", "the returned item status");
    const [purchase] = await tx`select * from public.purchases where id = ${purchaseId}`;
    near(purchase.returned, 10000, "purchases.returned");
    // 15000 was paid, 10000 of it covers the item that stays, so 5000 goes back.
    near(purchase.paid, 10000, "purchases.paid after the return");
    const [refund] = await tx`
      select * from public.transactions where ref_id = ${purchaseId} and kind = 'income'`;
    near(refund.amount, 5000, "the supplier refund");
    eq(refund.category, "Supplier refund", "the supplier refund category");
  });

  // ---------------------------------------------------------------------
  // 7. Finance partners
  // ---------------------------------------------------------------------
  await step("a finance case can be created and settled", async () => {
    await as(tx, U.salesA);
    const rows = await tx`
      select public.create_finance_case(${brA.id}, ${partner.id}, 'Financed Customer', '01711111111',
        'REF-1', 10000, 'phone on EMI', null) as id`;
    const caseId = rows[0].id;
    assert(caseId, "the finance case was not created");

    await asDb(tx);
    const [created] = await tx`select * from public.finance_cases where id = ${caseId}`;
    eq(created.status, "pending", "the finance case status");
    eq(created.amount, 10000, "the finance case amount");

    await as(tx, U.salesA);
    await tx`select public.settle_finance(${caseId}, 9000)`;
    await asDb(tx);
    const [settled] = await tx`select * from public.finance_cases where id = ${caseId}`;
    eq(settled.status, "settled", "the settled case status");
    near(settled.commission, 1000, "the settled commission");
    const [entry] = await tx`select * from public.transactions where ref_id = ${caseId}`;
    near(entry.amount, 9000, "the settlement transaction");
    eq(entry.category, "finance_settlement", "the settlement category");
    const [ledger] =
      await tx`select * from public.finance_partner_ledger where case_id = ${caseId}`;
    eq(ledger.kind, "received", "the ledger kind");
    near(ledger.amount, 9000, "the ledger amount");
  });

  await step("a finance case cannot be settled twice", async () => {
    await asDb(tx);
    const [created] =
      await tx`select * from public.finance_cases where partner_id = ${partner.id} limit 1`;
    await as(tx, U.salesA);
    await expectError(
      tx,
      "double settlement",
      "settle_finance",
      [created.id, 1000],
      "Already settled",
    );
  });

  await step("a settlement above the case amount is refused", async () => {
    await as(tx, U.salesA);
    const rows = await tx`
      select public.create_finance_case(${brA.id}, ${partner.id}, 'Financed Customer 2', '01722222222',
        'REF-2', 5000, 'phone on EMI', null) as id`;
    await expectError(
      tx,
      "over settlement",
      "settle_finance",
      [rows[0].id, 9000],
      "Invalid amount",
    );
  });

  await step("a partner payment lands in both the ledger and the cash book", async () => {
    await as(tx, U.salesA);
    await tx`select public.partner_payment(${partner.id}, ${brA.id}, 'paid', 5000, 'cash', 'advance')`;
    await asDb(tx);
    const [ledger] = await tx`
      select * from public.finance_partner_ledger where partner_id = ${partner.id} and kind = 'paid' order by created_at desc limit 1`;
    near(ledger.amount, 5000, "the partner ledger amount");
    const [entry] = await tx`
      select * from public.transactions where ref_id = ${partner.id} and kind = 'expense' order by created_at desc limit 1`;
    near(entry.amount, 5000, "the partner payment transaction");
    eq(entry.category, "Finance partner payment", "the partner payment category");
  });

  await step("an unknown partner payment kind is refused", async () => {
    await as(tx, U.salesA);
    await expectError(
      tx,
      "bad partner kind",
      "partner_payment",
      [partner.id, brA.id, "borrowed", 100, "cash", ""],
      "Invalid kind",
    );
  });

  // ---------------------------------------------------------------------
  // 8. Manual income and reversal
  // ---------------------------------------------------------------------
  let manualTx = null;
  await step("an accountant can add a manual income entry", async () => {
    await as(tx, U.accountant);
    const rows = await tx`
      select public.add_manual_income(${brA.id}, 'Service charge', 1000, 'installation fee', 'cash') as id`;
    manualTx = rows[0].id;
    assert(manualTx, "the manual income was not created");
    await asDb(tx);
    const [entry] = await tx`select * from public.transactions where id = ${manualTx}`;
    eq(entry.kind, "income", "the manual entry kind");
    near(entry.amount, 1000, "the manual entry amount");
    eq(entry.method, "cash", "the manual entry method");
  });

  await step("a branch manager can add a manual income entry", async () => {
    await as(tx, U.manager);
    const rows = await tx`
      select public.add_manual_income(${brA.id}, 'Service charge', 500, 'branch fee', 'cash') as id`;
    assert(rows[0].id, "the branch manager income was not created");
    await asDb(tx);
    const [entry] = await tx`select * from public.transactions where id = ${rows[0].id}`;
    eq(entry.kind, "income", "the branch manager entry kind");
    near(entry.amount, 500, "the branch manager entry amount");
  });

  await step("a salesman cannot add a manual income entry", async () => {
    await as(tx, U.salesA);
    await expectError(
      tx,
      "salesman income",
      "add_manual_income",
      [brA.id, "Service charge", 1000, "nope", "cash"],
      "Only an accountant, branch manager or admin can add an income entry",
    );
  });

  await step("a manual entry can be reversed once", async () => {
    await as(tx, U.accountant);
    await tx`select public.reverse_manual_transaction(${manualTx}, 'entered by mistake')`;
    await asDb(tx);
    const [reversal] = await tx`
      select * from public.transactions where ref_id = ${manualTx} and category = 'Reversal'`;
    assert(reversal, "the reversal was not written");
    eq(reversal.kind, "expense", "the reversal kind");
    near(reversal.amount, 1000, "the reversal amount");
  });

  await step("a manual entry cannot be reversed twice", async () => {
    await as(tx, U.accountant);
    await expectError(
      tx,
      "double reversal",
      "reverse_manual_transaction",
      [manualTx, "again"],
      "Transaction has already been reversed",
    );
  });

  await step("a linked transaction cannot be reversed by hand", async () => {
    await asDb(tx);
    const [entry] = await tx`
      select * from public.transactions where ref_id = ${saleId} and kind = 'expense' limit 1`;
    await as(tx, U.accountant);
    await expectError(
      tx,
      "linked reversal",
      "reverse_manual_transaction",
      [entry.id, "not allowed"],
      "Only manual, unlinked entries can be reversed here",
    );
  });

  // ---------------------------------------------------------------------
  // 9. Payroll
  // ---------------------------------------------------------------------
  await step("payroll pays the staff once per period", async () => {
    await as(tx, U.manager);
    const rows = await tx`
      select public.run_payroll(${brA.id}, '2026-11', ${[staff[0].id, staff[1].id]}::uuid[], 'November') as total`;
    near(rows[0].total, 30000, "the payroll total");
    await asDb(tx);
    const rows2 = await tx`select * from public.employee_payroll where period = '2026-11'`;
    eq(rows2.length, 2, "the payroll rows");
    const first = rows2.find((r) => r.employee_id === staff[0].id);
    const second = rows2.find((r) => r.employee_id === staff[1].id);
    assert(first, "the first employee has no payroll row");
    assert(second, "the second employee has no payroll row");
    eq(first.amount, 10000, "the first salary");
    eq(second.amount, 20000, "the second salary");
    const [entry] = await tx`
      select * from public.transactions where category = 'Staff salary' order by created_at desc limit 1`;
    near(entry.amount, 30000, "the salary transaction");
  });

  await step("the same period cannot be paid twice", async () => {
    await as(tx, U.manager);
    await expectError(
      tx,
      "double payroll",
      "run_payroll",
      [brA.id, "2026-11", [staff[0].id], "again"],
      "was already paid for",
    );
  });

  await step("a period must look like YYYY-MM", async () => {
    await as(tx, U.manager);
    await expectError(
      tx,
      "bad period",
      "run_payroll",
      [brA.id, "November", [staff[0].id], ""],
      "Period must look like",
    );
  });

  await step("a salesman cannot run payroll", async () => {
    await as(tx, U.salesA);
    await expectError(
      tx,
      "salesman payroll",
      "run_payroll",
      [brA.id, "2026-12", [staff[0].id], ""],
      "Not allowed to run payroll",
    );
  });

  await step("a payroll salary cannot be reversed into income", async () => {
    await asDb(tx);
    const [salary] = await tx`
      select * from public.transactions where category = 'Staff salary' order by created_at desc limit 1`;
    assert(salary, "there is no payroll transaction to test");
    await as(tx, U.manager);
    await expectError(
      tx,
      "payroll reversal",
      "reverse_manual_transaction",
      [salary.id, "not allowed"],
      "Only manual, unlinked entries can be reversed here",
    );
  });

  // ---------------------------------------------------------------------
  // 10. Damaged stock
  // ---------------------------------------------------------------------
  await step("damaged stock can be marked and restored", async () => {
    const item = await mintItem(brA.id);
    await as(tx, U.manager);
    await tx`select public.mark_inventory_damaged(${item.id}, 'screen cracked')`;
    await asDb(tx);
    const [damaged] = await tx`select status from public.inventory_items where id = ${item.id}`;
    eq(damaged.status, "damaged", "the damaged item status");

    await as(tx, U.salesA);
    await expectError(
      tx,
      "salesman restores",
      "restore_damaged_inventory",
      [item.id, "not allowed"],
      "Only the branch manager or admin can restore stock",
    );

    await as(tx, U.manager);
    await tx`select public.restore_damaged_inventory(${item.id}, 'repaired')`;
    await asDb(tx);
    const [restored] = await tx`select status from public.inventory_items where id = ${item.id}`;
    eq(restored.status, "in_stock", "the restored item status");
  });

  await step("damaging stock needs a reason", async () => {
    const item = await mintItem(brA.id);
    await as(tx, U.manager);
    await expectError(
      tx,
      "damage without reason",
      "mark_inventory_damaged",
      [item.id, "  "],
      "Damage reason is required",
    );
  });

  // ---------------------------------------------------------------------
  // 11. Offline queue
  // ---------------------------------------------------------------------
  await step("an offline sale is applied exactly once", async () => {
    const ref = "11111111-2222-3333-4444-555555555555";
    const item = await mintItem(brA.id);
    await as(tx, U.salesA);
    const payload = JSON.stringify({
      branch: brA.id,
      customer: "",
      phone: "01799999999",
      cust_name: "Offline Customer",
      items: [{ item_id: item.id, price: 12000 }],
      discount: 0,
      paid: 12000,
      method: "cash",
      sale_type: "cash",
      months: "",
      discount_reason: "",
    });
    const first = await tx`
      select public.apply_offline_op(${ref}::uuid, 'sale', ${payload}::text::jsonb, now(), 'smoke-device') as res`;
    eq(first[0].res.status, "applied", "the first offline result");

    const second = await tx`
      select public.apply_offline_op(${ref}::uuid, 'sale', ${payload}::text::jsonb, now(), 'smoke-device') as res`;
    eq(second[0].res.status, "applied", "the replayed offline result");

    await asDb(tx);
    const sales = await tx`
      select count(*)::int as n from public.sales where id = (select (result->>'sale_id')::uuid from public.offline_ops where client_ref = ${ref}::uuid)`;
    eq(sales[0].n, 1, "the offline sale was applied more than once");
    const [customer] = await tx`select * from public.customers where phone = '01799999999'`;
    assert(customer, "the offline customer was not created");
  });

  await step("an unknown offline action is recorded as a conflict", async () => {
    const ref = "99999999-2222-3333-4444-555555555555";
    await as(tx, U.salesA);
    const rows = await tx`
      select public.apply_offline_op(${ref}::uuid, 'teleport', '{}'::jsonb, now(), 'smoke-device') as res`;
    eq(rows[0].res.status, "conflict", "the conflict status");
    await asDb(tx);
    const [op] = await tx`select * from public.offline_ops where client_ref = ${ref}::uuid`;
    eq(op.status, "conflict", "the stored conflict status");
    assert(
      op.error && op.error.includes("Unknown offline action"),
      "the conflict error was not recorded",
    );
  });

  // ---------------------------------------------------------------------
  // 12. Role administration
  // ---------------------------------------------------------------------
  await step("a dealer admin cannot change a super admin", async () => {
    await as(tx, U.dealer);
    await expectError(
      tx,
      "dealer changes super",
      "admin_set_user",
      [U.super, "dealer_admin", null],
      "Only super admin can change a super admin",
    );
  });

  await step("a dealer admin cannot hand out the super admin role", async () => {
    await as(tx, U.dealer);
    await expectError(
      tx,
      "dealer grants super",
      "admin_set_user",
      [U.helper, "super_admin", null],
      "Only super admin can grant super admin",
    );
  });

  await step("a showroom role needs a branch", async () => {
    await as(tx, U.super);
    await expectError(
      tx,
      "sales without branch",
      "admin_set_user",
      [U.helper, "sales", null],
      "This role needs a branch",
    );
  });

  await step("an unknown branch is refused", async () => {
    await as(tx, U.super);
    await expectError(
      tx,
      "unknown branch",
      "admin_set_user",
      [U.helper, "sales", "11111111-1111-1111-1111-111111111111"],
      "Unknown branch",
    );
  });

  await step("a super admin can move a user to another role and branch", async () => {
    await as(tx, U.super);
    await tx`select public.admin_set_user(${U.helper}::uuid, 'branch_manager', ${brB.id}::uuid)`;
    await asDb(tx);
    const [profile] = await tx`select * from public.profiles where id = ${U.helper}::uuid`;
    eq(profile.branch_id, brB.id, "the new branch of the user");
    const [role] = await tx`select role from public.user_roles where user_id = ${U.helper}::uuid`;
    eq(role.role, "branch_manager", "the new role of the user");
  });

  await step("the last admin cannot be demoted", async () => {
    await as(tx, U.super);
    await tx`select public.admin_set_user(${U.dealer}::uuid, 'sales', ${brA.id}::uuid)`;
    await asDb(tx);
    await as(tx, U.super);
    await expectError(
      tx,
      "last admin",
      "admin_set_user",
      [U.super, "sales", brA.id],
      "Cannot remove the last admin",
    );
  });

  await step("an admin cannot revoke their own access", async () => {
    await as(tx, U.super);
    await expectError(
      tx,
      "self revoke",
      "admin_revoke_user_access",
      [U.super],
      "You cannot revoke your own access",
    );
  });

  await step("an admin can revoke another user's access", async () => {
    await as(tx, U.super);
    await tx`select public.admin_revoke_user_access(${U.helper}::uuid)`;
    await asDb(tx);
    const roles = await tx`select * from public.user_roles where user_id = ${U.helper}::uuid`;
    eq(roles.length, 0, "the revoked user still has a role");
    const [profile] = await tx`select * from public.profiles where id = ${U.helper}::uuid`;
    eq(profile.branch_id, null, "the revoked user still has a branch");
  });

  // ---------------------------------------------------------------------
  // 13. Row level security
  // ---------------------------------------------------------------------
  await step("a branch user only sees their own branch's rows", async () => {
    await as(tx, U.salesA);
    const own = await tx`select count(*)::int as n from public.sales`;
    assert(own[0].n > 0, "the branch user sees no sales at all");
    const foreign = await tx`
      select count(*)::int as n from public.sales where branch_id <> ${brA.id}`;
    eq(foreign[0].n, 0, "the branch user sees another branch's sales");

    await as(tx, U.salesB);
    const bSales = await tx`select count(*)::int as n from public.sales`;
    eq(bSales[0].n, 0, "branch B must not see branch A's sales");
  });

  await step("the head office sees every branch", async () => {
    const item = await mintItem(brB.id);
    await as(tx, U.salesB);
    await tx`
      select public.create_sale(${brB.id}, ${custB.id}, ${cart(item.id)}::text::jsonb, 0, 12000, 'cash', 'cash', null, null) as id`;

    await as(tx, U.super);
    const all = await tx`select count(*)::int as n from public.sales`;
    const branches = await tx`select count(distinct branch_id)::int as n from public.sales`;
    assert(all[0].n > 0, "the head office sees no sales");
    assert(branches[0].n >= 2, "the head office sees only one branch");
  });

  await step("a branch user cannot read another branch's transactions", async () => {
    await as(tx, U.salesA);
    const foreign = await tx`
      select count(*)::int as n from public.transactions where branch_id <> ${brA.id}`;
    eq(foreign[0].n, 0, "the branch user sees another branch's transactions");
  });

  // ---------------------------------------------------------------------
  // 14. Reporting functions
  // ---------------------------------------------------------------------
  await step("the reporting functions respect the branch of the caller", async () => {
    await as(tx, U.salesA);
    const stock = await tx`select * from public.stock_on_hand(null)`;
    assert(stock.length > 0, "the branch user sees no stock");
    assert(
      stock.every((row) => row.branch_id === brA.id),
      "the stock report leaks another branch",
    );

    const low = await tx`select * from public.low_stock_products(null)`;
    assert(low.length > 0, "the low stock report is empty");
    const lowRow = low.find((row) => row.product_id === prodLow.id);
    assert(lowRow, "the low stock report misses the product below its reorder level");
    eq(lowRow.min_stock, 10, "the reorder level in the low stock report");
    eq(lowRow.in_stock, 0, "the in-stock count in the low stock report");
    eq(lowRow.shortage, 10, "the shortage in the low stock report");

    const ageing = await tx`select * from public.kisti_ageing(null)`;
    assert(ageing.length > 0, "the ageing report is empty");
    const totals = ageing.reduce((acc, row) => acc + Number(row.total), 0);
    near(totals, 10000, "the ageing report total");
  });

  await step("the reporting functions are limited to the branch of the caller", async () => {
    await as(tx, U.salesB);
    await expectError(
      tx,
      "foreign stock report",
      "stock_on_hand",
      [brA.id],
      "Not allowed for this branch",
    );
  });

  await step("the head office gets every branch in the report", async () => {
    await as(tx, U.super);
    const stock = await tx`select * from public.stock_on_hand(null)`;
    const branches = new Set(stock.map((row) => row.branch_id));
    assert(branches.size >= 2, "the head office report only covers one branch");
  });

  await step("the customer dues report lists the unpaid installments", async () => {
    await as(tx, U.super);
    const dues = await tx`select * from public.customer_dues(null)`;
    const row = dues.find((r) => r.customer_id === custDue.id);
    assert(row, "the customer is missing from the dues report");
    eq(row.due_count, 2, "the number of open installments");
    near(row.due_amount, 10000, "the open amount");
    assert(
      !dues.some((r) => r.customer_id === custA.id),
      "a customer that paid everything is still listed as a debtor",
    );
  });

  // ---------------------------------------------------------------------
  // 15. Payment methods a showroom actually takes
  // ---------------------------------------------------------------------
  /** The Dhaka calendar day the statement is written on, offset by n days. */
  const dayText = async (offset = 0) => {
    const rows = await tx`
      select (((now() at time zone 'Asia/Dhaka')::date + ${offset}::int))::text as d`;
    return rows[0].d;
  };

  await step("a card sale saves the invoice and the cash book row", async () => {
    const item = await mintItem(brA.id);
    await as(tx, U.salesA);
    const [sale] = await tx`
      select public.create_sale(${brA.id}, ${custA.id}, ${cart(item.id)}::text::jsonb, 0, 12000, 'card', 'cash', null, null) as id`;
    await asDb(tx);
    const [row] = await tx`select payment_method from public.sales where id = ${sale.id}`;
    eq(row.payment_method, "card", "the payment method on the invoice");
    const [entry] = await tx`
      select method from public.transactions where ref_id = ${sale.id} and kind = 'income'`;
    eq(entry.method, "card", "the method copied into the cash book");
  });

  await step("a rocket kisti collection is booked as rocket income", async () => {
    await asDb(tx);
    const [inst] = await tx`
      select i.id, p.id as plan, i.amount - i.paid_amount as due
      from public.installments i
      join public.installment_plans p on p.id = i.plan_id
      where i.paid_amount < i.amount order by i.due_date limit 1`;
    assert(inst, "there is no open installment left to collect");
    await as(tx, U.salesA);
    await tx`select public.pay_installment(${inst.id}, ${inst.due}, 'rocket')`;
    await asDb(tx);
    const [entry] = await tx`
      select * from public.transactions
      where ref_id = ${inst.plan} and kind = 'income' and category = 'Installment'
      order by created_at desc limit 1`;
    assert(entry, "the kisti collection never reached the cash book");
    eq(entry.method, "rocket", "the wallet the kisti arrived in");
    near(entry.amount, inst.due, "the amount collected in rocket");
  });

  await step("a payment method the shop does not take is refused", async () => {
    const item = await mintItem(brA.id);
    await as(tx, U.salesA);
    await expectError(
      tx,
      "unknown payment method",
      "create_sale",
      [brA.id, custA.id, JSON.parse(cart(item.id)), 0, 12000, "paypal", "cash", null, null],
      "sales_payment_method_check",
    );
  });

  // ---------------------------------------------------------------------
  // 16. Daily cash and collections (requirement B)
  // ---------------------------------------------------------------------
  let cashToday = null;

  await step("the daily statement adds up to the cash in the drawer", async () => {
    cashToday = await dayText();
    await as(tx, U.accountant);
    await tx`select public.save_daily_cash_opening(${brA.id}, ${cashToday}, 5000, null, 'smoke opening')`;
    await as(tx, U.manager);
    const before = (
      await tx`select * from public.daily_cash_reconciliation(${brA.id}, ${cashToday})`
    )[0];

    const item = await mintItem(brA.id);
    await as(tx, U.salesA);
    await tx`
      select public.create_sale(${brA.id}, ${custA.id}, ${cart(item.id)}::text::jsonb, 0, 12000, 'cash', 'cash', null, null)`;

    await asDb(tx);
    const [inst] = await tx`
      select id, amount - paid_amount as due from public.installments
      where paid_amount < amount order by due_date limit 1`;
    const kisti = Math.min(2000, Number(inst.due));
    await as(tx, U.salesA);
    await tx`select public.pay_installment(${inst.id}, ${kisti}, 'cash')`;

    await as(tx, U.manager);
    await tx`
      select public.submit_expense(${brA.id}, 'Food', 500, ${cashToday}, 'cash', 'staff lunch', '', '')`;
    await tx`select public.record_hq_deposit(${brA.id}, 2000, 'cash', 'weekly deposit')`;

    const after = (
      await tx`select * from public.daily_cash_reconciliation(${brA.id}, ${cashToday})`
    )[0];

    near(after.opening_cash, 5000, "the cash the day opened with");
    near(Number(after.cash_sales) - Number(before.cash_sales), 12000, "today's cash sales");
    near(
      Number(after.cash_collections) - Number(before.cash_collections),
      kisti,
      "the cash kisti collected",
    );
    near(Number(after.cash_expenses) - Number(before.cash_expenses), 500, "today's cash expenses");
    near(
      Number(after.hq_deposits) - Number(before.hq_deposits),
      2000,
      "the deposit to the head office",
    );
    near(
      Number(after.cash_deposits) - Number(before.cash_deposits),
      2000,
      "the cash paid to the head office",
    );
    near(
      Number(after.closing_cash) - Number(before.closing_cash),
      12000 + kisti - 500 - 2000,
      "what the drawer gained",
    );
    near(
      after.closing_cash,
      Number(after.opening_cash) +
        Number(after.cash_sales) +
        Number(after.cash_collections) +
        Number(after.cash_other_income) -
        Number(after.cash_expenses) -
        Number(after.cash_deposits),
      "closing = opening + cash sales + cash collected - cash spent - deposited",
    );
    assert(after.counted_cash === null, "a day nobody counted must not report counted cash");
    eq(after.balanced, false, "a day that was not counted is not called balanced");
  });

  await step("bank, card and wallet money never enters the drawer", async () => {
    const cardItem = await mintItem(brA.id);
    const walletItem = await mintItem(brA.id);
    await as(tx, U.manager);
    const before = (
      await tx`select * from public.daily_cash_reconciliation(${brA.id}, ${cashToday})`
    )[0];
    await as(tx, U.salesA);
    await tx`
      select public.create_sale(${brA.id}, ${custA.id}, ${cart(cardItem.id)}::text::jsonb, 0, 12000, 'card', 'cash', null, null)`;
    await tx`
      select public.create_sale(${brA.id}, ${custA.id}, ${cart(walletItem.id)}::text::jsonb, 0, 12000, 'rocket', 'cash', null, null)`;

    await as(tx, U.manager);
    const after = (
      await tx`select * from public.daily_cash_reconciliation(${brA.id}, ${cashToday})`
    )[0];
    near(
      Number(after.bank_card_sales) - Number(before.bank_card_sales),
      12000,
      "today's bank and card sales",
    );
    near(Number(after.mfs_sales) - Number(before.mfs_sales), 12000, "today's wallet sales");
    near(Number(after.cash_sales) - Number(before.cash_sales), 0, "a card sale is not a cash sale");
    near(
      Number(after.closing_cash) - Number(before.closing_cash),
      0,
      "the drawer never saw this money",
    );
  });

  await step("the counted drawer decides whether the day balances", async () => {
    await as(tx, U.accountant);
    const statement = (
      await tx`select * from public.daily_cash_reconciliation(${brA.id}, ${cashToday})`
    )[0];
    const expected = Number(statement.closing_cash);

    await tx`select public.save_daily_cash_opening(${brA.id}, ${cashToday}, null, ${expected}, 'counted')`;
    const counted = (
      await tx`select * from public.daily_cash_reconciliation(${brA.id}, ${cashToday})`
    )[0];
    near(counted.variance, 0, "a drawer counted exactly right");
    eq(counted.balanced, true, "a drawer counted right is balanced");
    near(counted.opening_cash, 5000, "the count must not overwrite the opening balance");

    await tx`select public.save_daily_cash_opening(${brA.id}, ${cashToday}, null, ${expected - 500}, 'short')`;
    const short = (
      await tx`select * from public.daily_cash_reconciliation(${brA.id}, ${cashToday})`
    )[0];
    near(short.variance, -500, "the variance is what was counted minus what should be there");
    eq(short.balanced, false, "a short drawer is not balanced");
  });

  await step("an unwritten day carries the last opening balance forward", async () => {
    const tomorrow = await dayText(1);
    await as(tx, U.accountant);
    const row = (
      await tx`select * from public.daily_cash_reconciliation(${brA.id}, ${tomorrow})`
    )[0];
    near(row.opening_cash, 5000, "the carried forward opening");
    near(row.closing_cash, 5000, "a quiet day keeps the cash it started with");
    assert(row.counted_cash === null, "an unwritten day has no count");
  });

  await step("the cash day is guarded by the same people as the cash book", async () => {
    await as(tx, U.salesA);
    await expectError(
      tx,
      "salesman sets the opening",
      "save_daily_cash_opening",
      [brA.id, cashToday, 1000, null, "no"],
      "Only an accountant, branch manager or admin",
    );
    await expectError(
      tx,
      "deposit to another branch",
      "record_hq_deposit",
      [brB.id, 1000, "cash", "no"],
      "Not allowed for this branch",
    );
    await expectError(
      tx,
      "empty deposit",
      "record_hq_deposit",
      [brA.id, 0, "cash", "no"],
      "Amount must be greater than zero",
    );
    await expectError(
      tx,
      "deposit in an unknown method",
      "record_hq_deposit",
      [brA.id, 1000, "crypto", "no"],
      "Unknown payment method",
    );
    await as(tx, U.salesB);
    await expectError(
      tx,
      "another branch's cash statement",
      "daily_cash_reconciliation",
      [brA.id, cashToday],
      "Not allowed for this branch",
    );
  });

  // ---------------------------------------------------------------------
  // 17. The stock movement ledger (requirement C)
  // ---------------------------------------------------------------------
  await step("a purchase, a sale and a return each leave a movement line", async () => {
    await as(tx, U.manager);
    await tx`
      select public.create_purchase(${supplier.id}, ${brA.id}, 'SMK-MOV-1',
        ${JSON.stringify([
          { product_id: prod.id, imei: "SMK-M-1", imei2: "990001", cost: 10000 },
          { product_id: prod.id, imei: "SMK-M-2", imei2: "990002", cost: 10000 },
        ])}::text::jsonb, 0, 'cash', 'movement test') as id`;
    await asDb(tx);
    const [item1] = await tx`select id from public.inventory_items where imei = 'SMK-M-1'`;
    const received = await tx`
      select * from public.inventory_movements where item_id = ${item1.id} order by seq`;
    eq(received.length, 1, "the number of lines a purchase writes");
    eq(received[0].movement_type, "receive", "the type of the purchase line");
    eq(received[0].qty, 1, "a bought phone joins the shelf");
    eq(received[0].ref_type, "purchase", "the document behind the receive line");

    await as(tx, U.salesA);
    const [sale] = await tx`
      select public.create_sale(${brA.id}, ${custA.id}, ${cart(item1.id)}::text::jsonb, 0, 12000, 'cash', 'cash', null, null) as id`;
    await asDb(tx);
    const [sold] = await tx`
      select * from public.inventory_movements
      where item_id = ${item1.id} order by seq desc limit 1`;
    eq(sold.movement_type, "sale", "the type of the sale line");
    eq(sold.qty, -1, "a sold phone leaves the shelf");
    eq(sold.ref_type, "sale", "the invoice behind the sale line");
    eq(sold.ref_id, sale.id, "the invoice the sale line points at");

    await as(tx, U.manager);
    await tx`select public.return_sale(${sale.id}, 'the customer changed mind')`;
    await asDb(tx);
    const [back] = await tx`
      select * from public.inventory_movements
      where item_id = ${item1.id} order by seq desc limit 1`;
    eq(back.movement_type, "sale_return", "the type of the return line");
    eq(back.qty, 1, "a returned phone is back on the shelf");
  });

  await step("a transfer books the phone out of one branch and into the other", async () => {
    const item = await mintItem(brA.id);
    await as(tx, U.salesA);
    const [t] = await tx`
      select public.create_transfer(${brA.id}, ${brB.id}, ${[item.id]}::uuid[], 'movement test') as id`;
    await asDb(tx);
    const [out] = await tx`
      select * from public.inventory_movements
      where item_id = ${item.id} and movement_type = 'transfer_out'`;
    assert(out, "the transfer wrote no outgoing line");
    eq(out.qty, -1, "an outgoing phone is one less on the source shelf");
    eq(out.branch_id, brA.id, "the outgoing line belongs to the source branch");
    eq(out.ref_type, "transfer", "the document behind the transfer line");

    await as(tx, U.super);
    await tx`select public.receive_transfer(${t.id})`;
    await asDb(tx);
    const rows = await tx`
      select * from public.inventory_movements where item_id = ${item.id} order by seq`;
    const inn = rows.find((r) => r.movement_type === "transfer_in");
    assert(inn, "the receipt wrote no incoming line");
    eq(inn.qty, 1, "an incoming phone is one more on the destination shelf");
    eq(inn.branch_id, brB.id, "the incoming line belongs to the destination branch");
    eq(
      rows.reduce((a, r) => a + r.qty, 0),
      1,
      "the phone is somewhere exactly once",
    );
  });

  await step("a cancelled transfer goes back to the branch that never sent it", async () => {
    const item = await mintItem(brA.id);
    await as(tx, U.salesA);
    const [t] = await tx`
      select public.create_transfer(${brA.id}, ${brB.id}, ${[item.id]}::uuid[], 'to be cancelled') as id`;
    await as(tx, U.manager);
    await tx`select public.cancel_transfer(${t.id}, 'plans changed')`;
    await asDb(tx);
    const rows = await tx`
      select * from public.inventory_movements where item_id = ${item.id} order by seq`;
    eq(
      rows.map((r) => r.movement_type).join(">"),
      "receive>transfer_out>transfer_cancel",
      "the trail a cancelled transfer leaves",
    );
    eq(
      rows.reduce((a, r) => a + r.qty, 0),
      1,
      "a cancelled phone is still at home",
    );
    assert(
      rows.every((r) => r.branch_id === brA.id),
      "a cancelled transfer left a movement line in the destination branch",
    );
    eq(rows[2].branch_id, brA.id, "the cancellation is booked at the source branch");
  });

  await step("damage and adjustment each get their own numbered voucher", async () => {
    const item = await mintItem(brA.id);
    await as(tx, U.manager);
    const [damage] =
      await tx`select public.mark_inventory_damaged(${item.id}, 'water damage') as voucher`;
    assert(/^DMG-/.test(damage.voucher), `the damage voucher is not numbered: ${damage.voucher}`);
    await asDb(tx);
    const [dmgRow] = await tx`
      select * from public.inventory_movements where item_id = ${item.id} and movement_type = 'damage'`;
    assert(dmgRow, "the damage wrote no movement line");
    eq(dmgRow.qty, -1, "a damaged phone is off the sellable shelf");
    eq(dmgRow.voucher_no, damage.voucher, "the damage line carries its voucher");
    eq(dmgRow.reason, "water damage", "the damage line carries the reason");

    await as(tx, U.manager);
    await tx`select public.restore_damaged_inventory(${item.id}, 'repaired under warranty')`;
    await asDb(tx);
    const [fixed] = await tx`
      select * from public.inventory_movements
      where item_id = ${item.id} and movement_type = 'damage_restore'`;
    assert(fixed, "the restoration wrote no movement line");
    eq(fixed.qty, 1, "a repaired phone is sellable again");

    await as(tx, U.manager);
    const [adj] =
      await tx`select public.adjust_inventory(${item.id}, 'remove', 'counted missing') as voucher`;
    assert(/^ADJ-/.test(adj.voucher), `the adjustment voucher is not numbered: ${adj.voucher}`);
    await asDb(tx);
    const [out] = await tx`
      select * from public.inventory_movements
      where item_id = ${item.id} and movement_type = 'adjustment' and qty = -1`;
    assert(out, "writing the phone off left no adjustment line");
    eq(out.voucher_no, adj.voucher, "the adjustment line carries its voucher");
    eq(out.reason, "counted missing", "the adjustment line carries the reason");

    await as(tx, U.manager);
    await tx`select public.adjust_inventory(${item.id}, 'add', 'found behind the counter')`;
    await asDb(tx);
    const [stock] = await tx`select status from public.inventory_items where id = ${item.id}`;
    eq(stock.status, "in_stock", "a phone added back is on the shelf again");
    const inCount = await tx`
      select count(*)::int as n from public.inventory_movements
      where item_id = ${item.id} and movement_type = 'adjustment' and qty = 1`;
    eq(inCount[0].n, 1, "adding the phone back wrote an adjustment line");
  });

  await step("the stock statement closes on what is actually on the shelf", async () => {
    await as(tx, U.manager);
    const rows = await tx`
      select * from public.stock_reconciliation(${brA.id}, ${"2000-01-01"}, ${"2999-12-31"})`;
    const row = rows.find((r) => r.product_id === prod.id);
    assert(row, "the model is missing from the stock statement");
    near(
      Number(row.closing),
      Number(row.opening) +
        Number(row.receive) +
        Number(row.transfer_in) -
        Number(row.transfer_out) -
        Number(row.sales) +
        Number(row.sales_return) -
        Number(row.purchase_return) +
        Number(row.adjustment) -
        Number(row.damage) +
        Number(row.damage_restore),
      "the statement follows the showroom book formula",
    );
    eq(row.closing, row.on_shelf, "the statement agrees with the shelf");
    assert(
      rows.every((r) => r.matches),
      `the ledger drifted from the shelf in ${rows
        .filter((r) => !r.matches)
        .map((r) => r.model)
        .join(", ")}`,
    );
  });

  await step("the IMEI ledger shows both numbers and the voucher behind each line", async () => {
    await as(tx, U.manager);
    const rows = await tx`
      select * from public.stock_imei_ledger(${brA.id}, ${"2000-01-01"}, ${"2999-12-31"})
      where imei = 'SMK-M-1'`;
    assert(rows.length >= 3, `the trail of one phone is too short: ${rows.length} lines`);
    eq(rows[0].movement_type, "receive", "the first line of a phone's life");
    assert(
      rows.every((r) => r.imei2 === "990001"),
      "the second IMEI is missing from the trail",
    );
    assert(
      rows.every((r) => r.model && r.brand && r.variant),
      "the trail does not name the model",
    );
    assert(
      rows.some((r) => r.movement_type === "sale_return"),
      "the return is missing from the trail",
    );
  });

  await step("a branch cannot read another branch's stock ledger", async () => {
    await as(tx, U.salesA);
    const foreign = await tx`
      select count(*)::int as n from public.inventory_movements where branch_id = ${brB.id}`;
    eq(foreign[0].n, 0, "branch A can see branch B's movements");
    await expectError(
      tx,
      "another branch's statement",
      "stock_reconciliation",
      [brB.id, "2000-01-01", "2999-12-31"],
      "Not allowed for this branch",
    );
    await expectError(
      tx,
      "reversed dates",
      "stock_reconciliation",
      [brA.id, "2026-11-05", "2026-11-01"],
      "start date must not be after",
    );
  });

  // ---------------------------------------------------------------------
  // 18. A queued entry keeps the day and the person it belongs to
  // ---------------------------------------------------------------------
  await step("an offline sale lands on the day and under the person who sold it", async () => {
    const ref = "11111111-2222-3333-4444-555555555566";
    const item = await mintItem(brA.id);
    const payload = JSON.stringify({
      branch: brA.id,
      customer: custA.id,
      phone: "",
      cust_name: "",
      items: [{ item_id: item.id, price: 12000 }],
      discount: 0,
      paid: 12000,
      method: "cash",
      sale_type: "cash",
      months: "",
      discount_reason: "",
    });
    await as(tx, U.salesA);
    const applied = await tx`
      select public.apply_offline_op(
        ${ref}::uuid, 'sale', ${payload}::text::jsonb,
        (now() - interval '2 days'), 'smoke-device', ${U.salesA}) as res`;
    eq(applied[0].res.status, "applied", "the backdated offline sale");

    await asDb(tx);
    const [sale] = await tx`
      select * from public.sales where id = ${applied[0].res.result.sale_id}`;
    const twoDaysAgo = Date.now() - 47 * 3600 * 1000;
    assert(
      new Date(sale.created_at).getTime() < twoDaysAgo,
      `the replay landed on today: ${sale.created_at}`,
    );
    eq(sale.created_by, U.salesA, "the replay credited the wrong salesman");
    const [entry] = await tx`
      select * from public.transactions where ref_id = ${sale.id} and kind = 'income'`;
    assert(
      new Date(entry.created_at).getTime() < twoDaysAgo,
      `the cash book row landed on today: ${entry.created_at}`,
    );
    eq(entry.created_by, U.salesA, "the cash book row was credited to whoever synced");
  });

  await step("an offline sale never borrows a customer from another showroom", async () => {
    const ref = "11111111-2222-3333-4444-555555555588";
    const item = await mintItem(brA.id);
    // The phone belongs to custB at the other branch. Replaying as the owner of
    // the queue sees every branch, so an unscoped match would hand this sale to
    // the wrong showroom's customer and create_sale would reject it.
    const payload = JSON.stringify({
      branch: brA.id,
      customer: "",
      phone: "01700000002",
      cust_name: "Walk-in from the other branch",
      nid: "",
      items: [{ item_id: item.id, price: 13000 }],
      discount: 0,
      paid: 13000,
      method: "cash",
      sale_type: "cash",
      months: "",
      discount_reason: "",
    });
    await as(tx, U.salesA);
    const applied = await tx`
      select public.apply_offline_op(
        ${ref}::uuid, 'sale', ${payload}::text::jsonb,
        (now() - interval '1 day'), 'smoke-device', ${U.salesA}) as res`;
    eq(
      applied[0].res.status,
      "applied",
      `the offline sale to a foreign phone: ${applied[0].res.error}`,
    );

    await asDb(tx);
    const [sale] = await tx`
      select * from public.sales where id = ${applied[0].res.result.sale_id}`;
    assert(sale.customer_id !== custB.id, "the replay gave the sale to another branch's customer");
    const [customer] = await tx`
      select * from public.customers where id = ${sale.customer_id}`;
    eq(customer.branch_id, brA.id, "the branch the offline customer was written under");
    eq(customer.name, "Walk-in from the other branch", "the name of the offline customer");
  });

  await step("an offline expense lands on the day it was written", async () => {
    const ref = "11111111-2222-3333-4444-555555555577";
    const threeDaysAgo = await dayText(-3);
    const payload = JSON.stringify({
      branch: brA.id,
      category: "Cleaning",
      amount: 400,
      date: threeDaysAgo,
      method: "cash",
      note: "queued without internet",
      attachment: "",
      bill_no: "BILL-9",
    });
    await as(tx, U.manager);
    const applied = await tx`
      select public.apply_offline_op(
        ${ref}::uuid, 'expense', ${payload}::text::jsonb,
        (now() - interval '3 days'), 'smoke-device', ${U.manager}) as res`;
    eq(applied[0].res.status, "applied", "the offline expense");

    await asDb(tx);
    const voucher = applied[0].res.result.expense_voucher;
    const [expense] = await tx`select * from public.expenses where voucher_no = ${voucher}`;
    assert(expense, "the offline expense was never written");
    eq(expense.bill_no, "BILL-9", "the bill number of a queued expense");
    eq(expense.created_by, U.manager, "the offline expense was credited to whoever synced");
    const [onDay] = await tx`
      select count(*)::int as n from public.expenses
      where voucher_no = ${voucher} and expense_date = ${threeDaysAgo}::date`;
    eq(onDay.n, 1, "the day a queued expense was written on");
    assert(
      new Date(expense.created_at).getTime() < Date.now() - 47 * 3600 * 1000,
      `the queued expense landed on today: ${expense.created_at}`,
    );
    const [statement] = await tx`
      select * from public.daily_cash_reconciliation(${brA.id}, ${threeDaysAgo})`;
    assert(
      Number(statement.cash_expenses) >= 400,
      "a queued expense is missing from its own day's statement",
    );
    near(
      statement.closing_cash,
      Number(statement.opening_cash) +
        Number(statement.cash_sales) +
        Number(statement.cash_collections) +
        Number(statement.cash_other_income) -
        Number(statement.cash_expenses) -
        Number(statement.cash_deposits),
      "three days ago closes",
    );
  });

  await step("an offline kisti keeps the wallet it was collected in", async () => {
    const ref = "11111111-2222-3333-4444-555555555599";
    await asDb(tx);
    const [inst] = await tx`
      select i.id, i.plan_id, i.amount - i.paid_amount as due
      from public.installments i
      where i.paid_amount < i.amount order by i.due_date limit 1`;
    const amt = Math.min(1500, Number(inst.due));
    const payload = JSON.stringify({ inst: inst.id, amount: amt, method: "nagad" });

    await as(tx, U.salesA);
    const applied = await tx`
      select public.apply_offline_op(
        ${ref}::uuid, 'kisti', ${payload}::text::jsonb,
        (now() - interval '1 day'), 'smoke-device', ${U.salesA}) as res`;
    eq(applied[0].res.status, "applied", "the queued kisti collection");

    await asDb(tx);
    const [booking] = await tx`
      select count(*)::int as n from public.transactions
      where category = 'Installment' and ref_id = ${inst.plan_id}
        and amount = ${amt}::numeric and method = 'nagad'`;
    eq(booking.n, 1, "the wallet a queued kisti was collected in");
  });

  await step("one account cannot empty another account's queue", async () => {
    const ref = "11111111-2222-3333-4444-555555555588";
    const item = await mintItem(brA.id);
    const payload = JSON.parse(cart(item.id));
    await as(tx, U.salesB);
    const msg = await expectError(
      tx,
      "replay by the wrong account",
      "apply_offline_op",
      [ref, "sale", payload, new Date().toISOString(), "smoke-device", U.salesA],
      "This queue belongs to another account",
    );
    assert(msg.includes("another account"), msg);
  });
}

(async () => {
  const ROLLBACK = "ROLLBACK_SMOKE_TEST";
  try {
    await sql.begin(async (tx) => {
      await runAll(tx);
      throw new Error(ROLLBACK);
    });
  } catch (err) {
    if (err.message !== ROLLBACK) {
      console.error("\nthe smoke test could not finish:", err.message);
      process.exitCode = 1;
    }
  }
  // Whatever happened above, the transaction must not survive this run — a
  // leftover one keeps its locks and blocks the next run.
  try {
    const open = await sql`select state from pg_stat_activity where pid = pg_backend_pid()`;
    if (open[0]?.state === "idle in transaction") await sql`rollback`;
  } catch {
    /* the connection is gone, so there is nothing left open */
  }
  await sql.end();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log("\nfailures:");
    for (const f of failed) console.log(`  - ${f.name}: ${f.error}`);
    process.exitCode = 1;
  }
})();
