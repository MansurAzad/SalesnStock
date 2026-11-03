import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment, useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { taka } from "@/lib/erp";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { fetchAllPages } from "@/lib/paginated-query";

const methodLabel = (m: string) =>
  m === "cash"
    ? "Cash"
    : m === "bank"
      ? "Bank"
      : m === "bkash"
        ? "bKash"
        : m === "nagad"
          ? "Nagad"
          : m;

/** Partner balance: what the partner still owes the showroom. */
export function partnerBalance(
  cases: { amount: number; commission: number; status: string }[],
  ledger: { kind: string; amount: number }[],
) {
  // A cancelled case is never owed. A settled case contributes what was
  // received (amount - commission), which the matching ledger row cancels out.
  const owed = cases
    .filter((c) => c.status !== "cancelled")
    .reduce(
      (s, c) => s + Number(c.amount) - (c.status === "settled" ? Number(c.commission) : 0),
      0,
    );
  const received = ledger
    .filter((l) => l.kind === "received")
    .reduce((s, l) => s + Number(l.amount), 0);
  const paid = ledger.filter((l) => l.kind === "paid").reduce((s, l) => s + Number(l.amount), 0);
  return owed - received + paid;
}

export function PartnerAccounts({ branch, canAdd }: { branch: string; canAdd: boolean }) {
  const qc = useQueryClient();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [f, setF] = useState({ partner: "", kind: "paid", amount: "", method: "cash", note: "" });
  const { data } = useQuery({
    queryKey: ["partner-accounts", branch],
    enabled: !!branch,
    queryFn: async () => {
      let c = supabase.from("finance_cases").select("partner_id, amount, commission, status");
      let l = supabase
        .from("finance_partner_ledger")
        .select("*")
        .order("created_at", { ascending: false });
      if (branch !== "all") {
        c = c.eq("branch_id", branch);
        l = l.eq("branch_id", branch);
      }
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
    if (branch === "all" || !branch) {
      toast.error("Choose one branch before recording a partner payment");
      return;
    }
    if (!f.partner) {
      toast.error("Choose a finance partner");
      return;
    }
    const amount = Number(f.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      toast.error("Enter an amount greater than zero");
      return;
    }
    const { error } = await supabase.rpc("partner_payment", {
      _partner: f.partner,
      _branch: branch,
      _kind: f.kind,
      _amount: amount,
      _method: f.method,
      _note: f.note,
    });
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success(f.kind === "paid" ? "Payment to partner saved" : "Receipt from partner saved");
    setF({ ...f, amount: "", note: "" });
    qc.invalidateQueries();
  }
  return (
    <Card className="mb-4 p-4">
      <div className="mb-2 font-semibold">Finance partner accounts</div>
      {canAdd && (
        <div className="mb-3 flex flex-wrap items-end gap-2">
          <div className="space-y-1">
            <Label className="text-xs">Partner</Label>
            <select
              aria-label="Finance partner"
              className="w-44 rounded-md border bg-background px-2 py-2 text-sm"
              value={f.partner}
              onChange={(e) => setF({ ...f, partner: e.target.value })}
            >
              <option value="">Partner…</option>
              {partners.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Type</Label>
            <select
              aria-label="Payment type"
              className="w-56 rounded-md border bg-background px-2 py-2 text-sm"
              value={f.kind}
              onChange={(e) => setF({ ...f, kind: e.target.value })}
            >
              <option value="paid">Pay partner (cash out)</option>
              <option value="received">Receive from partner (cash in)</option>
            </select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Amount ৳</Label>
            <Input
              type="number"
              min="0.01"
              className="w-32"
              aria-label="Amount"
              placeholder="Amount"
              value={f.amount}
              onChange={(e) => setF({ ...f, amount: e.target.value })}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Method</Label>
            <select
              aria-label="Payment method"
              className="w-32 rounded-md border bg-background px-2 py-2 text-sm"
              value={f.method}
              onChange={(e) => setF({ ...f, method: e.target.value })}
            >
              {["cash", "bank", "bkash", "nagad"].map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Note</Label>
            <Input
              className="w-56"
              aria-label="Note"
              placeholder="Note"
              value={f.note}
              onChange={(e) => setF({ ...f, note: e.target.value })}
            />
          </div>
          <Button
            onClick={save}
            disabled={!f.partner || !(Number(f.amount) > 0) || branch === "all" || !branch}
          >
            Save
          </Button>
        </div>
      )}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Partner</TableHead>
            <TableHead className="text-right">Received</TableHead>
            <TableHead className="text-right">Paid to partner</TableHead>
            <TableHead className="text-right">Partner owes us</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {partners.map((p) => {
            const cs = (data?.cases ?? []).filter((c) => c.partner_id === p.id);
            const ls = (data?.ledger ?? []).filter((l) => l.partner_id === p.id);
            const sum = (k: string) =>
              ls.filter((l) => l.kind === k).reduce((s, l) => s + Number(l.amount), 0);
            const open = expanded === p.id;
            return (
              <Fragment key={p.id}>
                <TableRow>
                  <TableCell>
                    <button
                      type="button"
                      className="text-left hover:underline"
                      aria-expanded={open}
                      onClick={() => setExpanded(open ? null : p.id)}
                    >
                      {p.name}
                    </button>
                  </TableCell>
                  <TableCell className="text-right tabular">{taka(sum("received"))}</TableCell>
                  <TableCell className="text-right tabular">{taka(sum("paid"))}</TableCell>
                  <TableCell className="text-right tabular font-semibold">
                    {taka(partnerBalance(cs, ls))}
                  </TableCell>
                </TableRow>
                {open && (
                  <TableRow>
                    <TableCell colSpan={4} className="bg-muted/40">
                      {ls.length === 0 ? (
                        <span className="text-sm text-muted-foreground">
                          No money movements with {p.name} yet.
                        </span>
                      ) : (
                        <div className="space-y-1">
                          <div className="text-xs font-semibold uppercase text-muted-foreground">
                            Statement — {p.name}
                          </div>
                          {ls.map((l) => (
                            <div
                              key={l.id}
                              className="flex flex-wrap items-center justify-between gap-2 text-sm"
                            >
                              <span>
                                {new Date(l.created_at).toLocaleString()} ·{" "}
                                {l.kind === "received" ? "Received" : "Paid to partner"}
                                {l.note ? ` — ${l.note}` : ""}
                              </span>
                              <span className="tabular">
                                {l.kind === "received" ? "+" : "−"} {taka(l.amount)} (
                                {methodLabel(l.method ?? "cash")})
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                )}
              </Fragment>
            );
          })}
          {!partners.length && (
            <TableRow>
              <TableCell colSpan={4} className="py-6 text-center text-muted-foreground">
                No finance partners yet — add them on the Finance page.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </Card>
  );
}
