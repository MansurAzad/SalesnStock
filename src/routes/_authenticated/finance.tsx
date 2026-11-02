import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { BranchPicker, PageHeader } from "@/components/BranchPicker";
import { taka, useBranches, useMe } from "@/lib/erp";
import { useT } from "@/lib/i18n";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { fetchAllPages } from "@/lib/paginated-query";

export const Route = createFileRoute("/_authenticated/finance")({
  head: () => ({ meta: [{ title: "Finance partners — Dealer ERP" }, { name: "description", content: "Third-party finance sales and settlements." }] }),
  component: Finance,
});

function usePartners() {
  return useQuery({
    queryKey: ["partners"],
    queryFn: async () => fetchAllPages(supabase.from("finance_partners").select("*").order("name")),
  });
}

function Finance() {
  const { t } = useT();
  const { data: me } = useMe();
  const [branch, setBranch] = useState("");
  const [status, setStatus] = useState("pending");
  const { data: branches = [] } = useBranches();
  const { data: partners = [] } = usePartners();
  const qc = useQueryClient();
  const { data: cases = [] } = useQuery({
    queryKey: ["finance-cases", branch, status],
    enabled: !!branch,
    queryFn: async () => {
      let q = supabase.from("finance_cases").select("*").order("created_at", { ascending: false });
      if (branch !== "all") q = q.eq("branch_id", branch);
      if (status !== "any") q = q.eq("status", status);
      return fetchAllPages(q);
    },
  });
  const pname = (id: string) => partners.find((p) => p.id === id)?.name ?? "";
  const bname = (id: string) => branches.find((b) => b.id === id)?.name ?? "";
  const pendingTotal = cases.filter((c) => c.status === "pending").reduce((a, c) => a + Number(c.amount), 0);

  async function settle(id: string, amount: number, pct: number) {
    const v = prompt("Amount received from partner (৳)", String(Math.round(amount * (1 - pct / 100))));
    if (v === null) return;
    const { error } = await supabase.rpc("settle_finance", { _case: id, _received: Number(v) });
    if (error) { toast.error(error.message); return; }
    toast.success("Settled and added to accounts");
    qc.invalidateQueries();
  }

  return (
    <div>
      <PageHeader title={t("Finance")}>
        <BranchPicker value={branch} onChange={setBranch} allowAll />
        <NewCase partners={partners} />
      </PageHeader>
      <Tabs defaultValue="cases">
        <TabsList><TabsTrigger value="cases">Finance sales</TabsTrigger><TabsTrigger value="partners">Partners</TabsTrigger></TabsList>
        <TabsContent value="cases">
          <div className="mb-3 flex items-center gap-2">
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger className="w-40 bg-card"><SelectValue /></SelectTrigger>
              <SelectContent>{["pending", "settled", "any"].map((s) => <SelectItem key={s} value={s} className="capitalize">{s}</SelectItem>)}</SelectContent>
            </Select>
            <div className="ml-auto text-sm">Receivable from partners: <b className="tabular">{taka(pendingTotal)}</b></div>
          </div>
          <Card>
            <Table>
              <TableHeader><TableRow>
                <TableHead>{t("Date")}</TableHead><TableHead>{t("Branch")}</TableHead><TableHead>Partner</TableHead><TableHead>Ref</TableHead>
                <TableHead>{t("Customer")}</TableHead><TableHead className="text-right">{t("Amount")}</TableHead><TableHead className="text-right">Commission</TableHead><TableHead>{t("Status")}</TableHead><TableHead />
              </TableRow></TableHeader>
              <TableBody>
                {cases.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell className="text-xs">{new Date(c.created_at).toLocaleDateString()}</TableCell>
                    <TableCell>{bname(c.branch_id)}</TableCell>
                    <TableCell>{pname(c.partner_id)}</TableCell>
                    <TableCell className="font-mono text-xs">{c.ref_no}</TableCell>
                    <TableCell>{c.customer_name} <span className="text-xs text-muted-foreground">{c.customer_phone}</span></TableCell>
                    <TableCell className="text-right tabular">{taka(c.amount)}</TableCell>
                    <TableCell className="text-right tabular">{c.status === "settled" ? taka(c.commission) : "—"}</TableCell>
                    <TableCell><Badge variant="outline" className="capitalize">{c.status}</Badge></TableCell>
                    <TableCell>{c.status === "pending" && <Button size="sm" variant="outline" onClick={() => settle(c.id, Number(c.amount), Number(partners.find((p) => p.id === c.partner_id)?.commission_pct ?? 0))}>Settle</Button>}</TableCell>
                  </TableRow>
                ))}
                {!cases.length && <TableRow><TableCell colSpan={9} className="py-8 text-center text-muted-foreground">No finance sales.</TableCell></TableRow>}
              </TableBody>
            </Table>
          </Card>
        </TabsContent>
        <TabsContent value="partners"><Partners canEdit={!!me?.canWriteHq} /></TabsContent>
      </Tabs>
    </div>
  );
}

