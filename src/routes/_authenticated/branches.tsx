import { createFileRoute } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { PageHeader } from "@/components/BranchPicker";
import { useBranches, useMe } from "@/lib/erp";
import { useT } from "@/lib/i18n";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export const Route = createFileRoute("/_authenticated/branches")({
  head: () => ({ meta: [{ title: "Branches — Dealer ERP" }] }),
  component: Branches,
});

function Branches() {
  const { t } = useT();
  const { data: me } = useMe();
  const qc = useQueryClient();
  const { data: branches = [] } = useBranches();
  const [f, setF] = useState({ name: "", code: "", brand: "", address: "", phone: "" });

  async function add() {
    const { error } = await supabase.from("branches").insert(f);
    if (error) { toast.error(error.message); return; }
    toast.success("Branch added");
    setF({ name: "", code: "", brand: "", address: "", phone: "" });
    qc.invalidateQueries({ queryKey: ["branches"] });
  }

  async function savePolicy(id: string, patch: { max_discount_pct?: number; expense_limit?: number }) {
    const { error } = await supabase.from("branches").update(patch).eq("id", id);
    if (error) { toast.error(error.message); return; }
    toast.success("Policy saved");
    qc.invalidateQueries({ queryKey: ["branches"] });
  }

  return (
    <div>
      <PageHeader title={t("Branches")} />
      {me?.canWriteHq && (
        <Card className="mb-4 flex flex-wrap gap-2 p-4">
          {(["name", "code", "brand", "address", "phone"] as const).map((k) => (
            <Input key={k} className="w-44" placeholder={k.charAt(0).toUpperCase() + k.slice(1)} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} />
          ))}
          <Button onClick={add} disabled={!f.name || !f.code}>{t("Add")}</Button>
        </Card>
      )}
      <Card>
        <Table>
          <TableHeader>
            <TableRow><TableHead>{t("Name")}</TableHead><TableHead>Code</TableHead><TableHead>Brand</TableHead><TableHead>{t("Address")}</TableHead><TableHead>{t("Phone")}</TableHead><TableHead>Max discount %</TableHead><TableHead>Expense limit ৳</TableHead></TableRow>
          </TableHeader>
          <TableBody>
            {branches.map((b) => (
              <TableRow key={b.id}>
                <TableCell className="font-medium">{b.name} {b.is_dealer_house && <Badge className="ml-1 bg-accent text-accent-foreground">Dealer house</Badge>}</TableCell>
                <TableCell className="font-mono text-xs">{b.code}</TableCell>
                <TableCell>{b.brand}</TableCell>
                <TableCell>{b.address}</TableCell>
                <TableCell>{b.phone}</TableCell>
                <TableCell><PolicyInput disabled={!me?.canWriteHq} value={b.max_discount_pct} onSave={(v) => savePolicy(b.id, { max_discount_pct: v })} /></TableCell>
                <TableCell><PolicyInput disabled={!me?.canWriteHq} value={b.expense_limit} onSave={(v) => savePolicy(b.id, { expense_limit: v })} /></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}

function PolicyInput({ value, onSave, disabled }: { value: number; onSave: (v: number) => void; disabled?: boolean }) {
  const [v, setV] = useState(String(value));
  return <Input type="number" min={0} className="w-24" disabled={disabled} value={v} onChange={(e) => setV(e.target.value)} onBlur={() => { if (Number(v) !== Number(value) && Number(v) >= 0) onSave(Number(v)); }} />;
}
