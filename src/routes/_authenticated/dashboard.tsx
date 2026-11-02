import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { BranchPicker, PageHeader } from "@/components/BranchPicker";
import { taka, useBranches } from "@/lib/erp";
import { useT } from "@/lib/i18n";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { fetchAllPages } from "@/lib/paginated-query";

export const Route = createFileRoute("/_authenticated/dashboard")({
  head: () => ({ meta: [{ title: "Dashboard — Dealer ERP" }] }),
  component: Dashboard,
});

function Dashboard() {
  const { t } = useT();
  const [branch, setBranch] = useState("");
  const { data: branches = [] } = useBranches();
  const { data } = useQuery({
    queryKey: ["dashboard", branch],
    enabled: !!branch,
    queryFn: async () => {
      const f = <T,>(q: T) => (branch === "all" ? q : (q as any).eq("branch_id", branch));
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const month = new Date(today.getFullYear(), today.getMonth(), 1);
      const [sales, stock, inst, tx] = await Promise.all([
        fetchAllPages(f(supabase.from("sales").select("id,invoice_no,total,paid,sale_type,status,created_at,branch_id").neq("status", "returned").gte("created_at", month.toISOString()).order("created_at", { ascending: false }))),
        f(supabase.from("inventory_items").select("id", { count: "exact", head: true }).eq("status", "in_stock")),
        fetchAllPages(f(supabase.from("installments").select("amount,paid_amount,due_date").eq("cancelled", false).lte("due_date", new Date().toISOString().slice(0, 10)))),
        fetchAllPages(f(supabase.from("transactions").select("kind,amount"))),
      ]);
      const s = sales as any[];
      const todaySales = s.filter((x) => new Date(x.created_at) >= today).reduce((a, x) => a + Number(x.total), 0);
      const monthSales = s.reduce((a, x) => a + Number(x.total), 0);
      const due = (inst as any[]).reduce((a, x) => a + (Number(x.amount) - Number(x.paid_amount)), 0);
      const cash = (tx as any[]).reduce((a, x) => a + (x.kind === "income" ? 1 : -1) * Number(x.amount), 0);
      return { todaySales, monthSales, stock: stock.count ?? 0, due, cash, recent: s.slice(0, 8) };
    },
  });
  const bname = (id: string) => branches.find((b) => b.id === id)?.name ?? "";

  const stats = [
    { label: "Today's sales", value: taka(data?.todaySales) },
    { label: "Month sales", value: taka(data?.monthSales) },
    { label: "In stock", value: String(data?.stock ?? 0) + " pcs" },
    { label: "Due installments", value: taka(data?.due) },
    { label: "Cash balance", value: taka(data?.cash) },
  ];

  return (
    <div>
      <PageHeader title={t("Dashboard")}>
        <BranchPicker value={branch} onChange={setBranch} allowAll />
      </PageHeader>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        {stats.map((s, i) => (
          <Card key={s.label} className={`p-5 ${i === 0 ? "border-accent bg-accent/15" : ""}`}>
            <div className="text-xs uppercase tracking-wide text-muted-foreground">{t(s.label)}</div>
            <div className="mt-2 font-display text-2xl font-semibold tabular">{s.value}</div>
          </Card>
        ))}
      </div>
      <h2 className="mb-3 mt-8 text-lg font-semibold">{t("Recent sales")}</h2>
      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Invoice</TableHead>
              <TableHead>{t("Branch")}</TableHead>
              <TableHead>Type</TableHead>
              <TableHead className="text-right">{t("Total")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data?.recent.map((s: any) => (
              <TableRow key={s.id}>
                <TableCell className="font-mono text-xs">{s.invoice_no}</TableCell>
                <TableCell>{bname(s.branch_id)}</TableCell>
                <TableCell className="capitalize">{s.sale_type}</TableCell>
                <TableCell className="text-right tabular">{taka(s.total)}</TableCell>
              </TableRow>
            ))}
            {data && data.recent.length === 0 && (
              <TableRow>
                <TableCell colSpan={4} className="py-8 text-center text-muted-foreground">No sales this month yet.</TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}
