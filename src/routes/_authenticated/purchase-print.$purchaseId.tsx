import { logoSrc } from "@/lib/brand";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Printer } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { productLabel, taka, useBranches, useSettings } from "@/lib/erp";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/_authenticated/purchase-print/$purchaseId")({
  head: () => ({ meta: [
    { title: "Purchase receipt — Dealer ERP" },
    { name: "description", content: "Printable goods-received note for a supplier invoice." },
  ] }),
  component: PurchasePrint,
});

export function purchaseDocNo(seq: number | null | undefined) {
  return `PUR-${String(seq ?? 0).padStart(6, "0")}`;
}

function PurchasePrint() {
  const { purchaseId } = Route.useParams();
  const { data: s } = useSettings();
  const { data: branches = [] } = useBranches();
  const { data: p, isLoading } = useQuery({
    queryKey: ["purchase-print", purchaseId],
    queryFn: async () => {
      const { data, error } = await supabase.from("purchases")
        .select("*, suppliers(name, phone, address), purchase_items(id, cost, returned, inventory_items(imei, imei2, products(brand,model,variant))), purchase_payments(amount, method, created_at)")
        .eq("id", purchaseId).maybeSingle();
      if (error) throw error;
      return data;
    },
  });
  if (isLoading) return null;
  if (!p) return <p>Purchase not found.</p>;
  const branch = branches.find((b) => b.id === p.branch_id);
  const due = Number(p.total) - Number(p.returned) - Number(p.paid);
  const pays = [...(p.purchase_payments ?? [])].sort((a, b) => a.created_at.localeCompare(b.created_at));

  return (
    <div>
      <style>{`@media print { @page { size: A4; margin: 12mm; } }`}</style>
      <div className="mb-4 flex items-center gap-2 print:hidden">
        <Button variant="ghost" asChild><Link to="/purchases"><ArrowLeft className="mr-1 h-4 w-4" /> Back</Link></Button>
        <Button onClick={() => window.print()}><Printer className="mr-1 h-4 w-4" /> Print</Button>
      </div>
      <div className="mx-auto bg-card p-6 text-card-foreground shadow print:p-0 print:shadow-none" style={{ maxWidth: "210mm" }}>
        <div className="flex items-center gap-3 border-b-2 border-foreground pb-3">
          {<img src={logoSrc(s?.logo_url)} alt="" className="h-16" />}
          <div className="flex-1">
            <div className="text-2xl font-bold">{s?.company_name ?? "Dealer ERP"}</div>
            {s?.tagline && <div className="text-xs">{s.tagline}</div>}
            <div className="text-xs">{branch?.name}{branch?.address ? `, ${branch.address}` : ""}</div>
            <div className="text-xs">{[branch?.phone, s?.phone].filter(Boolean).join(" · ")}{s?.address ? ` · ${s.address}` : ""}</div>
          </div>
          <div className="text-right text-lg font-bold">Purchase Receipt</div>
        </div>
        <div className="my-3 grid grid-cols-2 gap-1 text-xs">
          <div>
            <div><b>Doc no:</b> <span className="font-mono">{purchaseDocNo(p.seq_no)}</span></div>
            <div><b>Supplier invoice no:</b> {p.supplier_invoice || "—"}</div>
            <div><b>Date & time:</b> {new Date(p.created_at).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "medium" })}</div>
          </div>
          <div className="text-right">
            <div><b>Supplier:</b> {p.suppliers?.name}</div>
            {p.suppliers?.phone && <div><b>Phone:</b> {p.suppliers.phone}</div>}
            {p.suppliers?.address && <div><b>Address:</b> {p.suppliers.address}</div>}
          </div>
        </div>
        <table className="w-full text-xs">
          <thead><tr className="border-y border-foreground text-left"><th className="py-1">#</th><th>Item / IMEI</th><th>Status</th><th className="text-right">Cost</th></tr></thead>
          <tbody>
            {p.purchase_items.map((i, k) => (
              <tr key={i.id} className="border-b border-dashed align-top">
                <td className="py-1 pr-1">{k + 1}</td>
                <td>{productLabel(i.inventory_items?.products)}<div className="font-mono text-[10px]">IMEI: {i.inventory_items?.imei}{i.inventory_items?.imei2 ? ` / ${i.inventory_items.imei2}` : ""}</div></td>
                <td>{i.returned ? "Returned" : "Received"}</td>
                <td className="text-right tabular">{taka(i.cost)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="ml-auto mt-2 w-64 text-xs tabular">
          <div className="flex justify-between"><span>Total ({p.purchase_items.length} items)</span><span>{taka(p.total)}</span></div>
          {Number(p.returned) > 0 && <div className="flex justify-between"><span>Returned</span><span>−{taka(p.returned)}</span></div>}
          {pays.map((x, k) => <div key={k} className="flex justify-between"><span>Paid {new Date(x.created_at).toLocaleDateString("en-GB")} ({x.method})</span><span>{taka(x.amount)}</span></div>)}
          {!pays.length && Number(p.paid) > 0 && <div className="flex justify-between"><span>Paid</span><span>{taka(p.paid)}</span></div>}
          <div className="flex justify-between border-t border-foreground pt-1 font-bold"><span>Supplier due</span><span>{taka(due)}</span></div>
        </div>
        {p.note && <p className="mt-3 text-xs">Note: {p.note}</p>}
        <div className="mt-16 grid grid-cols-2 gap-10 text-center text-xs">
          <div className="border-t border-foreground pt-1">Supplier signature</div>
          <div className="border-t border-foreground pt-1">Received by (authorised)</div>
        </div>
        {s?.invoice_footer && <p className="mt-6 text-center text-[10px]">{s.invoice_footer}</p>}
      </div>
    </div>
  );
}
