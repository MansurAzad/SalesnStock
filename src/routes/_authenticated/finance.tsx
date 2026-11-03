import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { fetchAllPages } from "@/lib/paginated-query";

export const Route = createFileRoute("/_authenticated/finance")({
  head: () => ({
    meta: [
      { title: "Finance partners — Dealer ERP" },
      { name: "description", content: "Third-party finance sales and settlements." },
    ],
  }),
  component: Finance,
});

function usePartners() {
  return useQuery({
    queryKey: ["partners"],
    queryFn: async () => fetchAllPages(supabase.from("finance_partners").select("*").order("name")),
  });
}

type FinanceCaseRecord = {
  id: string;
  branch_id: string;
  partner_id: string;
  customer_name: string;
  customer_phone: string | null;
  ref_no: string | null;
  amount: number;
  commission: number;
  note: string | null;
  status: string;
  sale_id: string | null;
  created_by: string | null;
};

function Finance() {
  const { t } = useT();
  const { data: me } = useMe();
  const [branch, setBranch] = useState("");
  const [status, setStatus] = useState("pending");
  const { data: branches = [] } = useBranches();
  const { data: partners = [] } = usePartners();
  const [editingCase, setEditingCase] = useState<FinanceCaseRecord | null>(null);
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
  // The receivable must not change when the list filter changes, so it is
  // counted from every pending case, not from the filtered list.
  const { data: receivable = [] } = useQuery({
    queryKey: ["finance-cases", branch, "receivable"],
    enabled: !!branch,
    queryFn: async () => {
      let q = supabase
        .from("finance_cases")
        .select("amount")
        .eq("status", "pending")
        .order("created_at", { ascending: false });
      if (branch !== "all") q = q.eq("branch_id", branch);
      return fetchAllPages(q);
    },
  });
  const pendingTotal = receivable.reduce((a, c) => a + Number(c.amount), 0);

  async function settle(id: string, amount: number, pct: number) {
    const v = prompt(
      "Amount received from partner (৳)",
      String(Math.round(amount * (1 - pct / 100))),
    );
    if (v === null) return;
    const received = Number(v);
    if (!Number.isFinite(received) || received <= 0) {
      toast.error("Enter an amount greater than zero");
      return;
    }
    const { error } = await supabase.rpc("settle_finance", { _case: id, _received: received });
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Settled and added to accounts");
    qc.invalidateQueries();
  }
  const canOperateCase = (c: FinanceCaseRecord) =>
    !!me &&
    (me.canWriteHq ||
      (me.branch_id === c.branch_id &&
        me.roles.some((r) => ["branch_manager", "sales", "accountant"].includes(r))));
  const canCorrectCase = (c: FinanceCaseRecord) =>
    !!me &&
    (me.canWriteHq ||
      (me.branch_id === c.branch_id &&
        (me.roles.includes("branch_manager") || c.created_by === me.id)));
  async function cancelCase(id: string) {
    const reason = window.prompt("Why is this pending finance case being cancelled?");
    if (!reason?.trim()) return;
    const { error } = await supabase.rpc("cancel_pending_finance_case", {
      _case: id,
      _reason: reason.trim(),
    });
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Pending finance case cancelled");
    qc.invalidateQueries({ queryKey: ["finance-cases"] });
  }

  return (
    <div>
      <PageHeader title={t("Finance")}>
        <BranchPicker value={branch} onChange={setBranch} allowAll />
        <NewCase partners={partners} />
      </PageHeader>
      <Tabs defaultValue="cases">
        <TabsList>
          <TabsTrigger value="cases">Finance sales</TabsTrigger>
          <TabsTrigger value="partners">Partners</TabsTrigger>
        </TabsList>
        <TabsContent value="cases">
          <div className="mb-3 flex items-center gap-2">
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger className="w-40 bg-card">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {["pending", "settled", "cancelled", "any"].map((s) => (
                  <SelectItem key={s} value={s} className="capitalize">
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="ml-auto text-sm">
              Receivable from partners: <b className="tabular">{taka(pendingTotal)}</b>
            </div>
          </div>
          <Card>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("Date")}</TableHead>
                  <TableHead>{t("Branch")}</TableHead>
                  <TableHead>Partner</TableHead>
                  <TableHead>Ref</TableHead>
                  <TableHead>{t("Customer")}</TableHead>
                  <TableHead>Invoice</TableHead>
                  <TableHead className="text-right">{t("Amount")}</TableHead>
                  <TableHead className="text-right">Received</TableHead>
                  <TableHead>Partner fee</TableHead>
                  <TableHead>{t("Status")}</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {cases.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell className="text-xs">
                      {new Date(c.created_at).toLocaleDateString()}
                    </TableCell>
                    <TableCell>{bname(c.branch_id)}</TableCell>
                    <TableCell>{pname(c.partner_id)}</TableCell>
                    <TableCell className="font-mono text-xs">{c.ref_no}</TableCell>
                    <TableCell>
                      {c.customer_name}{" "}
                      <span className="text-xs text-muted-foreground">{c.customer_phone}</span>
                    </TableCell>
                    <TableCell>
                      {c.sale_id ? (
                        <Link
                          to="/receipt/$saleId"
                          params={{ saleId: c.sale_id }}
                          className="text-sm text-primary hover:underline"
                        >
                          View invoice
                        </Link>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular">{taka(c.amount)}</TableCell>
                    <TableCell className="text-right tabular">
                      {c.status === "settled" ? taka(Number(c.amount) - Number(c.commission)) : "—"}
                    </TableCell>
                    <TableCell className="tabular">
                      {partners.find((p) => p.id === c.partner_id)?.commission_pct != null
                        ? `${partners.find((p) => p.id === c.partner_id)?.commission_pct}%`
                        : "—"}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="capitalize">
                        {c.status}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-1">
                        {c.status === "pending" && canCorrectCase(c) && (
                          <>
                            <Button size="sm" variant="outline" onClick={() => setEditingCase(c)}>
                              Edit
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="text-destructive"
                              onClick={() => cancelCase(c.id)}
                            >
                              Cancel
                            </Button>
                          </>
                        )}
                        {c.status === "pending" && canOperateCase(c) && (
                          <Button
                            size="sm"
                            onClick={() =>
                              settle(
                                c.id,
                                Number(c.amount),
                                Number(
                                  partners.find((p) => p.id === c.partner_id)?.commission_pct ?? 0,
                                ),
                              )
                            }
                          >
                            Settle
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
                {!cases.length && (
                  <TableRow>
                    <TableCell colSpan={10} className="py-8 text-center text-muted-foreground">
                      No finance sales.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </Card>
        </TabsContent>
        <TabsContent value="partners">
          <Partners canEdit={!!me?.canWriteHq} />
        </TabsContent>
      </Tabs>
      <EditFinanceCaseDialog
        financeCase={editingCase}
        partners={partners}
        onClose={() => setEditingCase(null)}
      />
    </div>
  );
}

function EditFinanceCaseDialog({
  financeCase,
  partners,
  onClose,
}: {
  financeCase: FinanceCaseRecord | null;
  partners: { id: string; name: string; active: boolean }[];
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [f, setF] = useState({
    partner_id: "",
    customer_name: "",
    customer_phone: "",
    ref_no: "",
    amount: "",
    note: "",
  });
  useEffect(() => {
    if (financeCase)
      setF({
        partner_id: financeCase.partner_id,
        customer_name: financeCase.customer_name,
        customer_phone: financeCase.customer_phone ?? "",
        ref_no: financeCase.ref_no ?? "",
        amount: String(financeCase.amount),
        note: financeCase.note ?? "",
      });
  }, [financeCase]);
  async function save() {
    if (!financeCase) return;
    const amount = Number(f.amount);
    if (!f.partner_id || !f.customer_name.trim() || !Number.isFinite(amount) || amount <= 0) {
      toast.error("Partner, customer, and positive amount are required");
      return;
    }
    const { error } = await supabase.rpc("update_pending_finance_case", {
      _case: financeCase.id,
      _partner: f.partner_id,
      _customer_name: f.customer_name.trim(),
      _customer_phone: f.customer_phone || null,
      _ref_no: f.ref_no || null,
      _amount: amount,
      _note: f.note || null,
    });
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Pending finance case updated");
    onClose();
    qc.invalidateQueries({ queryKey: ["finance-cases"] });
  }
  return (
    <Dialog
      open={!!financeCase}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit pending finance case</DialogTitle>
          <DialogDescription>
            Only pending cases can be edited. Settled cases are locked.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Select value={f.partner_id} onValueChange={(partner_id) => setF({ ...f, partner_id })}>
            <SelectTrigger>
              <SelectValue placeholder="Finance partner" />
            </SelectTrigger>
            <SelectContent>
              {partners
                .filter((p) => p.active)
                .map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
          {(["customer_name", "customer_phone", "ref_no", "amount", "note"] as const).map(
            (field) => (
              <div key={field} className="space-y-1">
                <Label className="capitalize">{field.replace("_", " ")}</Label>
                <Input
                  type={field === "amount" ? "number" : "text"}
                  min={field === "amount" ? "0.01" : undefined}
                  value={f[field]}
                  onChange={(e) => setF({ ...f, [field]: e.target.value })}
                />
              </div>
            ),
          )}
          <Button
            className="w-full"
            disabled={!f.partner_id || !f.customer_name.trim() || !(Number(f.amount) > 0)}
            onClick={save}
          >
            Save changes
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function NewCase({ partners }: { partners: { id: string; name: string; active: boolean }[] }) {
  const { data: me } = useMe();
  const { data: branches = [] } = useBranches();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({
    branch_id: "",
    partner_id: "",
    customer_name: "",
    customer_phone: "",
    ref_no: "",
    amount: "",
    note: "",
    sale_id: "",
  });
  const branchOptions = me?.isHq ? branches : branches.filter((b) => b.id === me?.branch_id);
  const canCreate =
    !!me &&
    (me.canWriteHq ||
      (!!me.branch_id &&
        me.roles.some((r) => ["branch_manager", "sales", "accountant"].includes(r))));
  // The invoice this case belongs to — so the partner case and the POS sale
  // are never two unlinked records.
  const { data: sales = [] } = useQuery({
    queryKey: ["finance-sale-picker", f.branch_id || me?.branch_id || ""],
    enabled: open && !!(f.branch_id || me?.branch_id),
    queryFn: async () => {
      const branchId = f.branch_id || me?.branch_id || "";
      let q = supabase
        .from("sales")
        .select("id, invoice_no, total, created_at")
        .order("created_at", { ascending: false })
        .limit(50);
      if (branchId && branchId !== "all") q = q.eq("branch_id", branchId);
      const { data } = await q;
      return data ?? [];
    },
  });
  async function save() {
    const amount = Number(f.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      toast.error("Enter an amount greater than zero");
      return;
    }
    if (!f.partner_id || !f.customer_name.trim()) {
      toast.error("Partner and customer name are required");
      return;
    }
    const branchId = f.branch_id || me?.branch_id || "";
    if (!branchId) {
      toast.error("Select a branch");
      return;
    }
    const { error } = await supabase.rpc("create_finance_case", {
      _branch: branchId,
      _partner: f.partner_id,
      _customer: f.customer_name.trim(),
      _phone: f.customer_phone.trim(),
      _ref: f.ref_no.trim(),
      _amount: amount,
      _note: f.note.trim(),
      _sale: f.sale_id || null,
    });
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Finance sale recorded");
    setOpen(false);
    setF({
      branch_id: "",
      partner_id: "",
      customer_name: "",
      customer_phone: "",
      ref_no: "",
      amount: "",
      note: "",
      sale_id: "",
    });
    qc.invalidateQueries({ queryKey: ["finance-cases"] });
  }
  if (!canCreate) return null;
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>New finance sale</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Record finance sale</DialogTitle>
          <DialogDescription>
            Record a dealer finance sale. It becomes a pending case until settled.
          </DialogDescription>
        </DialogHeader>
        <p className="text-xs text-muted-foreground">
          Sell the phone in POS first (cash, method "bank"), then record the amount the finance
          partner will pay you here.
        </p>
        <div className="space-y-2">
          <Select value={f.branch_id} onValueChange={(v) => setF({ ...f, branch_id: v })}>
            <SelectTrigger>
              <SelectValue placeholder="Branch" />
            </SelectTrigger>
            <SelectContent>
              {branchOptions.map((b) => (
                <SelectItem key={b.id} value={b.id}>
                  {b.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={f.partner_id} onValueChange={(v) => setF({ ...f, partner_id: v })}>
            <SelectTrigger>
              <SelectValue placeholder="Finance partner" />
            </SelectTrigger>
            <SelectContent>
              {partners
                .filter((p) => p.active)
                .map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
          <div>
            <Label className="text-xs">POS invoice</Label>
            <Select
              value={f.sale_id}
              onValueChange={(v) => {
                const s = sales.find((x) => x.id === v);
                setF({
                  ...f,
                  sale_id: v,
                  // Pull the amount across so it does not have to be typed twice.
                  amount: s ? String(s.total) : f.amount,
                });
              }}
            >
              <SelectTrigger>
                <SelectValue placeholder="Link an invoice (optional)" />
              </SelectTrigger>
              <SelectContent>
                {sales.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.invoice_no} — {taka(s.total)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {(["customer_name", "customer_phone", "ref_no", "amount", "note"] as const).map((k) => (
            <div key={k}>
              <Label className="text-xs capitalize">{k.replace("_", " ")}</Label>
              <Input
                type={k === "amount" ? "number" : "text"}
                min={k === "amount" ? "0.01" : undefined}
                value={f[k]}
                onChange={(e) => setF({ ...f, [k]: e.target.value })}
              />
            </div>
          ))}
          <Button
            className="w-full"
            disabled={
              !f.partner_id ||
              !(f.branch_id || me?.branch_id) ||
              !f.customer_name.trim() ||
              !(Number(f.amount) > 0)
            }
            onClick={save}
          >
            Save
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Partners({ canEdit }: { canEdit: boolean }) {
  const { data: partners = [] } = usePartners();
  const qc = useQueryClient();
  const [f, setF] = useState({ name: "", contact: "", commission_pct: "" });
  const [editing, setEditing] = useState<{
    id: string;
    name: string;
    contact: string;
    commission_pct: string;
  } | null>(null);
  async function add() {
    if (Number(f.commission_pct || 0) < 0 || Number(f.commission_pct || 0) > 100) {
      toast.error("Commission must be between 0 and 100%");
      return;
    }
    const { error } = await supabase
      .from("finance_partners")
      .insert({ ...f, commission_pct: Number(f.commission_pct || 0) });
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Partner added");
    setF({ name: "", contact: "", commission_pct: "" });
    qc.invalidateQueries({ queryKey: ["partners"] });
  }
  async function toggle(id: string, active: boolean) {
    const { error } = await supabase.from("finance_partners").update({ active }).eq("id", id);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success(active ? "Partner activated" : "Partner deactivated");
    qc.invalidateQueries({ queryKey: ["partners"] });
  }
  async function savePartner() {
    if (!editing) return;
    const commission = Number(editing.commission_pct);
    if (
      !editing.name.trim() ||
      !Number.isFinite(commission) ||
      commission < 0 ||
      commission > 100
    ) {
      toast.error("Enter a name and a commission from 0 to 100%");
      return;
    }
    const { error } = await supabase
      .from("finance_partners")
      .update({
        name: editing.name.trim(),
        contact: editing.contact || null,
        commission_pct: commission,
      })
      .eq("id", editing.id);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Partner updated");
    setEditing(null);
    qc.invalidateQueries({ queryKey: ["partners"] });
  }
  async function deletePartner(partner: (typeof partners)[number]) {
    if (!window.confirm(`Delete ${partner.name}? Partners with finance cases cannot be deleted.`))
      return;
    const { error } = await supabase.from("finance_partners").delete().eq("id", partner.id);
    if (error) {
      toast.error(
        error.code === "23503"
          ? "This partner has finance history and cannot be deleted."
          : error.message,
      );
      return;
    }
    toast.success("Partner deleted");
    qc.invalidateQueries({ queryKey: ["partners"] });
  }
  return (
    <div className="space-y-3">
      {canEdit && (
        <Card className="flex flex-wrap items-end gap-2 p-4">
          <div>
            <Label className="text-xs">Name</Label>
            <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          </div>
          <div>
            <Label className="text-xs">Contact</Label>
            <Input value={f.contact} onChange={(e) => setF({ ...f, contact: e.target.value })} />
          </div>
          <div>
            <Label className="text-xs">Commission %</Label>
            <Input
              type="number"
              className="w-28"
              value={f.commission_pct}
              onChange={(e) => setF({ ...f, commission_pct: e.target.value })}
            />
          </div>
          <Button disabled={!f.name} onClick={add}>
            Add partner
          </Button>
        </Card>
      )}
      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Contact</TableHead>
              <TableHead className="text-right">Commission</TableHead>
              <TableHead>Status</TableHead>
              {canEdit && <TableHead />}
            </TableRow>
          </TableHeader>
          <TableBody>
            {partners.map((p) => (
              <TableRow key={p.id}>
                <TableCell>{p.name}</TableCell>
                <TableCell>{p.contact}</TableCell>
                <TableCell className="text-right">{Number(p.commission_pct)}%</TableCell>
                <TableCell>
                  {canEdit ? (
                    <Button size="sm" variant="ghost" onClick={() => toggle(p.id, !p.active)}>
                      {p.active ? "Active" : "Inactive"}
                    </Button>
                  ) : p.active ? (
                    "Active"
                  ) : (
                    "Inactive"
                  )}
                </TableCell>
                {canEdit && (
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          setEditing({
                            id: p.id,
                            name: p.name,
                            contact: p.contact ?? "",
                            commission_pct: String(p.commission_pct),
                          })
                        }
                      >
                        Edit
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-destructive"
                        onClick={() => deletePartner(p)}
                      >
                        Delete
                      </Button>
                    </div>
                  </TableCell>
                )}
              </TableRow>
            ))}
            {!partners.length && (
              <TableRow>
                <TableCell colSpan={4} className="py-8 text-center text-muted-foreground">
                  No partners yet.
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
            <DialogTitle>Edit finance partner</DialogTitle>
            <DialogDescription>Update this partner's name and commission.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label>Name</Label>
              <Input
                value={editing?.name ?? ""}
                onChange={(e) =>
                  setEditing((current) =>
                    current ? { ...current, name: e.target.value } : current,
                  )
                }
              />
            </div>
            <div className="space-y-1">
              <Label>Contact</Label>
              <Input
                value={editing?.contact ?? ""}
                onChange={(e) =>
                  setEditing((current) =>
                    current ? { ...current, contact: e.target.value } : current,
                  )
                }
              />
            </div>
            <div className="space-y-1">
              <Label>Commission %</Label>
              <Input
                type="number"
                min="0"
                max="100"
                step="0.01"
                value={editing?.commission_pct ?? ""}
                onChange={(e) =>
                  setEditing((current) =>
                    current ? { ...current, commission_pct: e.target.value } : current,
                  )
                }
              />
            </div>
            <Button className="w-full" disabled={!editing?.name.trim()} onClick={savePartner}>
              Save changes
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
