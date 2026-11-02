import { logoSrc } from "@/lib/brand";
import { createFileRoute } from "@tanstack/react-router";
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { fetchAllPages } from "@/lib/paginated-query";

export const Route = createFileRoute("/_authenticated/reports")({
  head: () => ({ meta: [{ title: "Reports — Dealer ERP" }, { name: "description", content: "Sales, inventory, transfer and kisti reports." }] }),
  component: Reports,
});

type Row = Record<string, string | number>;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const fromTs = (d: string) => new Date(d + "T00:00:00").toISOString();
const toTs = (d: string) => new Date(d + "T23:59:59.999").toISOString();
const dt = (s: string | null) => (s ? new Date(s).toLocaleString() : "");

function Reports() {
  const { t } = useT();
  const [branch, setBranch] = useState("");
  const today = new Date();
  const [from, setFrom] = useState(iso(new Date(today.getFullYear(), today.getMonth(), 1)));
  const [to, setTo] = useState(iso(today));
  const [tab, setTab] = useState("sales");
  const { data: branches = [] } = useBranches();
  const { data: settings } = useSettings();
  const bname = (id: string | null) => branches.find((b) => b.id === id)?.name ?? "";
  const f = { branch, from, to };

  return (
    <div>
      <PageHeader title={t("Reports")}>
        <BranchPicker value={branch} onChange={setBranch} allowAll />
        <div className="flex min-w-36 flex-1 items-center gap-1 sm:flex-none"><Label className="text-xs">From</Label><Input type="date" className="w-full bg-card sm:w-40" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
        <div className="flex min-w-36 flex-1 items-center gap-1 sm:flex-none"><Label className="text-xs">To</Label><Input type="date" className="w-full bg-card sm:w-40" value={to} onChange={(e) => setTo(e.target.value)} /></div>
        <Button variant="outline" className="print:hidden" disabled={!branch} onClick={() => window.print()}>
          <Printer className="mr-1 h-4 w-4" /> PDF
        </Button>
      </PageHeader>
      <div className="mb-4 hidden print:block">
        <div className="flex items-center gap-2"><img src={logoSrc(settings?.logo_url)} alt="" className="h-10" /><div className="text-xl font-bold">{settings?.company_name}</div></div>
        {settings?.address && <div className="text-xs">{settings.address} {settings.phone}</div>}
        <h2 className="text-lg font-semibold">{({ sales: "Sales", inventory: "Inventory", transfers: "Transfer", kisti: "Kisti" } as Record<string, string>)[tab]} report</h2>
        <div className="text-sm">Branch: {branch === "all" ? "All branches" : bname(branch)} · {from} to {to} · Printed {new Date().toLocaleString()}</div>
      </div>
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="print:hidden">
          <TabsTrigger value="sales">{t("Sales")}</TabsTrigger>
          <TabsTrigger value="inventory">{t("Inventory")}</TabsTrigger>
          <TabsTrigger value="transfers">{t("Transfers")}</TabsTrigger>
          <TabsTrigger value="kisti">{t("Installments")}</TabsTrigger>
        </TabsList>
        <TabsContent value="sales"><SalesReport {...f} bname={bname} /></TabsContent>
        <TabsContent value="inventory"><InventoryReport {...f} bname={bname} /></TabsContent>
        <TabsContent value="transfers"><TransferReport {...f} bname={bname} /></TabsContent>
        <TabsContent value="kisti"><KistiReport {...f} bname={bname} /></TabsContent>
      </Tabs>
    </div>
  );
}

type P = { branch: string; from: string; to: string; bname: (id: string | null) => string };

