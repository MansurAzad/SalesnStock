import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { enqueue, isNetworkError } from "@/lib/offline";
import { supabase } from "@/integrations/supabase/client";
import { BranchPicker, PageHeader } from "@/components/BranchPicker";
import { taka, useBranches, useMe } from "@/lib/erp";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { fetchAllPages } from "@/lib/paginated-query";

export const Route = createFileRoute("/_authenticated/expenses")({
  head: () => ({ meta: [
    { title: "Expenses & petty cash — Dealer ERP" },
    { name: "description", content: "Record showroom expenses with approval limits." },
  ] }),
  component: Expenses,
});

const CATS = ["Shop rent", "Electricity bill", "Staff salary", "Transport", "Food", "Internet & phone", "Repair & maintenance", "Other"];

function Expenses() {
  const qc = useQueryClient();
  const { data: me } = useMe();
  const { data: branches = [] } = useBranches();
  const [branch, setBranch] = useState("");
  const today = new Date().toISOString().slice(0, 10);
  const [f, setF] = useState({ category: CATS[0] ?? "Other", amount: "", date: today, method: "cash", note: "", attachment: "" });
  const limit = branches.find((b) => b.id === branch)?.expense_limit;
  const { data = [] } = useQuery({
    queryKey: ["expenses", branch], enabled: !!branch,
    queryFn: async () => {
      let q = supabase.from("expenses").select("*").order("created_at", { ascending: false });
      if (branch !== "all") q = q.eq("branch_id", branch);
      return fetchAllPages(q);
    },
  });

  async function submit() {
    if (branch === "all") { toast.error("Choose a branch"); return; }
    const offline = async () => {
      await enqueue("expense", { branch, category: f.category, amount: Number(f.amount), date: f.date, method: f.method, note: f.note, attachment: f.attachment }, `Expense ${f.category} ৳${f.amount}`);
      toast.success("Offline — expense saved and will sync when internet returns");
      setF({ ...f, amount: "", note: "", attachment: "" });
    };
    if (!navigator.onLine) { await offline(); return; }
    const { data: st, error } = await supabase.rpc("submit_expense", {
      _branch: branch, _category: f.category, _amount: Number(f.amount), _date: f.date, _method: f.method, _note: f.note, _attachment: f.attachment,
    });
    if (error && isNetworkError(error)) { await offline(); return; }
    if (error) { toast.error(error.message); return; }
    toast.success(st === "approved" ? "Expense recorded" : "Above limit — sent for admin approval");
    setF({ ...f, amount: "", note: "", attachment: "" }); qc.invalidateQueries();
  }
  async function decide(id: string, ok: boolean) {
    const { error } = await supabase.rpc("decide_expense", { _expense: id, _approve: ok });
    if (error) { toast.error(error.message); return; }
    qc.invalidateQueries();
  }
  const approved = data.filter((e) => e.status === "approved").reduce((s, e) => s + Number(e.amount), 0);

  return (
    <div>
      <PageHeader title="Expenses"><BranchPicker value={branch} onChange={setBranch} allowAll /></PageHeader>
      <Card className="mb-4 grid gap-2 p-4 md:grid-cols-6">
        <div><Label className="text-xs">Category</Label><select className="w-full rounded-md border bg-background px-2 py-2" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>{CATS.map((c) => <option key={c}>{c}</option>)}</select></div>
        <div><Label className="text-xs">Amount ৳</Label><Input type="number" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></div>
        <div><Label className="text-xs">Date</Label><Input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></div>
        <div><Label className="text-xs">Method</Label><select className="w-full rounded-md border bg-background px-2 py-2" value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })}>{["cash", "bank", "bkash", "nagad"].map((m) => <option key={m}>{m}</option>)}</select></div>
        <div><Label className="text-xs">Note</Label><Input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></div>
        <div><Label className="text-xs">Receipt link (optional)</Label><Input value={f.attachment} onChange={(e) => setF({ ...f, attachment: e.target.value })} placeholder="https://" /></div>
        <div className="md:col-span-6 flex items-center gap-3">
          <Button onClick={submit} disabled={!f.amount || Number(f.amount) <= 0 || !branch}>Add expense</Button>
          {limit != null && <span className="text-xs text-muted-foreground">Manager limit for this branch: {taka(limit)}. Larger amounts need admin approval.</span>}
        </div>
      </Card>
      <Card>
        <div className="p-4 text-sm">Approved total: <b>{taka(approved)}</b></div>
        <Table>
          <TableHeader><TableRow><TableHead>Date</TableHead><TableHead>Branch</TableHead><TableHead>Category</TableHead><TableHead>Note</TableHead><TableHead>Method</TableHead><TableHead className="text-right">Amount</TableHead><TableHead>Status</TableHead><TableHead /></TableRow></TableHeader>
          <TableBody>
            {data.map((e) => (
              <TableRow key={e.id}>
                <TableCell>{e.expense_date}</TableCell>
                <TableCell>{branches.find((b) => b.id === e.branch_id)?.name}</TableCell>
                <TableCell>{e.category}</TableCell>
                <TableCell className="text-xs">{e.note}{e.attachment_url && <a className="ml-1 text-primary" href={e.attachment_url} target="_blank" rel="noreferrer">receipt</a>}</TableCell>
                <TableCell>{e.method}</TableCell>
                <TableCell className="text-right">{taka(e.amount)}</TableCell>
                <TableCell><Badge variant={e.status === "approved" ? "outline" : e.status === "pending" ? "secondary" : "destructive"}>{e.status}</Badge></TableCell>
                <TableCell>{me?.canWriteHq && e.status === "pending" && <div className="flex gap-1"><Button size="sm" onClick={() => decide(e.id, true)}>Approve</Button><Button size="sm" variant="ghost" onClick={() => decide(e.id, false)}>Reject</Button></div>}</TableCell>
              </TableRow>
            ))}
            {data.length === 0 && <TableRow><TableCell colSpan={8} className="py-8 text-center text-muted-foreground">No expenses yet.</TableCell></TableRow>}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}
