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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { fetchAllPages } from "@/lib/paginated-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";

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
  const [editing, setEditing] = useState<{
    id: string;
    name: string;
    phone: string;
    address: string;
  } | null>(null);
  const { data: branches = [] } = useBranches();
  const { data = [] } = useQuery({
    queryKey: ["customers", branch],
    enabled: !!branch,
    queryFn: async () => {
      let qq = supabase
        .from("customers")
        .select("id,name,phone,address,branch_id,created_at")
        .order("created_at", { ascending: false });
      if (branch !== "all") qq = qq.eq("branch_id", branch);
      return fetchAllPages(qq);
    },
  });
  const shown = data.filter(
    (c) => !q || c.name.toLowerCase().includes(q.toLowerCase()) || c.phone.includes(q),
  );
  const bname = (id: string) => branches.find((b) => b.id === id)?.name ?? "";
  const canAdd =
    !!me &&
    !!branch &&
    branch !== "all" &&
    (me.canWriteHq ||
      (me.branch_id === branch &&
        me.roles.some((r) => ["branch_manager", "sales", "accountant"].includes(r))));

  async function add() {
    if (!/^01\d{9}$/.test(f.phone)) {
      toast.error("Phone must be 11 digits starting with 01");
      return;
    }
    const { error } = await supabase.from("customers").insert({ ...f, branch_id: branch });
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Customer added");
    setF({ name: "", phone: "", nid: "", address: "" });
    qc.invalidateQueries({ queryKey: ["customers"] });
  }

  async function saveCustomer() {
    if (!editing || !/^01\d{9}$/.test(editing.phone)) {
      toast.error("Phone must be 11 digits starting with 01");
      return;
    }
    const { error } = await supabase
      .from("customers")
      .update({ name: editing.name.trim(), phone: editing.phone, address: editing.address || null })
      .eq("id", editing.id);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Customer updated");
    setEditing(null);
    qc.invalidateQueries({ queryKey: ["customers"] });
  }

  async function deleteCustomer(customer: (typeof data)[number]) {
    if (
      !window.confirm(
        `Delete ${customer.name}? Customers with sales or installment history cannot be deleted.`,
      )
    )
      return;
    const { error } = await supabase.from("customers").delete().eq("id", customer.id);
    if (error) {
      toast.error(
        error.code === "23503"
          ? "This customer has transaction history. Edit the record instead."
          : error.message,
      );
      return;
    }
    toast.success("Customer deleted");
    qc.invalidateQueries({ queryKey: ["customers"] });
  }

  return (
    <div>
      <PageHeader title={t("Customers")}>
        <BranchPicker value={branch} onChange={setBranch} allowAll />
      </PageHeader>
      {canAdd && (
        <Card className="mb-4 flex flex-wrap gap-2 p-4">
          {(["name", "phone", "nid", "address"] as const).map((k) => (
            <Input
              key={k}
              className="w-48"
              placeholder={k === "nid" ? "NID" : t(k.charAt(0).toUpperCase() + k.slice(1))}
              value={f[k]}
              onChange={(e) => setF({ ...f, [k]: e.target.value })}
            />
          ))}
          <Button onClick={add} disabled={!f.name || !f.phone}>
            {t("Add")}
          </Button>
        </Card>
      )}
      <Input
        placeholder={t("Search")}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        className="mb-3 max-w-xs bg-card"
      />
      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("Name")}</TableHead>
              <TableHead>{t("Phone")}</TableHead>
              <TableHead>{t("Address")}</TableHead>
              <TableHead>{t("Branch")}</TableHead>
              {canAdd && <TableHead />}
            </TableRow>
          </TableHeader>
          <TableBody>
            {shown.map((c) => (
              <TableRow key={c.id}>
                <TableCell className="font-medium">{c.name}</TableCell>
                <TableCell>{c.phone}</TableCell>
                <TableCell>{c.address}</TableCell>
                <TableCell>{bname(c.branch_id)}</TableCell>
                {canAdd && (
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          setEditing({
                            id: c.id,
                            name: c.name,
                            phone: c.phone,
                            address: c.address ?? "",
                          })
                        }
                      >
                        Edit
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-destructive"
                        onClick={() => deleteCustomer(c)}
                      >
                        Delete
                      </Button>
                    </div>
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
      <Dialog
        open={!!editing}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit customer</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            {(["name", "phone", "address"] as const).map((field) => (
              <div key={field} className="space-y-1">
                <Label className="capitalize">{field}</Label>
                <Input
                  value={editing?.[field] ?? ""}
                  onChange={(e) =>
                    setEditing((current) =>
                      current ? { ...current, [field]: e.target.value } : current,
                    )
                  }
                />
              </div>
            ))}
            <Button
              className="w-full"
              disabled={!editing?.name.trim() || !editing.phone}
              onClick={saveCustomer}
            >
              Save changes
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
