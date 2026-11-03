import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { AlertTriangle, ArrowRight } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { BranchPicker, PageHeader } from "@/components/BranchPicker";
import { taka, useBranches } from "@/lib/erp";
import { useT } from "@/lib/i18n";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
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

export const Route = createFileRoute("/_authenticated/dashboard")({
  head: () => ({ meta: [{ title: "Dashboard — Dealer ERP" }] }),
  component: Dashboard,
});

function Dashboard() {
  const { t } = useT();
  const [branch, setBranch] = useState("");
  const { data: branches = [] } = useBranches();
  const { data, error } = useQuery({
    queryKey: ["dashboard", branch],
    enabled: !!branch,
    queryFn: async () => {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const month = new Date(today.getFullYear(), today.getMonth(), 1);
      const todayStr = localDate();
      const scoped = branch !== "all";

      const salesBase = supabase
        .from("sales")
        .select("id,invoice_no,total,paid,sale_type,status,created_at,branch_id,customer_id")
        .neq("status", "returned")
        .gte("created_at", month.toISOString())
        .order("created_at", { ascending: false });
      const stockBase = supabase
        .from("inventory_items")
        .select("id", { count: "exact", head: true })
        .eq("status", "in_stock");
      const instBase = supabase
        .from("installments")
        .select("amount,paid_amount,due_date")
        .eq("cancelled", false);
      const txBase = supabase.from("transactions").select("kind,amount");
      const finBase = supabase
        .from("finance_cases")
        .select("id,amount,status")
        .eq("status", "pending");
      const expBase = supabase.from("expenses").select("id,amount,status").eq("status", "pending");

      const salesQ = scoped ? salesBase.eq("branch_id", branch) : salesBase;
      const stockQ = scoped ? stockBase.eq("branch_id", branch) : stockBase;
      const instQ = scoped ? instBase.eq("branch_id", branch) : instBase;
      const txQ = scoped ? txBase.eq("branch_id", branch) : txBase;
      const finQ = scoped ? finBase.eq("branch_id", branch) : finBase;
      const expQ = scoped ? expBase.eq("branch_id", branch) : expBase;

      const [sales, stock, inst, tx, fin, exp, ageing, low] = await Promise.all([
        fetchAllPages(salesQ),
        stockQ,
        fetchAllPages(instQ),
        fetchAllPages(txQ),
        fetchAllPages(finQ),
        fetchAllPages(expQ),
        supabase.rpc("kisti_ageing", { _branch: scoped ? branch : null }),
        supabase.rpc("low_stock_products", { _branch: scoped ? branch : null }),
      ]);

      const todaySales = sales
        .filter((x) => new Date(x.created_at) >= today)
        .reduce((a, x) => a + Number(x.total), 0);
      const monthSales = sales.reduce((a, x) => a + Number(x.total), 0);

      // Overdue and not-yet-due are different problems, so they get different
      // numbers: one is money already late, the other is money still coming.
      const open = inst.filter((x) => Number(x.paid_amount) < Number(x.amount));
      const overdue = open.filter((x) => x.due_date < todayStr);
      const upcoming = open.filter((x) => x.due_date >= todayStr);
      const overdueTotal = overdue.reduce(
        (a, x) => a + (Number(x.amount) - Number(x.paid_amount)),
        0,
      );
      const upcomingTotal = upcoming.reduce(
        (a, x) => a + (Number(x.amount) - Number(x.paid_amount)),
        0,
      );

      const cash = tx.reduce((a, x) => a + (x.kind === "income" ? 1 : -1) * Number(x.amount), 0);

      return {
        todaySales,
        monthSales,
        stock: stock.count ?? 0,
        overdue: overdueTotal,
        overdueCount: overdue.length,
        upcoming: upcomingTotal,
        cash,
        pendingFinance: fin.length,
        pendingFinanceAmount: fin.reduce((a, x) => a + Number(x.amount), 0),
        pendingExpenses: exp.length,
        pendingExpenseAmount: exp.reduce((a, x) => a + Number(x.amount), 0),
        ageing: ageing.data ?? [],
        lowStock: low.data ?? [],
        recent: sales.slice(0, 8),
      };
    },
  });
  const bname = (id: string) => branches.find((b) => b.id === id)?.name ?? "";

  const stats = [
    { label: "Today's sales", value: taka(data?.todaySales), to: "/sales" },
    { label: "Month sales", value: taka(data?.monthSales), to: "/sales" },
    { label: "In stock", value: String(data?.stock ?? 0) + " pcs", to: "/inventory" },
    {
      label: "Overdue kisti",
      value: taka(data?.overdue),
      to: "/installments",
      danger: (data?.overdue ?? 0) > 0,
    },
    { label: "Cash balance", value: taka(data?.cash), to: "/accounts" },
  ];

  const alerts: {
    key: string;
    label: string;
    detail: string;
    to: string;
    danger: boolean;
  }[] = [];
  if ((data?.overdueCount ?? 0) > 0) {
    alerts.push({
      key: "overdue",
      label: `${data?.overdueCount} ${t("kisti overdue")}`,
      detail: taka(data?.overdue),
      to: "/installments",
      danger: true,
    });
  }
  if ((data?.lowStock?.length ?? 0) > 0) {
    alerts.push({
      key: "low",
      label: `${data?.lowStock?.length} ${t("models below reorder level")}`,
      detail: (data?.lowStock ?? [])
        .slice(0, 3)
        .map((p) => `${p.brand} ${p.model} (${p.in_stock}/${p.min_stock})`)
        .join(", "),
      to: "/inventory",
      danger: true,
    });
  }
  if ((data?.pendingFinance ?? 0) > 0) {
    alerts.push({
      key: "finance",
      label: `${data?.pendingFinance} ${t("finance cases pending")}`,
      detail: taka(data?.pendingFinanceAmount),
      to: "/finance",
      danger: false,
    });
  }
  if ((data?.pendingExpenses ?? 0) > 0) {
    alerts.push({
      key: "expense",
      label: `${data?.pendingExpenses} ${t("expenses awaiting approval")}`,
      detail: taka(data?.pendingExpenseAmount),
      to: "/expenses",
      danger: false,
    });
  }

  return (
    <div>
      <PageHeader title={t("Dashboard")}>
        <BranchPicker value={branch} onChange={setBranch} allowAll />
      </PageHeader>
      {error && (
        <p className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          Could not load the dashboard: {error.message}
        </p>
      )}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        {stats.map((s, i) => (
          <Link key={s.label} to={s.to} className="block">
            <Card
              className={`p-5 transition-colors hover:border-primary/60 ${i === 0 ? "border-accent bg-accent/15" : ""}`}
            >
              <div className="text-xs uppercase tracking-wide text-muted-foreground">
                {t(s.label)}
              </div>
              <div
                className={`mt-2 font-display text-2xl font-semibold tabular ${s.danger ? "text-destructive" : ""}`}
              >
                {s.value}
              </div>
            </Card>
          </Link>
        ))}
      </div>

      {alerts.length > 0 && (
        <>
          <h2 className="mb-3 mt-8 text-lg font-semibold">{t("Needs attention")}</h2>
          <div className="mb-8 grid gap-3 md:grid-cols-2">
            {alerts.map((a) => (
              <Link key={a.key} to={a.to}>
                <Card
                  className={`flex items-start gap-3 p-4 transition-colors hover:border-primary/60 ${
                    a.danger ? "border-destructive/40 bg-destructive/5" : ""
                  }`}
                >
                  <AlertTriangle
                    className={`mt-0.5 h-5 w-5 shrink-0 ${a.danger ? "text-destructive" : "text-muted-foreground"}`}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="font-medium">{a.label}</div>
                    <div className="truncate text-sm text-muted-foreground">{a.detail}</div>
                  </div>
                  <ArrowRight className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                </Card>
              </Link>
            ))}
          </div>
        </>
      )}

      {data && data.ageing.length > 0 && (
        <>
          <h2 className="mb-3 mt-8 text-lg font-semibold">{t("Kisti ageing")}</h2>
          <Card className="mb-8 p-4">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {data.ageing.map((a) => (
                <Link key={a.bucket} to="/installments" className="block">
                  <div className="rounded-md border p-3 transition-colors hover:border-primary/60">
                    <div className="text-xs uppercase text-muted-foreground">
                      {a.bucket === "overdue"
                        ? t("Overdue")
                        : a.bucket === "next_30"
                          ? t("Next 30 days")
                          : a.bucket === "next_60"
                            ? t("31–60 days")
                            : t("Later")}
                    </div>
                    <div className="font-display text-lg font-semibold tabular">
                      {taka(a.total)}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {a.cnt} {t("kistis")}
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          </Card>
        </>
      )}

      <h2 className="mb-3 mt-8 text-lg font-semibold">{t("Recent sales")}</h2>
      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("Invoice")}</TableHead>
              <TableHead>{t("Branch")}</TableHead>
              <TableHead>{t("Type")}</TableHead>
              <TableHead className="text-right">{t("Total")}</TableHead>
              <TableHead className="text-right">{t("Paid")}</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {data?.recent.map((s) => (
              <TableRow key={s.id}>
                <TableCell className="font-mono text-xs">{s.invoice_no}</TableCell>
                <TableCell>{bname(s.branch_id)}</TableCell>
                <TableCell className="capitalize">{s.sale_type}</TableCell>
                <TableCell className="text-right tabular">{taka(s.total)}</TableCell>
                <TableCell className="text-right tabular">{taka(s.paid)}</TableCell>
                <TableCell className="text-right">
                  <Link
                    to="/receipt/$saleId"
                    params={{ saleId: s.id }}
                    className="text-sm text-primary hover:underline"
                  >
                    {t("Receipt")}
                  </Link>
                </TableCell>
              </TableRow>
            ))}
            {data && data.recent.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                  {t("No sales this month yet.")}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Card>

      {data && data.lowStock.length > 0 && (
        <>
          <h2 className="mb-3 mt-8 text-lg font-semibold">{t("Low stock")}</h2>
          <Card>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("Product")}</TableHead>
                  <TableHead className="text-right">{t("In stock")}</TableHead>
                  <TableHead className="text-right">{t("Reorder at")}</TableHead>
                  <TableHead className="text-right">{t("Short by")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.lowStock.map((p) => (
                  <TableRow key={p.product_id}>
                    <TableCell className="font-medium">
                      {p.brand} {p.model}
                      {p.variant ? " " + p.variant : ""}
                    </TableCell>
                    <TableCell className="text-right tabular">{p.in_stock}</TableCell>
                    <TableCell className="text-right tabular">{p.min_stock}</TableCell>
                    <TableCell className="text-right tabular">
                      <Badge variant="destructive">{p.shortage}</Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        </>
      )}
    </div>
  );
}