function Summary({ items }: { items: [string, string | number][] }) {
  return (
    <div className="mb-3 grid grid-cols-2 gap-3 md:grid-cols-4">
      {items.map(([k, v]) => (
        <Card key={k} className="p-4"><div className="text-xs text-muted-foreground">{k}</div><div className="text-lg font-semibold tabular">{v}</div></Card>
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
        <Button size="sm" variant="outline" className="print:hidden" disabled={!rows.length} onClick={() => downloadCsv(rows, `${name}.csv`)}>
          <Download className="mr-1 h-4 w-4" /> CSV
        </Button>
      </div>
      <div className="max-h-[60vh] overflow-auto print:max-h-none print:overflow-visible">
        <Table>
          <TableHeader><TableRow>{headers.map((h) => <TableHead key={h} className={money.includes(h) ? "text-right" : ""}>{h}</TableHead>)}</TableRow></TableHeader>
          <TableBody>
            {rows.map((r, i) => (
              <TableRow key={i} className={i >= 500 ? "hidden print:table-row" : "break-inside-avoid"}>{headers.map((h) => <TableCell key={h} className={money.includes(h) ? "text-right tabular" : "text-xs"}>{money.includes(h) ? taka(r[h]) : r[h]}</TableCell>)}</TableRow>
            ))}
            {!rows.length && <TableRow><TableCell className="py-8 text-center text-muted-foreground">No data for these filters.</TableCell></TableRow>}
          </TableBody>
        </Table>
      </div>
      {rows.length > 500 && <div className="print:hidden p-2 text-center text-xs text-muted-foreground">Showing 500 of {rows.length}; CSV has all rows.</div>}
    </Card>
  );
}

function SalesReport({ branch, from, to, bname }: P) {
  const { data = [] } = useQuery({
    queryKey: ["rep-sales", branch, from, to],
    enabled: !!branch,
    queryFn: async () => {
      let q = supabase.from("sales").select("*, customers(name,phone), sale_items(price, inventory_items(imei, purchase_price, products(brand,model,variant)))")
        .gte("created_at", fromTs(from)).lte("created_at", toTs(to)).order("created_at", { ascending: false });
      if (branch !== "all") q = q.eq("branch_id", branch);
      return fetchAllPages(q);
    },
  });
  const activeSales = data.filter((s) => s.status !== "returned");
  const returnedSales = data.filter((s) => s.status === "returned");
  const rows: Row[] = activeSales.flatMap((s) => s.sale_items.map((i) => ({
    Invoice: s.invoice_no, Date: dt(s.created_at), Branch: bname(s.branch_id),
    Customer: s.customers?.name ?? "Walk-in", Phone: s.customers?.phone ?? "",
    Product: productLabel(i.inventory_items?.products), IMEI: i.inventory_items?.imei ?? "",
    Type: s.sale_type, Method: s.payment_method,
    Price: Number(i.price), Cost: Number(i.inventory_items?.purchase_price ?? 0),
    Profit: Number(i.price) - Number(i.inventory_items?.purchase_price ?? 0),
  })));
  const total = activeSales.reduce((a, s) => a + Number(s.total), 0);
  const paid = activeSales.reduce((a, s) => a + Number(s.paid), 0);
  const profit = rows.reduce((a, r) => a + Number(r["Profit"]), 0) - activeSales.reduce((a, s) => a + Number(s.discount), 0);
  return (
    <>
      <Summary items={[["Invoices", activeSales.length], ["Units sold", rows.length], ["Net sales", taka(total)], ["Gross profit", taka(profit)], ["Collected", taka(paid)], ["Discounts", taka(activeSales.reduce((a, s) => a + Number(s.discount), 0))], ["Cash sales", activeSales.filter((s) => s.sale_type === "cash").length], ["Kisti sales", activeSales.filter((s) => s.sale_type !== "cash").length], ["Returned invoices", returnedSales.length], ["Returned sale value", taka(returnedSales.reduce((a, s) => a + Number(s.total), 0))]]} />
      <DataTable rows={rows} name={`sales_${from}_${to}`} money={["Price", "Cost", "Profit"]} />
    </>
  );
}

function InventoryReport({ branch, from, to, bname }: P) {
  const { data = [] } = useQuery({
    queryKey: ["rep-inv", branch, from, to],
    enabled: !!branch,
    queryFn: async () => {
      let q = supabase.from("inventory_items").select("*, products(brand,model,variant,sale_price)")
        .gte("created_at", fromTs(from)).lte("created_at", toTs(to)).order("created_at", { ascending: false });
      if (branch !== "all") q = q.eq("branch_id", branch);
      return fetchAllPages(q);
    },
  });
  // Model-wise summary
  const map = new Map<string, Row>();
  for (const i of data) {
    const key = `${i.branch_id}|${i.product_id}`;
    const r = map.get(key) ?? { Branch: bname(i.branch_id), Product: productLabel(i.products), "In stock": 0, "In transit": 0, Sold: 0, Other: 0, "Stock value": 0 };
    if (i.status === "in_stock") { r["In stock"] = Number(r["In stock"]) + 1; r["Stock value"] = Number(r["Stock value"]) + Number(i.purchase_price); }
    else if (i.status === "in_transit") r["In transit"] = Number(r["In transit"]) + 1;
    else if (i.status === "sold") r["Sold"] = Number(r["Sold"]) + 1;
    else r["Other"] = Number(r["Other"]) + 1;
    map.set(key, r);
  }
  const summary = [...map.values()];
  const detail: Row[] = data.map((i) => ({
    "Received on": dt(i.created_at), Branch: bname(i.branch_id), Product: productLabel(i.products),
    IMEI: i.imei, IMEI2: i.imei2 ?? "", Status: i.status, Supplier: i.supplier ?? "", Cost: Number(i.purchase_price), MRP: Number(i.products?.sale_price ?? 0),
  }));
  const inStock = data.filter((i) => i.status === "in_stock");
  return (
    <>
      <p className="mb-2 text-xs text-muted-foreground">Items received in the selected dates.</p>
      <Summary items={[["Items received", data.length], ["Still in stock", inStock.length], ["Stock value (cost)", taka(inStock.reduce((a, i) => a + Number(i.purchase_price), 0))], ["Sold", data.filter((i) => i.status === "sold").length]]} />
      <h3 className="mb-2 font-medium">Model-wise summary</h3>
      <DataTable rows={summary} name={`stock_summary_${from}_${to}`} money={["Stock value"]} />
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
      let q = supabase.from("stock_transfers").select("*, transfer_items(inventory_items(imei, products(brand,model,variant)))")
        .gte("created_at", fromTs(from)).lte("created_at", toTs(to)).order("created_at", { ascending: false });
      if (branch !== "all") q = q.or(`from_branch_id.eq.${branch},to_branch_id.eq.${branch}`);
      return fetchAllPages(q);
    },
  });
  const rows: Row[] = data.flatMap((tr) => tr.transfer_items.map((i) => ({
    Transfer: tr.transfer_no, Sent: dt(tr.created_at), From: bname(tr.from_branch_id), To: bname(tr.to_branch_id),
    Product: productLabel(i.inventory_items?.products), IMEI: i.inventory_items?.imei ?? "",
    Status: tr.status, Received: dt(tr.received_at), Note: tr.note ?? "",
  })));
  return (
    <>
      <Summary items={[["Transfers", data.length], ["Units moved", rows.length], ["In transit", data.filter((x) => x.status === "in_transit").length], ["Received", data.filter((x) => x.status === "received").length]]} />
      <DataTable rows={rows} name={`transfers_${from}_${to}`} />
    </>
  );
}

function KistiReport({ branch, from, to, bname }: P) {
  const { data = [] } = useQuery({
    queryKey: ["rep-kisti", branch, from, to],
    enabled: !!branch,
    queryFn: async () => {
      let q = supabase.from("installments").select("*, installment_plans(months, sales(invoice_no), customers(name,phone))").eq("cancelled", false)
        .gte("due_date", from).lte("due_date", to).order("due_date");
      if (branch !== "all") q = q.eq("branch_id", branch);
      return fetchAllPages(q);
    },
  });
  const todayStr = iso(new Date());
  const rows: Row[] = data.map((i) => {
    const due = Number(i.amount) - Number(i.paid_amount);
    const status = due <= 0 ? "paid" : i.due_date < todayStr ? "overdue" : Number(i.paid_amount) > 0 ? "partial" : "upcoming";
    return {
      "Due date": i.due_date, Branch: bname(i.branch_id), Invoice: i.installment_plans?.sales?.invoice_no ?? "",
      Customer: i.installment_plans?.customers?.name ?? "", Phone: i.installment_plans?.customers?.phone ?? "",
      Kisti: `${i.seq}/${i.installment_plans?.months ?? ""}`, Amount: Number(i.amount), Paid: Number(i.paid_amount), Due: Math.max(0, due),
      Status: status, "Paid at": dt(i.paid_at),
    };
  });
  const sum = (k: string, pred: (r: Row) => boolean = () => true) => rows.filter(pred).reduce((a, r) => a + Number(r[k]), 0);
  return (
    <>
      <p className="mb-2 text-xs text-muted-foreground">Kistis falling due in the selected dates.</p>
      <Summary items={[["Kistis due", rows.length], ["Expected", taka(sum("Amount"))], ["Collected", taka(sum("Paid"))], ["Outstanding", taka(sum("Due"))], ["Overdue count", rows.filter((r) => r["Status"] === "overdue").length], ["Overdue amount", taka(sum("Due", (r) => r["Status"] === "overdue"))]]} />
      <DataTable rows={rows} name={`kisti_${from}_${to}`} money={["Amount", "Paid", "Due"]} />
    </>
  );
}