function NewCase({ partners }: { partners: { id: string; name: string; active: boolean }[] }) {
  const { data: me } = useMe();
  const { data: branches = [] } = useBranches();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ branch_id: "", partner_id: "", customer_name: "", customer_phone: "", ref_no: "", amount: "", note: "" });
  const branchOptions = me?.isHq ? branches : branches.filter((b) => b.id === me?.branch_id);
  async function save() {
    const { error } = await supabase.from("finance_cases").insert({ ...f, branch_id: f.branch_id || me?.branch_id || "", amount: Number(f.amount), created_by: me!.id });
    if (error) { toast.error(error.message); return; }
    toast.success("Finance sale recorded");
    setOpen(false);
    setF({ branch_id: "", partner_id: "", customer_name: "", customer_phone: "", ref_no: "", amount: "", note: "" });
    qc.invalidateQueries({ queryKey: ["finance-cases"] });
  }
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button>New finance sale</Button></DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>Record finance sale</DialogTitle></DialogHeader>
        <p className="text-xs text-muted-foreground">Sell the phone in POS first (cash, method "bank"), then record the amount the finance partner will pay you here.</p>
        <div className="space-y-2">
          <Select value={f.branch_id} onValueChange={(v) => setF({ ...f, branch_id: v })}>
            <SelectTrigger><SelectValue placeholder="Branch" /></SelectTrigger>
            <SelectContent>{branchOptions.map((b) => <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>)}</SelectContent>
          </Select>
          <Select value={f.partner_id} onValueChange={(v) => setF({ ...f, partner_id: v })}>
            <SelectTrigger><SelectValue placeholder="Finance partner" /></SelectTrigger>
            <SelectContent>{partners.filter((p) => p.active).map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}</SelectContent>
          </Select>
          {(["customer_name", "customer_phone", "ref_no", "amount", "note"] as const).map((k) => (
            <div key={k}><Label className="text-xs capitalize">{k.replace("_", " ")}</Label><Input type={k === "amount" ? "number" : "text"} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} /></div>
          ))}
          <Button className="w-full" disabled={!f.partner_id || !(f.branch_id || me?.branch_id) || !f.customer_name || !Number(f.amount)} onClick={save}>Save</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Partners({ canEdit }: { canEdit: boolean }) {
  const { data: partners = [] } = usePartners();
  const qc = useQueryClient();
  const [f, setF] = useState({ name: "", contact: "", commission_pct: "" });
  async function add() {
    const { error } = await supabase.from("finance_partners").insert({ ...f, commission_pct: Number(f.commission_pct || 0) });
    if (error) { toast.error(error.message); return; }
    setF({ name: "", contact: "", commission_pct: "" });
    qc.invalidateQueries({ queryKey: ["partners"] });
  }
  async function toggle(id: string, active: boolean) {
    await supabase.from("finance_partners").update({ active }).eq("id", id);
    qc.invalidateQueries({ queryKey: ["partners"] });
  }
  return (
    <div className="space-y-3">
      {canEdit && (
        <Card className="flex flex-wrap items-end gap-2 p-4">
          <div><Label className="text-xs">Name</Label><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
          <div><Label className="text-xs">Contact</Label><Input value={f.contact} onChange={(e) => setF({ ...f, contact: e.target.value })} /></div>
          <div><Label className="text-xs">Commission %</Label><Input type="number" className="w-28" value={f.commission_pct} onChange={(e) => setF({ ...f, commission_pct: e.target.value })} /></div>
          <Button disabled={!f.name} onClick={add}>Add partner</Button>
        </Card>
      )}
      <Card>
        <Table>
          <TableHeader><TableRow><TableHead>Name</TableHead><TableHead>Contact</TableHead><TableHead className="text-right">Commission</TableHead><TableHead>Status</TableHead></TableRow></TableHeader>
          <TableBody>
            {partners.map((p) => (
              <TableRow key={p.id}>
                <TableCell>{p.name}</TableCell><TableCell>{p.contact}</TableCell><TableCell className="text-right">{Number(p.commission_pct)}%</TableCell>
                <TableCell>{canEdit ? <Button size="sm" variant="ghost" onClick={() => toggle(p.id, !p.active)}>{p.active ? "Active" : "Inactive"}</Button> : p.active ? "Active" : "Inactive"}</TableCell>
              </TableRow>
            ))}
            {!partners.length && <TableRow><TableCell colSpan={4} className="py-8 text-center text-muted-foreground">No partners yet.</TableCell></TableRow>}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}
