import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { taka } from "@/lib/erp";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { fetchAllPages } from "@/lib/paginated-query";

/** Partner balance: what the partner still owes the showroom. */
export function partnerBalance(cases: { amount: number; commission: number; status: string }[], ledger: { kind: string; amount: number }[]) {
  const owed = cases.reduce((s, c) => s + Number(c.amount) - (c.status === "settled" ? Number(c.commission) : 0), 0);
  const received = ledger.filter((l) => l.kind === "received").reduce((s, l) => s + Number(l.amount), 0);
  const paid = ledger.filter((l) => l.kind === "paid").reduce((s, l) => s + Number(l.amount), 0);
  return owed - received + paid;
}

export function PartnerAccounts({ branch, canAdd }: { branch: string; canAdd: boolean }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ partner: "", kind: "paid", amount: "", method: "cash", note: "" });
  const { data } = useQuery({
    queryKey: ["partner-accounts", branch], enabled: !!branch,
    queryFn: async () => {
      let c = supabase.from("finance_cases").select("partner_id, amount, commission, status");
      let l = supabase.from("finance_partner_ledger").select("*").order("created_at", { ascending: false });
      if (branch !== "all") { c = c.eq("branch_id", branch); l = l.eq("branch_id", branch); }
      const [p, cs, ls] = await Promise.all([
        fetchAllPages(supabase.from("finance_partners").select("*").order("name")),
        fetchAllPages(c),
        fetchAllPages(l),
      ]);
      return { partners: p, cases: cs, ledger: ls };
    },
  });
  const partners = data?.partners ?? [];
  async function save() {
    const { error } = await supabase.rpc("partner_payment", {
      _partner: f.partner, _branch: branch, _kind: f.kind, _amount: Number(f.amount), _method: f.method, _note: f.note,
    });
    if (error) { toast.error(error.message); return; }
    toast.success(f.kind === "paid" ? "Payment to partner saved" : "Receipt from partner saved");
    setF({ ...f, amount: "", note: "" });
    qc.invalidateQueries();
  }
  return (
    <Card className="mb-4 p-4">
      <div className="mb-2 font-semibold">Finance partner accounts</div>
      {canAdd && (
        <div className="mb-3 flex flex-wrap gap-2">
          <select className="rounded-md border bg-background px-2 py-2 text-sm" value={f.partner} onChange={(e) => setF({ ...f, partner: e.target.value })}>
            <option value="">Partner…</option>{partners.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <select className="rounded-md border bg-background px-2 py-2 text-sm" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
            <option value="paid">Pay partner (cash out)</option><option value="received">Receive from partner (cash in)</option>
          </select>
          <Input type="number" className="w-32" placeholder="Amount" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} />
          <select className="rounded-md border bg-background px-2 py-2 text-sm" value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })}>{["cash", "bank", "bkash", "nagad"].map((m) => <option key={m}>{m}</option>)}</select>
          <Input className="w-56" placeholder="Note" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
          <Button onClick={save} disabled={!f.partner || !(Number(f.amount) > 0)}>Save</Button>
        </div>
      )}
      <Table>
        <TableHeader><TableRow><TableHead>Partner</TableHead><TableHead className="text-right">Received</TableHead><TableHead className="text-right">Paid to partner</TableHead><TableHead className="text-right">Partner owes us</TableHead></TableRow></TableHeader>
        <TableBody>
          {partners.map((p) => {
            const cs = (data?.cases ?? []).filter((c) => c.partner_id === p.id);
            const ls = (data?.ledger ?? []).filter((l) => l.partner_id === p.id);
            const sum = (k: string) => ls.filter((l) => l.kind === k).reduce((s, l) => s + Number(l.amount), 0);
            return (
              <TableRow key={p.id}>
                <TableCell>{p.name}</TableCell>
                <TableCell className="text-right tabular">{taka(sum("received"))}</TableCell>
                <TableCell className="text-right tabular">{taka(sum("paid"))}</TableCell>
                <TableCell className="text-right tabular font-semibold">{taka(partnerBalance(cs, ls))}</TableCell>
              </TableRow>
            );
          })}
          {!partners.length && <TableRow><TableCell colSpan={4} className="py-6 text-center text-muted-foreground">No finance partners yet — add them on the Finance page.</TableCell></TableRow>}
        </TableBody>
      </Table>
    </Card>
  );
}
