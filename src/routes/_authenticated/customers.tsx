import { createFileRoute, Link } from "@tanstack/react-router";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
  const [addBranchId, setAddBranchId] = useState("");
  const [editing, setEditing] = useState<{
    id: string;
    name: string;
    phone: string;
    nid: string;
    address: string;
  } | null>(null);
  const { data: branches = [] } = useBranches();
  const { data = [], error } = useQuery({
    queryKey: ["customers", branch],
    enabled: !!branch,
    queryFn: async () => {
      let qq = supabase
        .from("customers")
        .select("id,name,phone,nid,address,branch_id,created_at")
        .order("created_at", { ascending: false });
      if (branch !== "all") qq = qq.eq("branch_id", branch);
      return fetchAllPages(qq);
    },
  });
  const shown = data.filter(
    (c) => !q || c.name.toLowerCase().includes(q.toLowerCase()) || c.phone.includes(q),
  );
  const bname = (id: string) => branches.find((b) => b.id === id)?.name ?? "";
  const hasCustomerRole =
    !!me && me.roles.some((r) => ["branch_manager", "sales", "accountant"].includes(r));
  const canManage = (c: { branch_id: string }) =>
    !!me && (me.canWriteHq || (me.branch_id === c.branch_id && hasCustomerRole));
  const showActions = !!me && (me.canWriteHq || hasCustomerRole);
  const canAdd =
    !!me &&
    (me.canWriteHq
      ? branch !== "all" || branches.length > 0
      : !!branch && branch !== "all" && me.branch_id === branch && hasCustomerRole);
  const addBranch = branch !== "all" ? branch : addBranchId;

  async function add() {
    if (!f.name.trim()) {
      toast.error("Enter a customer name");
      return;
    }
    if (!/^01\d{9}$/.test(f.phone)) {
      toast.error("Phone must be 11 digits starting with 01");
      return;
    }
    if (!addBranch) {
      toast.error("Choose a branch");
      return;
    }
    const { error } = await supabase.from("customers").insert({
      name: f.name.trim(),
      phone: f.phone,
      nid: f.nid.trim() || null,
      address: f.address.trim() || null,
      branch_id: addBranch,
    });
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Customer added");
    setF({ name: "", phone: "", nid: "", address: "" });
    qc.invalidateQueries({ queryKey: ["customers"] });
  }

  async function saveCustomer() {
    if (!editing) return;
    if (!editing.name.trim()) {
      toast.error("Enter a customer name");
      return;
    }
    if (!/^01\d{9}$/.test(editing.phone)) {
      toast.error("Phone must be 11 digits starting with 01");
      return;
    }
    const { error } = await supabase
      .from("customers")
      .update({
        name: editing.name.trim(),
        phone: editing.phone,
        nid: editing.nid.trim() || null,
        address: editing.address.trim() || null,
      })
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
        <Card className="mb-4 flex flex-wrap items-end gap-2 p-4">
          {branch === "all" && (
            <div className="space-y-1">
              <Label className="text-xs">Branch</Label>
              <select
                className="w-48 rounded-md border bg-background px-2 py-2"
                value={addBranchId}
                onChange={(e) => setAddBranchId(e.target.value)}
              >
                <option value="">Choose…</option>
                {branches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          {(["name", "phone", "nid", "address"] as const).map((k) => (
            <div key={k} className="space-y-1">
              <Label className="text-xs">
                {k === "nid" ? "NID" : t(k.charAt(0).toUpperCase() + k.slice(1))}
              </Label>
              <Input
                className="w-48"
                placeholder={k === "nid" ? "NID" : t(k.charAt(0).toUpperCase() + k.slice(1))}
                value={f[k]}
                onChange={(e) => setF({ ...f, [k]: e.target.value })}
              />
            </div>
          ))}
          <Button onClick={add} disabled={!f.name.trim() || !f.phone || !addBranch}>
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
      {error && (
        <p
          role="alert"
          className="mb-3 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
        >
          Could not load customers: {error.message}
        </p>
      )}
      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("Name")}</TableHead>
              <TableHead>{t("Phone")}</TableHead>
              <TableHead>{t("Address")}</TableHead>
              <TableHead>{t("Branch")}</TableHead>
              {showActions && <TableHead />}
            </TableRow>
          </TableHeader>
          <TableBody>
            {shown.map((c) => (
              <TableRow key={c.id}>
                <TableCell className="font-medium">
                  <Link
                    to="/customers/$customerId"
                    params={{ customerId: c.id }}
                    className="text-primary hover:underline"
                  >
                    {c.name}
                  </Link>
                </TableCell>
                <TableCell>{c.phone}</TableCell>
                <TableCell>{c.address}</TableCell>
                <TableCell>{bname(c.branch_id)}</TableCell>
                {showActions && (
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-2">
                      <Button size="sm" variant="outline" asChild>
                        <Link to="/customers/$customerId" params={{ customerId: c.id }}>
                          View
                        </Link>
                      </Button>
                      {canManage(c) && (
                        <>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() =>
                              setEditing({
                                id: c.id,
                                name: c.name,
                                phone: c.phone,
                                nid: c.nid ?? "",
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
                        </>
                      )}
                    </div>
                  </TableCell>
                )}
              </TableRow>
            ))}
            {shown.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                  {error
                    ? "Could not load customers."
                    : data.length
                      ? "No customers match this search."
                      : "No customers yet."}
                </TableCell>
              </TableRow>
            )}
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
            <DialogDescription>Update this customer's contact details.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {(["name", "phone", "nid", "address"] as const).map((field) => (
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
