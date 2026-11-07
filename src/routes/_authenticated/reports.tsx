import { logoSrc } from "@/lib/brand";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Download, Printer } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { BranchPicker, PageHeader } from "@/components/BranchPicker";
import { productLabel, taka, useBranches, useSettings } from "@/lib/erp";
import { downloadCsv } from "@/lib/csv";
import { useT } from "@/lib/i18n";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { fetchAllPages } from "@/lib/paginated-query";
import { localDate } from "@/lib/date";
import { methodLabel, isMfs } from "@/lib/payment-methods";
import { EXPENSE_HEADS } from "@/lib/expense-heads";

export const Route = createFileRoute("/_authenticated/reports")({
  head: () => ({
    meta: [
      { title: "Reports — Dealer ERP" },
      { name: "description", content: "Sales, inventory, transfer and kisti reports." },
    ],
  }),
  component: Reports,
});

type Row = Record<string, string | number>;
const fromTs = (d: string) => new Date(d + "T00:00:00").toISOString();
const toTs = (d: string) => new Date(d + "T23:59:59.999").toISOString();
const dt = (s: string | null) => (s ? new Date(s).toLocaleString() : "");

function Reports() {
  const { t } = useT();
  const [branch, setBranch] = useState("");
  const today = new Date();
  const [from, setFrom] = useState(localDate(new Date(today.getFullYear(), today.getMonth(), 1)));
  const [to, setTo] = useState(localDate(today));
  const [tab, setTab] = useState("sales");
  const { data: branches = [] } = useBranches();
  const { data: settings } = useSettings();
  const bname = (id: string | null) => branches.find((b) => b.id === id)?.name ?? "";
  const f = { branch, from, to };

  return (
    <div>
      <PageHeader title={t("Reports")}>
        <BranchPicker value={branch} onChange={setBranch} allowAll />
        <div className="flex min-w-36 flex-1 items-center gap-1 sm:flex-none">
          <Label className="text-xs">From</Label>
          <Input
            type="date"
            className="w-full bg-card sm:w-40"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </div>
        <div className="flex min-w-36 flex-1 items-center gap-1 sm:flex-none">
          <Label className="text-xs">To</Label>
          <Input
            type="date"
            className="w-full bg-card sm:w-40"
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        </div>
        <Button
          variant="outline"
          className="print:hidden"
          disabled={!branch}
          onClick={() => window.print()}
        >
          <Printer className="mr-1 h-4 w-4" /> Print / PDF
        </Button>
      </PageHeader>
      <div className="mb-4 hidden print:block">
        <div className="flex items-center gap-2">
          <img src={logoSrc(settings?.logo_url)} alt="" className="h-10" />
          <div className="text-xl font-bold">{settings?.company_name}</div>
        </div>
        {settings?.address && (
          <div className="text-xs">
            {settings.address} {settings.phone}
          </div>
        )}
        <h2 className="text-lg font-semibold">
          {
            (
              {
                sales: "Sales",
                inventory: "Inventory",
                stockledger: "Stock ledger",
                transfers: "Transfer",
                kisti: "Kisti",
                expenses: "Expense",
              } as Record<string, string>
            )[tab]
          }{" "}
          report
        </h2>
        <div className="text-sm">
          Branch: {branch === "all" ? "All branches" : bname(branch)} · {from} to {to} · Printed{" "}
          {new Date().toLocaleString()}
        </div>
      </div>
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="print:hidden">
          <TabsTrigger value="sales">{t("Sales")}</TabsTrigger>
          <TabsTrigger value="inventory">{t("Inventory")}</TabsTrigger>
          <TabsTrigger value="stockledger">{t("Stock ledger")}</TabsTrigger>
          <TabsTrigger value="transfers">{t("Transfers")}</TabsTrigger>
          <TabsTrigger value="kisti">{t("Installments")}</TabsTrigger>
          <TabsTrigger value="expenses">{t("Expenses")}</TabsTrigger>
        </TabsList>
        <TabsContent value="sales">
          <SalesReport {...f} bname={bname} />
        </TabsContent>
        <TabsContent value="inventory">
          <InventoryReport {...f} bname={bname} />
        </TabsContent>
        <TabsContent value="stockledger">
          <StockLedgerReport {...f} bname={bname} />
        </TabsContent>
        <TabsContent value="transfers">
          <TransferReport {...f} bname={bname} />
        </TabsContent>
        <TabsContent value="kisti">
          <KistiReport {...f} bname={bname} />
        </TabsContent>
        <TabsContent value="expenses">
          <ExpenseReport {...f} bname={bname} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

type P = { branch: string; from: string; to: string; bname: (id: string | null) => string };

function Summary({ items }: { items: [string, string | number][] }) {
  return (
    <div className="mb-3 grid grid-cols-2 gap-3 md:grid-cols-4">
      {items.map(([k, v]) => (
        <Card key={k} className="p-4">
          <div className="text-xs text-muted-foreground">{k}</div>
          <div className="text-lg font-semibold tabular">{v}</div>
        </Card>
      ))}
    </div>
  );
}

function DataTable({ rows, name, money = [] }: { rows: Row[]; name: string; money?: string[] }) {
  const headers = rows[0] ? Object.keys(rows[0]) : [];
  return (
    <Card>
      <div className="flex items-center justify-between border-b p-3">
        <span className="text-sm text-muted-foreground">{rows.length} rows</span>
        <Button
          size="sm"
          variant="outline"
          className="print:hidden"
          disabled={!rows.length}
          onClick={() => downloadCsv(rows, `${name}.csv`)}
        >
          <Download className="mr-1 h-4 w-4" /> CSV
        </Button>
      </div>
      <div className="max-h-[60vh] overflow-auto print:max-h-none print:overflow-visible">
        <Table>
          <TableHeader>
            <TableRow>
              {headers.map((h) => (
                <TableHead key={h} className={money.includes(h) ? "text-right" : ""}>
                  {h}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r, i) => (
              <TableRow
                key={i}
                className={i >= 500 ? "hidden print:table-row" : "break-inside-avoid"}
              >
                {headers.map((h) => (
                  <TableCell
                    key={h}
                    className={money.includes(h) ? "text-right tabular" : "text-xs"}
                  >
                    {money.includes(h) ? taka(r[h]) : r[h]}
                  </TableCell>
                ))}
              </TableRow>
            ))}
            {!rows.length && (
              <TableRow>
                <TableCell className="py-8 text-center text-muted-foreground">
                  No data for these filters.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      {rows.length > 500 && (
        <div className="print:hidden p-2 text-center text-xs text-muted-foreground">
          Showing 500 of {rows.length}; CSV has all rows.
        </div>
      )}
    </Card>
  );
}

function SalesReport({ branch, from, to, bname }: P) {
  const { data = [] } = useQuery({
    queryKey: ["rep-sales", branch, from, to],
    enabled: !!branch,
    queryFn: async () => {
      let q = supabase
        .from("sales")
        .select(
          "*, customers(name,phone), sale_items(price, inventory_items(imei, imei2, purchase_price, products(brand,model,variant,sale_price)))",
        )
        .gte("created_at", fromTs(from))
        .lte("created_at", toTs(to))
        .order("created_at", { ascending: false });
      if (branch !== "all") q = q.eq("branch_id", branch);
      return fetchAllPages(q);
    },
  });
  // sales.created_by has no foreign key, so PostgREST cannot embed the name.
  // The staff list is short, and knowing which salesman sold what is half the
  // point of a showroom day book.
  const { data: staff = [] } = useQuery({
    queryKey: ["rep-staff"],
    queryFn: async () => fetchAllPages(supabase.from("profiles").select("id,full_name")),
  });
  const activeSales = data.filter((s) => s.status !== "returned");
  const returnedSales = data.filter((s) => s.status === "returned");
  const rows: Row[] = activeSales.flatMap((s) =>
    s.sale_items.map((i) => {
      const list = Number(i.inventory_items?.products?.sale_price ?? 0);
      const price = Number(i.price);
      return {
        Invoice: s.invoice_no,
        Date: dt(s.created_at),
        Branch: bname(s.branch_id),
        Customer: s.customers?.name ?? "Walk-in",
        Phone: s.customers?.phone ?? "",
        Model: productLabel(i.inventory_items?.products),
        IMEI: i.inventory_items?.imei ?? "",
        "IMEI 2": i.inventory_items?.imei2 ?? "",
        Qty: s.sale_items.length,
        "List price": list,
        Discount: Math.max(list - price, 0),
        "Sale price": price,
        Cost: Number(i.inventory_items?.purchase_price ?? 0),
        Profit: price - Number(i.inventory_items?.purchase_price ?? 0),
        Type: s.sale_type,
        Method: methodLabel(s.payment_method),
        "Sold by": staff.find((u) => u.id === s.created_by)?.full_name ?? "",
      };
    }),
  );
  const total = activeSales.reduce((a, s) => a + Number(s.total), 0);
  const paid = activeSales.reduce((a, s) => a + Number(s.paid), 0);
  // sale.total is the authoritative revenue (the server stores the effective
  // price after discount), so profit must be revenue minus cost — deriving it
  // from the per-item price and subtracting the discount again double-counts.
  const cost = rows.reduce((a, r) => a + Number(r["Cost"]), 0);
  const profit = total - cost;
  return (
    <>
      <Summary
        items={[
          ["Invoices", activeSales.length],
          ["Units sold", rows.length],
          ["Net sales", taka(total)],
          ["Gross profit", taka(profit)],
          ["Collected", taka(paid)],
          ["Discounts", taka(activeSales.reduce((a, s) => a + Number(s.discount), 0))],
          ["Cash sales", activeSales.filter((s) => s.sale_type === "cash").length],
          ["Kisti sales", activeSales.filter((s) => s.sale_type !== "cash").length],
          ["Returned invoices", returnedSales.length],
          ["Returned sale value", taka(returnedSales.reduce((a, s) => a + Number(s.total), 0))],
        ]}
      />
      <DataTable
        rows={rows}
        name={`sales_${from}_${to}`}
        money={["List price", "Discount", "Sale price", "Cost", "Profit"]}
      />
    </>
  );
}

function InventoryReport({ branch, from, to, bname }: P) {
  const { data = [] } = useQuery({
    queryKey: ["rep-inv", branch, from, to],
    enabled: !!branch,
    queryFn: async () => {
      let q = supabase
        .from("inventory_items")
        .select("*, products(brand,model,variant,sale_price)")
        .gte("created_at", fromTs(from))
        .lte("created_at", toTs(to))
        .order("created_at", { ascending: false });
      if (branch !== "all") q = q.eq("branch_id", branch);
      return fetchAllPages(q);
    },
  });
  // What is on the shelf right now is a different question from "what came in
  // during this range", so it is counted separately and ignores the dates.
  const { data: onHand = [] } = useQuery({
    queryKey: ["rep-stock-on-hand", branch],
    enabled: !!branch,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("stock_on_hand", {
        _branch: branch === "all" ? null : branch,
      });
      if (error) throw error;
      return data ?? [];
    },
  });
  // Model-wise summary
  const map = new Map<string, Row>();
  for (const i of data) {
    const key = `${i.branch_id}|${i.product_id}`;
    const r = map.get(key) ?? {
      Branch: bname(i.branch_id),
      Product: productLabel(i.products),
      "In stock": 0,
      "In transit": 0,
      Sold: 0,
      Other: 0,
      "Stock value": 0,
    };
    if (i.status === "in_stock") {
      r["In stock"] = Number(r["In stock"]) + 1;
      r["Stock value"] = Number(r["Stock value"]) + Number(i.purchase_price);
    } else if (i.status === "in_transit") r["In transit"] = Number(r["In transit"]) + 1;
    else if (i.status === "sold") r["Sold"] = Number(r["Sold"]) + 1;
    else r["Other"] = Number(r["Other"]) + 1;
    map.set(key, r);
  }
  const summary = [...map.values()];
  const detail: Row[] = data.map((i) => ({
    "Received on": dt(i.created_at),
    Branch: bname(i.branch_id),
    Product: productLabel(i.products),
    IMEI: i.imei,
    IMEI2: i.imei2 ?? "",
    Status: i.status,
    Supplier: i.supplier ?? "",
    Cost: Number(i.purchase_price),
    MRP: Number(i.products?.sale_price ?? 0),
  }));
  const inStock = data.filter((i) => i.status === "in_stock");
  const onHandRows: Row[] = onHand.map((s) => ({
    Branch: bname(s.branch_id),
    Product: `${s.brand} ${s.model}${s.variant ? " " + s.variant : ""}`,
    "In stock": Number(s.qty),
    "Cost value": Number(s.cost_value),
    "Retail value": Number(s.retail_value),
  }));
  const onHandCost = onHandRows.reduce((a, r) => a + Number(r["Cost value"]), 0);
  const onHandRetail = onHandRows.reduce((a, r) => a + Number(r["Retail value"]), 0);
  return (
    <>
      <p className="mb-2 text-xs text-muted-foreground">Items received in the selected dates.</p>
      <Summary
        items={[
          ["Items received", data.length],
          ["Still in stock", inStock.length],
          ["Stock value (cost)", taka(inStock.reduce((a, i) => a + Number(i.purchase_price), 0))],
          ["Sold", data.filter((i) => i.status === "sold").length],
        ]}
      />
      <h3 className="mb-2 font-medium">Model-wise summary (received in range)</h3>
      <DataTable rows={summary} name={`stock_summary_${from}_${to}`} money={["Stock value"]} />
      <h3 className="mb-2 mt-6 font-medium">Stock on hand right now</h3>
      <p className="mb-2 text-xs text-muted-foreground">
        Every model currently on the shelf, whatever the date range.
      </p>
      <Summary
        items={[
          ["Models in stock", onHandRows.length],
          ["Units on hand", onHandRows.reduce((a, r) => a + Number(r["In stock"]), 0)],
          ["Stock value (cost)", taka(onHandCost)],
          ["Stock value (retail)", taka(onHandRetail)],
        ]}
      />
      <DataTable
        rows={onHandRows}
        name={`stock_on_hand_${from}_${to}`}
        money={["Cost value", "Retail value"]}
      />
      <h3 className="mb-2 mt-6 font-medium">IMEI detail</h3>
      <DataTable rows={detail} name={`stock_imei_${from}_${to}`} money={["Cost", "MRP"]} />
    </>
  );
}

function TransferReport({ branch, from, to, bname }: P) {
  const { data = [] } = useQuery({
    queryKey: ["rep-tr", branch, from, to],
    enabled: !!branch,
    queryFn: async () => {
      let q = supabase
        .from("stock_transfers")
        .select("*, transfer_items(inventory_items(imei, products(brand,model,variant)))")
        .gte("created_at", fromTs(from))
        .lte("created_at", toTs(to))
        .order("created_at", { ascending: false });
      if (branch !== "all") q = q.or(`from_branch_id.eq.${branch},to_branch_id.eq.${branch}`);
      return fetchAllPages(q);
    },
  });
  const rows: Row[] = data.flatMap((tr) =>
    tr.transfer_items.map((i) => ({
      Transfer: tr.transfer_no,
      Sent: dt(tr.created_at),
      From: bname(tr.from_branch_id),
      To: bname(tr.to_branch_id),
      Product: productLabel(i.inventory_items?.products),
      IMEI: i.inventory_items?.imei ?? "",
      Status: tr.status,
      Received: dt(tr.received_at),
      Note: tr.note ?? "",
    })),
  );
  return (
    <>
      <Summary
        items={[
          ["Transfers", data.length],
          ["Units moved", rows.length],
          ["In transit", data.filter((x) => x.status === "in_transit").length],
          ["Received", data.filter((x) => x.status === "received").length],
        ]}
      />
      <DataTable rows={rows} name={`transfers_${from}_${to}`} />
    </>
  );
}

function KistiReport({ branch, from, to, bname }: P) {
  const { data = [] } = useQuery({
    queryKey: ["rep-kisti", branch, from, to],
    enabled: !!branch,
    queryFn: async () => {
      let q = supabase
        .from("installments")
        .select("*, installment_plans(months, sales(invoice_no), customers(name,phone))")
        .eq("cancelled", false)
        .gte("due_date", from)
        .lte("due_date", to)
        .order("due_date");
      if (branch !== "all") q = q.eq("branch_id", branch);
      return fetchAllPages(q);
    },
  });
  // Overdue money is late whether or not it falls inside the chosen dates, so
  // it is listed separately — the date filter would otherwise hide it.
  const { data: overdue = [] } = useQuery({
    queryKey: ["rep-kisti-overdue", branch],
    enabled: !!branch,
    queryFn: async () => {
      let q = supabase
        .from("installments")
        .select("*, installment_plans(months, sales(invoice_no), customers(name,phone))")
        .eq("cancelled", false)
        .lt("due_date", localDate())
        .order("due_date");
      if (branch !== "all") q = q.eq("branch_id", branch);
      return fetchAllPages(q);
    },
  });
  const { data: dues = [] } = useQuery({
    queryKey: ["rep-dues", branch],
    enabled: !!branch,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("customer_dues", {
        _branch: branch === "all" ? null : branch,
      });
      if (error) throw error;
      return data ?? [];
    },
  });
  const todayStr = localDate();
  const rows: Row[] = data.map((i) => {
    const due = Number(i.amount) - Number(i.paid_amount);
    const status =
      due <= 0
        ? "paid"
        : i.due_date < todayStr
          ? "overdue"
          : Number(i.paid_amount) > 0
            ? "partial"
            : "upcoming";
    return {
      "Due date": i.due_date,
      Branch: bname(i.branch_id),
      Invoice: i.installment_plans?.sales?.invoice_no ?? "",
      Customer: i.installment_plans?.customers?.name ?? "",
      Phone: i.installment_plans?.customers?.phone ?? "",
      Kisti: `${i.seq}/${i.installment_plans?.months ?? ""}`,
      Amount: Number(i.amount),
      Paid: Number(i.paid_amount),
      Due: Math.max(0, due),
      Status: status,
      "Paid at": dt(i.paid_at),
    };
  });
  const sum = (k: string, pred: (r: Row) => boolean = () => true) =>
    rows.filter(pred).reduce((a, r) => a + Number(r[k]), 0);
  const overdueRows: Row[] = overdue
    .filter((i) => Number(i.paid_amount) < Number(i.amount))
    .map((i) => ({
      "Due date": i.due_date,
      Branch: bname(i.branch_id),
      Invoice: i.installment_plans?.sales?.invoice_no ?? "",
      Customer: i.installment_plans?.customers?.name ?? "",
      Phone: i.installment_plans?.customers?.phone ?? "",
      Amount: Number(i.amount),
      Paid: Number(i.paid_amount),
      Due: Math.max(0, Number(i.amount) - Number(i.paid_amount)),
    }));
  const overdueTotal = overdueRows.reduce((a, r) => a + Number(r["Due"]), 0);
  return (
    <>
      <p className="mb-2 text-xs text-muted-foreground">
        Kistis falling due in the selected dates.
      </p>
      <Summary
        items={[
          ["Kistis due", rows.length],
          ["Expected", taka(sum("Amount"))],
          ["Collected", taka(sum("Paid"))],
          ["Outstanding", taka(sum("Due"))],
          ["Overdue count", rows.filter((r) => r["Status"] === "overdue").length],
          ["Overdue amount", taka(sum("Due", (r) => r["Status"] === "overdue"))],
        ]}
      />
      <DataTable rows={rows} name={`kisti_${from}_${to}`} money={["Amount", "Paid", "Due"]} />

      <h3 className="mb-2 mt-6 font-medium">All overdue (any date)</h3>
      <p className="mb-2 text-xs text-muted-foreground">
        {overdueRows.length} kistis are late — {taka(overdueTotal)} is past its due date.
      </p>
      <DataTable
        rows={overdueRows}
        name={`kisti_overdue_${from}_${to}`}
        money={["Amount", "Paid", "Due"]}
      />

      <h3 className="mb-2 mt-6 font-medium">Who owes what</h3>
      <p className="mb-2 text-xs text-muted-foreground">
        Every customer with an unpaid kisti, heaviest debt first.
      </p>
      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Customer</TableHead>
              <TableHead>Phone</TableHead>
              <TableHead>Branch</TableHead>
              <TableHead className="text-right">Open kistis</TableHead>
              <TableHead className="text-right">Overdue</TableHead>
              <TableHead className="text-right">Due</TableHead>
              <TableHead>Oldest due</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {dues.map((d) => (
              <TableRow key={d.customer_id}>
                <TableCell className="font-medium">
                  <Link
                    to="/customers/$customerId"
                    params={{ customerId: d.customer_id }}
                    className="text-primary hover:underline"
                  >
                    {d.name}
                  </Link>
                </TableCell>
                <TableCell className="tabular">{d.phone}</TableCell>
                <TableCell>{bname(d.branch_id)}</TableCell>
                <TableCell className="text-right tabular">{d.due_count}</TableCell>
                <TableCell className="text-right tabular">
                  {d.overdue_count > 0 ? (
                    <span className="text-destructive">{d.overdue_count}</span>
                  ) : (
                    0
                  )}
                </TableCell>
                <TableCell className="text-right tabular">{taka(d.due_amount)}</TableCell>
                <TableCell>{d.oldest_due_date}</TableCell>
              </TableRow>
            ))}
            {dues.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="py-8 text-center text-muted-foreground">
                  No outstanding kisti.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Card>
    </>
  );
}

// The day book of the shelf: what the branch opened with, every document that
// moved a phone in or out, and what the ledger says should be on the shelf at
// the end. The last column is the audit — the ledger's closing figure against
// the phones actually counted as in_stock right now.
function StockLedgerReport({ branch, from, to, bname }: P) {
  const {
    data = [],
    error,
    isFetching,
  } = useQuery({
    queryKey: ["rep-stock-ledger", branch, from, to],
    enabled: !!branch,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("stock_reconciliation", {
        _branch: branch === "all" ? null : branch,
        _from: from || null,
        _to: to || null,
      });
      if (error) throw error;
      return data ?? [];
    },
  });
  const { data: trail = [] } = useQuery({
    queryKey: ["rep-stock-trail", branch, from, to],
    enabled: !!branch,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("stock_imei_ledger", {
        _branch: branch === "all" ? null : branch,
        _from: from || null,
        _to: to || null,
      });
      if (error) throw error;
      return data ?? [];
    },
  });
  const sum = (k: keyof (typeof data)[number]) => data.reduce((a, r) => a + Number(r[k] ?? 0), 0);
  const mismatches = data.filter((r) => !r.matches);
  const rows: Row[] = data.map((r) => ({
    Branch: bname(r.branch_id),
    Model: `${r.brand} ${r.model}${r.variant ? " " + r.variant : ""}`,
    Opening: Number(r.opening),
    Receive: Number(r.receive),
    "Transfer in": Number(r.transfer_in),
    "Transfer out": Number(r.transfer_out),
    Sales: Number(r.sales),
    "Sales return": Number(r.sales_return),
    "Purchase return": Number(r.purchase_return),
    Damage: Number(r.damage),
    Restored: Number(r.damage_restore),
    Adjustment: Number(r.adjustment),
    Closing: Number(r.closing),
    "On shelf": Number(r.on_shelf),
    Matches: r.matches ? "yes" : "NO",
  }));
  const trailRows: Row[] = trail.map((m) => ({
    "Moved at": dt(m.moved_at),
    Branch: bname(m.branch_id),
    Model: `${m.brand} ${m.model}${m.variant ? " " + m.variant : ""}`,
    IMEI: m.imei,
    "IMEI 2": m.imei2 ?? "",
    Movement: m.movement_type.replace(/_/g, " "),
    Qty: Number(m.qty),
    Voucher: m.voucher_no ?? "",
    Reason: m.reason ?? "",
    Ref: m.ref_type ?? "",
    "Item now": m.status,
  }));
  if (!branch) return <p className="text-sm text-muted-foreground">Choose a branch.</p>;
  return (
    <>
      {error && (
        <p className="mb-3 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          Could not build the ledger: {error.message}
        </p>
      )}
      <p className="mb-2 text-xs text-muted-foreground">
        Closing = Opening + Receive + Transfer in − Sales − Transfer out + Sales return − Purchase
        return − Damage ± Adjustment. “On shelf” counts the phones sitting in stock at this moment,
        so a row that does not match is a real difference to chase.
      </p>
      <Summary
        items={[
          ["Models", rows.length],
          ["Opening", sum("opening")],
          ["Received", sum("receive")],
          ["Sold", sum("sales")],
          ["Transferred in", sum("transfer_in")],
          ["Transferred out", sum("transfer_out")],
          ["Damaged", sum("damage")],
          ["Adjusted", sum("adjustment")],
          ["Closing", sum("closing")],
          ["On shelf", sum("on_shelf")],
        ]}
      />
      {mismatches.length > 0 && (
        <p
          role="alert"
          className="mb-3 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm"
        >
          {mismatches.length} model{mismatches.length > 1 ? "s" : ""} where the ledger and the shelf
          disagree
          {isFetching ? "" : `: ${mismatches.map((m) => `${m.brand} ${m.model}`).join(", ")}`}.
        </p>
      )}
      <DataTable rows={rows} name={`stock_ledger_${from}_${to}`} />
      <h3 className="mb-2 mt-6 font-medium">Every IMEI movement in the period</h3>
      <DataTable rows={trailRows} name={`stock_imei_ledger_${from}_${to}`} />
    </>
  );
}

function ExpenseReport({ branch, from, to, bname }: P) {
  const { data = [] } = useQuery({
    queryKey: ["rep-expenses", branch, from, to],
    enabled: !!branch,
    queryFn: async () => {
      let q = supabase
        .from("expenses")
        .select("*")
        .gte("expense_date", from)
        .lte("expense_date", to)
        .order("expense_date", { ascending: false });
      if (branch !== "all") q = q.eq("branch_id", branch);
      return fetchAllPages(q);
    },
  });
  // approved_by has no foreign key, so the signature is looked up by hand.
  const { data: staff = [] } = useQuery({
    queryKey: ["rep-staff"],
    queryFn: async () => fetchAllPages(supabase.from("profiles").select("id,full_name")),
  });
  const approved = data.filter((e) => e.status === "approved");
  const rows: Row[] = data.map((e) => ({
    Voucher: e.voucher_no ?? "",
    Date: e.expense_date.slice(0, 10),
    Branch: bname(e.branch_id),
    Head: e.category,
    Bill: e.bill_no ?? "",
    Note: e.note ?? "",
    Method: methodLabel(e.method),
    Amount: Number(e.amount),
    Status: e.status,
    "Approved by": staff.find((u) => u.id === e.approved_by)?.full_name ?? "",
    "Approved on": dt(e.approved_at),
  }));
  // Every head gets a line, even an empty one: a showroom that booked no rent
  // this month should see that, not a missing row.
  const heads: Row[] = EXPENSE_HEADS.map((h) => {
    const inHead = approved.filter((e) => e.category === h);
    return {
      Head: h,
      Entries: inHead.length,
      Cash: inHead.filter((e) => e.method === "cash").reduce((a, e) => a + Number(e.amount), 0),
      MFS: inHead.filter((e) => isMfs(e.method)).reduce((a, e) => a + Number(e.amount), 0),
      "Bank / card": inHead
        .filter((e) => !["cash"].includes(e.method) && !isMfs(e.method))
        .reduce((a, e) => a + Number(e.amount), 0),
      Total: inHead.reduce((a, e) => a + Number(e.amount), 0),
    };
  });
  const pending = data.filter((e) => e.status === "pending");
  const unproved = approved.filter((e) => !e.bill_no && !e.attachment_url);
  return (
    <>
      <Summary
        items={[
          ["Entries", data.length],
          ["Approved", taka(approved.reduce((a, e) => a + Number(e.amount), 0))],
          ["Waiting for approval", pending.length],
          ["No bill or receipt", unproved.length],
        ]}
      />
      <h3 className="mb-2 font-medium">By head</h3>
      <DataTable
        rows={heads}
        name={`expense_heads_${from}_${to}`}
        money={["Cash", "MFS", "Bank / card", "Total"]}
      />
      <h3 className="mb-2 mt-6 font-medium">Every expense in the period</h3>
      {unproved.length > 0 && (
        <p className="mb-2 text-xs text-muted-foreground">
          {unproved.length} approved {unproved.length === 1 ? "entry has" : "entries have"} no bill
          number or receipt link. The rule is that every expense carries its bill, its voucher or
          its approval as proof.
        </p>
      )}
      <DataTable rows={rows} name={`expenses_${from}_${to}`} money={["Amount"]} />
    </>
  );
}
