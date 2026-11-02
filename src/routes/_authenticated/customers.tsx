import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { BranchPicker, PageHeader } from "@/components/BranchPicker";
import { useBranches, useMe } from "@/lib/erp";
import { useT } from "@/lib/i18n";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { fetchAllPages } from "@/lib/paginated-query";

export const Route = createFileRoute("/_authenticated/customers")({
  head: () => ({ meta: [{ title: "Customers — Dealer ERP" }] }),
  component: Customers,
});

function Customers() {
  const { t } = useT();
  const { data: me } = useMe();
  const qc = useQueryClient();
  const [branch, setBranch] = useState("");
  const [q, setQ] = useState("");
  const [f, setF] = useState({ name: "", phone: "", nid: "", address: "" });
  const { data: branches = [] } = useBranches();
  const { data = [] } = useQuery({
    queryKey: ["customers", branch],
    enabled: !!branch,
    queryFn: async () => {
      let qq = supabase.from("customers").select("id,name,phone,address,branch_id,created_at").order("created_at", { ascending: false });
      if (branch !== "all") qq = qq.eq("branch_id", branch);
      return fetchAllPages(qq);
    },
  });
  const shown = data.filter((c) => !q || c.name.toLowerCase().includes(q.toLowerCase()) || c.phone.includes(q));
  const bname = (id: string) => branches.find((b) => b.id === id)?.name ?? "";
  const canAdd = branch && branch !== "all" && !me?.roles.every((r) => r === "auditor");

  async function add() {
    if (!/^01\d{9}$/.test(f.phone)) { toast.error("Phone must be 11 digits starting with 01"); return; }
    const { error } = await supabase.from("customers").insert({ ...f, branch_id: branch });
    if (error) { toast.error(error.message); return; }
    toast.success("Customer added");
    setF({ name: "", phone: "", nid: "", address: "" });
    qc.invalidateQueries({ queryKey: ["customers"] });
  }

  return (
    <div>
      <PageHeader title={t("Customers")}><BranchPicker value={branch} onChange={setBranch} allowAll /></PageHeader>
      {canAdd && (
        <Card className="mb-4 flex flex-wrap gap-2 p-4">
          {(["name", "phone", "nid", "address"] as const).map((k) => (
            <Input key={k} className="w-48" placeholder={k === "nid" ? "NID" : t(k.charAt(0).toUpperCase() + k.slice(1))} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} />
          ))}
          <Button onClick={add} disabled={!f.name || !f.phone}>{t("Add")}</Button>
        </Card>
      )}
      <Input placeholder={t("Search")} value={q} onChange={(e) => setQ(e.target.value)} className="mb-3 max-w-xs bg-card" />
      <Card>
        <Table>
          <TableHeader>
            <TableRow><TableHead>{t("Name")}</TableHead><TableHead>{t("Phone")}</TableHead><TableHead>{t("Address")}</TableHead><TableHead>{t("Branch")}</TableHead></TableRow>
          </TableHeader>
          <TableBody>
            {shown.map((c) => (
              <TableRow key={c.id}>
                <TableCell className="font-medium">{c.name}</TableCell><TableCell>{c.phone}</TableCell>
                <TableCell>{c.address}</TableCell><TableCell>{bname(c.branch_id)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}
