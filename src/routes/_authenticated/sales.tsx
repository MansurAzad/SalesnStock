import { createFileRoute, Link } from "@tanstack/react-router";
import { Printer } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { BranchPicker, PageHeader } from "@/components/BranchPicker";
import { productLabel, taka, useBranches, useMe } from "@/lib/erp";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useT } from "@/lib/i18n";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { fetchAllPages } from "@/lib/paginated-query";

export const Route = createFileRoute("/_authenticated/sales")({
  head: () => ({ meta: [{ title: "Sales — Dealer ERP" }] }),
  component: Sales,
});

function Sales() {
  const { t } = useT();
  const [branch, setBranch] = useState("");
  const { data: branches = [] } = useBranches();
  const { data = [] } = useQuery({
    queryKey: ["sales", branch],
    enabled: !!branch,
    queryFn: async () => {
      let q = supabase.from("sales").select("*, customers(name,phone), sale_items(price, inventory_items(imei, products(brand,model,variant)))").order("created_at", { ascending: false });
      if (branch !== "all") q = q.eq("branch_id", branch);
      return fetchAllPages(q);
    },
  });
  const { data: me } = useMe();
  const qc = useQueryClient();
  const canReturn = !!me && (me.canWriteHq || me.roles.includes("branch_manager"));
  async function doReturn(id: string, inv: string) {
    const reason = window.prompt(`Return sale ${inv}? Stock goes back and a refund is recorded. Reason:`);
    if (!reason) return;
    const { error } = await supabase.rpc("return_sale", { _sale: id, _reason: reason });
    if (error) { toast.error(error.message); return; }
    toast.success("Sale returned");
    qc.invalidateQueries();
  }
  const bname = (id: string) => branches.find((b) => b.id === id)?.name ?? "";
  return (
    <div>
      <PageHeader title={t("Sales")}><BranchPicker value={branch} onChange={setBranch} allowAll /></PageHeader>
      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Invoice</TableHead><TableHead>{t("Date")}</TableHead><TableHead>{t("Branch")}</TableHead>
              <TableHead>{t("Customer")}</TableHead><TableHead>Items</TableHead><TableHead>Type</TableHead>
              <TableHead className="text-right">{t("Total")}</TableHead><TableHead className="text-right">{t("Paid")}</TableHead><TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((s) => (
              <TableRow key={s.id}>
                <TableCell className="font-mono text-xs">{s.invoice_no}</TableCell>
                <TableCell>{new Date(s.created_at).toLocaleString()}</TableCell>
                <TableCell>{bname(s.branch_id)}</TableCell>
                <TableCell>{s.customers ? `${s.customers.name} · ${s.customers.phone}` : "Walk-in"}</TableCell>
                <TableCell className="text-xs">
                  {s.sale_items.map((i, k) => <div key={k}>{productLabel(i.inventory_items?.products)} <span className="font-mono text-muted-foreground">{i.inventory_items?.imei}</span></div>)}
                </TableCell>
                <TableCell><Badge variant="outline" className="capitalize">{s.sale_type}</Badge>{s.status === "returned" && <Badge variant="destructive" className="ml-1">Returned</Badge>}{Number(s.discount) > 0 && <div className="text-xs text-muted-foreground">−{taka(s.discount)} {s.discount_reason}</div>}</TableCell>
                <TableCell className="text-right tabular">{taka(s.total)}</TableCell>
                <TableCell className="text-right tabular">{taka(s.paid)}</TableCell>
                <TableCell><Link to="/receipt/$saleId" params={{ saleId: s.id }} className="inline-flex items-center gap-1 text-sm text-primary"><Printer className="h-4 w-4" /> Print</Link>{canReturn && s.status !== "returned" && <button className="ml-3 text-sm text-destructive" onClick={() => doReturn(s.id, s.invoice_no)}>Return</button>}</TableCell>
              </TableRow>
            ))}
            {data.length === 0 && <TableRow><TableCell colSpan={9} className="py-8 text-center text-muted-foreground">No sales yet.</TableCell></TableRow>}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}
