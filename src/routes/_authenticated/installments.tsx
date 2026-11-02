import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { enqueue, isNetworkError } from "@/lib/offline";
import { supabase } from "@/integrations/supabase/client";
import { BranchPicker, PageHeader } from "@/components/BranchPicker";
import { taka, useBranches } from "@/lib/erp";
import { useT } from "@/lib/i18n";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { fetchAllPages } from "@/lib/paginated-query";

export const Route = createFileRoute("/_authenticated/installments")({
  head: () => ({ meta: [{ title: "Installments — Dealer ERP" }] }),
  component: Installments,
});

function Installments() {
  const { t } = useT();
  const qc = useQueryClient();
  const [branch, setBranch] = useState("");
  const [filter, setFilter] = useState<"due" | "upcoming" | "paid">("due");
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const { data: branches = [] } = useBranches();
  const today = new Date().toISOString().slice(0, 10);

  const { data = [] } = useQuery({
    queryKey: ["installments", branch],
    enabled: !!branch,
    queryFn: async () => {
      let q = supabase.from("installments").select("*, installment_plans(months, sales(invoice_no), customers(name,phone))").eq("cancelled", false).order("due_date");
      if (branch !== "all") q = q.eq("branch_id", branch);
      return fetchAllPages(q);
    },
  });
  const rows = data.filter((r) => {
    const paid = Number(r.paid_amount) >= Number(r.amount);
    if (filter === "paid") return paid;
    if (paid) return false;
    return filter === "due" ? r.due_date <= today : r.due_date > today;
  });
  const bname = (id: string) => branches.find((b) => b.id === id)?.name ?? "";

  async function pay(id: string, due: number) {
    const amt = Number(amounts[id] ?? due);
    const offline = async () => {
      await enqueue("kisti", { inst: id, amount: amt }, `Kisti ${taka(amt)}`);
      toast.success("Offline — collection saved and will sync when internet returns");
    };
    if (!navigator.onLine) { await offline(); return; }
    const { error } = await supabase.rpc("pay_installment", { _inst: id, _amount: amt });
    if (error && isNetworkError(error)) { await offline(); return; }
    if (error) { toast.error(error.message); return; }
    toast.success(`${taka(amt)} collected`);
    qc.invalidateQueries();
  }

  return (
    <div>
      <PageHeader title={t("Installments")}><BranchPicker value={branch} onChange={setBranch} allowAll /></PageHeader>
      <div className="mb-3 flex gap-1">
        {(["due", "upcoming", "paid"] as const).map((f) => (
          <Button key={f} size="sm" variant={filter === f ? "default" : "outline"} onClick={() => setFilter(f)} className="capitalize">{f === "due" ? "Due / overdue" : f}</Button>
        ))}
      </div>
      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("Customer")}</TableHead><TableHead>Invoice</TableHead><TableHead>{t("Branch")}</TableHead>
              <TableHead>#</TableHead><TableHead>Due date</TableHead><TableHead className="text-right">{t("Amount")}</TableHead>
              <TableHead className="text-right">{t("Due")}</TableHead><TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => {
              const due = Number(r.amount) - Number(r.paid_amount);
              const overdue = due > 0 && r.due_date < today;
              return (
                <TableRow key={r.id}>
                  <TableCell>{r.installment_plans?.customers?.name}<div className="text-xs text-muted-foreground">{r.installment_plans?.customers?.phone}</div></TableCell>
                  <TableCell className="font-mono text-xs">{r.installment_plans?.sales?.invoice_no}</TableCell>
                  <TableCell>{bname(r.branch_id)}</TableCell>
                  <TableCell>{r.seq}/{r.installment_plans?.months}</TableCell>
                  <TableCell>{r.due_date} {overdue && <Badge variant="outline" className="ml-1 bg-destructive/15 text-destructive">overdue</Badge>}</TableCell>
                  <TableCell className="text-right tabular">{taka(r.amount)}</TableCell>
                  <TableCell className="text-right tabular">{taka(due)}</TableCell>
                  <TableCell className="text-right">
                    {due > 0 && (
                      <div className="flex justify-end gap-1">
                        <Input type="number" className="h-8 w-24" placeholder={String(due)} value={amounts[r.id] ?? ""} onChange={(e) => setAmounts({ ...amounts, [r.id]: e.target.value })} />
                        <Button size="sm" onClick={() => pay(r.id, due)}>{t("Pay")}</Button>
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
            {rows.length === 0 && <TableRow><TableCell colSpan={8} className="py-8 text-center text-muted-foreground">Nothing here.</TableCell></TableRow>}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}
