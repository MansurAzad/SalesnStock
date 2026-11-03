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
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export const Route = createFileRoute("/_authenticated/branches")({
  head: () => ({ meta: [{ title: "Branches — Dealer ERP" }] }),
  component: Branches,
});

function Branches() {
  const { t } = useT();
  const { data: me } = useMe();
  const qc = useQueryClient();
  const { data: branches = [] } = useBranches();
  const [f, setF] = useState({
    name: "",
    code: "",
    brand: "",
    address: "",
    phone: "",
    is_dealer_house: false,
  });
  const [editing, setEditing] = useState<{
    id: string;
    name: string;
    code: string;
    brand: string;
    address: string;
    phone: string;
    is_dealer_house: boolean;
  } | null>(null);

  async function add() {
    const name = f.name.trim();
    const code = f.code.trim();
    if (!name || !code) {
      toast.error("Showroom name and code are required");
      return;
    }
    const { error } = await supabase.from("branches").insert({
      name,
      code,
      brand: f.brand.trim() || null,
      address: f.address.trim() || null,
      phone: f.phone.trim() || null,
      is_dealer_house: f.is_dealer_house,
    });
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Branch added");
    setF({
      name: "",
      code: "",
      brand: "",
      address: "",
      phone: "",
      is_dealer_house: false,
    });
    qc.invalidateQueries({ queryKey: ["branches"] });
  }

  async function savePolicy(
    id: string,
    patch: { max_discount_pct?: number; expense_limit?: number },
  ) {
    const { error } = await supabase.from("branches").update(patch).eq("id", id);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Policy saved");
    qc.invalidateQueries({ queryKey: ["branches"] });
  }

  async function saveBranch() {
    if (!editing) return;
    const { error } = await supabase
      .from("branches")
      .update({
        name: editing.name.trim(),
        code: editing.code.trim(),
        brand: editing.brand.trim() || null,
        address: editing.address.trim() || null,
        phone: editing.phone.trim() || null,
        is_dealer_house: editing.is_dealer_house,
      })
      .eq("id", editing.id);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Branch updated");
    setEditing(null);
    qc.invalidateQueries({ queryKey: ["branches"] });
  }

  async function deleteBranch(id: string, name: string) {
    if (
      !window.confirm(
        `Permanently delete ${name}? Branches with assigned staff or business history cannot be deleted.`,
      )
    )
      return;
    const { error } = await supabase.from("branches").delete().eq("id", id);
    if (error) {
      toast.error(
        error.code === "23503"
          ? "This branch has assigned users or business history and cannot be deleted."
          : error.message,
      );
      return;
    }
    toast.success("Unused branch deleted");
    qc.invalidateQueries();
  }

  return (
    <div>
      <PageHeader title={t("Branches")} />
      {me?.canWriteHq && (
        <Card className="mb-4 flex flex-wrap items-center gap-2 p-4">
          {(["name", "code", "brand", "address", "phone"] as const).map((k) => (
            <Input
              key={k}
              className="w-44"
              id={`branch-new-${k}`}
              aria-label={k.charAt(0).toUpperCase() + k.slice(1)}
              placeholder={k.charAt(0).toUpperCase() + k.slice(1)}
              value={f[k]}
              onChange={(e) => setF({ ...f, [k]: e.target.value })}
            />
          ))}
          <div className="flex items-center gap-2">
            <Checkbox
              id="branch-new-dealer-house"
              checked={f.is_dealer_house}
              onCheckedChange={(c) => setF({ ...f, is_dealer_house: c === true })}
            />
            <Label htmlFor="branch-new-dealer-house" className="text-sm">
              Dealer house
            </Label>
          </div>
          <Button onClick={add} disabled={!f.name.trim() || !f.code.trim()}>
            {t("Add")}
          </Button>
        </Card>
      )}
      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("Name")}</TableHead>
              <TableHead>Code</TableHead>
              <TableHead>Brand</TableHead>
              <TableHead>{t("Address")}</TableHead>
              <TableHead>{t("Phone")}</TableHead>
              <TableHead>Max discount %</TableHead>
              <TableHead>Expense limit ৳</TableHead>
              {me?.canWriteHq && <TableHead />}
            </TableRow>
          </TableHeader>
          <TableBody>
            {branches.map((b) => (
              <TableRow key={b.id}>
                <TableCell className="font-medium">
                  {b.name}{" "}
                  {b.is_dealer_house && (
                    <Badge className="ml-1 bg-accent text-accent-foreground">Dealer house</Badge>
                  )}
                </TableCell>
                <TableCell className="font-mono text-xs">{b.code}</TableCell>
                <TableCell>{b.brand}</TableCell>
                <TableCell>{b.address}</TableCell>
                <TableCell>{b.phone}</TableCell>
                <TableCell>
                  <PolicyInput
                    disabled={!me?.canWriteHq}
                    max={100}
                    value={b.max_discount_pct}
                    onSave={(v) => savePolicy(b.id, { max_discount_pct: v })}
                  />
                </TableCell>
                <TableCell>
                  <PolicyInput
                    disabled={!me?.canWriteHq}
                    value={b.expense_limit}
                    onSave={(v) => savePolicy(b.id, { expense_limit: v })}
                  />
                </TableCell>
                {me?.canWriteHq && (
                  <TableCell>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          setEditing({
                            id: b.id,
                            name: b.name,
                            code: b.code,
                            brand: b.brand ?? "",
                            address: b.address ?? "",
                            phone: b.phone ?? "",
                            is_dealer_house: b.is_dealer_house,
                          })
                        }
                      >
                        Edit
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-destructive"
                        onClick={() => deleteBranch(b.id, b.name)}
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
            <DialogTitle>Edit branch</DialogTitle>
            <DialogDescription>
              Rename the showroom or update its contact details.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {(["name", "code", "brand", "address", "phone"] as const).map((field) => (
              <div key={field} className="space-y-1">
                <Label className="capitalize" htmlFor={`branch-edit-${field}`}>
                  {field}
                </Label>
                <Input
                  id={`branch-edit-${field}`}
                  value={editing?.[field] ?? ""}
                  onChange={(e) =>
                    setEditing((current) =>
                      current ? { ...current, [field]: e.target.value } : current,
                    )
                  }
                />
              </div>
            ))}
            <div className="flex items-center gap-2">
              <Checkbox
                id="branch-edit-dealer-house"
                checked={editing?.is_dealer_house ?? false}
                onCheckedChange={(c) =>
                  setEditing((current) =>
                    current ? { ...current, is_dealer_house: c === true } : current,
                  )
                }
              />
              <Label htmlFor="branch-edit-dealer-house">Dealer house</Label>
            </div>
            <Button
              className="w-full"
              disabled={!editing?.name.trim() || !editing.code.trim()}
              onClick={saveBranch}
            >
              Save changes
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function PolicyInput({
  value,
  onSave,
  disabled,
  max,
}: {
  value: number;
  onSave: (v: number) => void;
  disabled?: boolean;
  max?: number;
}) {
  const [v, setV] = useState(String(value));
  return (
    <Input
      type="number"
      min={0}
      max={max}
      className="w-24"
      disabled={disabled}
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => {
        const n = Number(v);
        if (Number.isNaN(n) || n < 0 || (max != null && n > max)) {
          setV(String(value));
          return;
        }
        if (n !== Number(value)) onSave(n);
      }}
    />
  );
}
