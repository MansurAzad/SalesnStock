import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment, useState, type KeyboardEvent } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { PageHeader } from "@/components/BranchPicker";
import { productLabel, useBranches, useMe } from "@/lib/erp";
import { useT } from "@/lib/i18n";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScanButton } from "@/components/BarcodeScanner";
import { Checkbox } from "@/components/ui/checkbox";
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
import { fetchAllPages } from "@/lib/paginated-query";
import { matchesImei } from "@/lib/imei";

export const Route = createFileRoute("/_authenticated/transfers")({
  head: () => ({ meta: [{ title: "Stock transfers — Dealer ERP" }] }),
  component: Transfers,
});

function Transfers() {
  const { t } = useT();
  const { data: me } = useMe();
  const qc = useQueryClient();
  const { data: branches = [] } = useBranches();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("any");
  const bname = (id: string) => branches.find((b) => b.id === id)?.name ?? "";
  const { data: list = [] } = useQuery({
    queryKey: ["transfers"],
    queryFn: async () => {
      return fetchAllPages(
        supabase
          .from("stock_transfers")
          .select(
            "*, transfer_items(id, item_id, inventory_items(imei, imei2, products(brand, model)))",
          )
          .order("created_at", { ascending: false }),
      );
    },
  });

  async function receive(id: string) {
    const { error } = await supabase.rpc("receive_transfer", { _transfer: id });
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Stock received");
    qc.invalidateQueries({ queryKey: ["transfers"] });
    qc.invalidateQueries({ queryKey: ["inventory"] });
  }

  async function cancel(id: string) {
    const reason = window.prompt("Why is this transfer being cancelled?");
    if (!reason?.trim()) return;
    const { error } = await supabase.rpc("cancel_transfer", {
      _transfer: id,
      _reason: reason.trim(),
    });
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Transfer cancelled and stock returned to the source branch");
    qc.invalidateQueries({ queryKey: ["transfers"] });
    qc.invalidateQueries({ queryKey: ["inventory"] });
  }

  // The database lets an HQ admin, or a branch manager / sales / accountant of
  // that branch, receive the stock.
  const canReceive = (to: string) =>
    !!me &&
    (me.canWriteHq ||
      (me.branch_id === to &&
        me.roles.some((r) => ["branch_manager", "sales", "accountant"].includes(r))));
  const canCancel = (from: string) =>
    !!me && (me.canWriteHq || (me.branch_id === from && me.roles.includes("branch_manager")));
  const shown = list.filter(
    (tr) =>
      (!search ||
        `${tr.transfer_no} ${bname(tr.from_branch_id)} ${bname(tr.to_branch_id)}`
          .toLowerCase()
          .includes(search.toLowerCase())) &&
      (statusFilter === "any" || tr.status === statusFilter),
  );

  return (
    <div>
      <PageHeader title={t("Transfers")}>
        <NewTransfer />
      </PageHeader>
      <div className="mb-3 flex flex-wrap gap-2">
        <Input
          className="max-w-sm bg-card"
          placeholder="Search transfer number or branch"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-40 bg-card">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="any">All statuses</SelectItem>
            <SelectItem value="in_transit">In transit</SelectItem>
            <SelectItem value="received">Received</SelectItem>
            <SelectItem value="cancelled">Cancelled</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>No.</TableHead>
              <TableHead>From</TableHead>
              <TableHead>To</TableHead>
              <TableHead>Qty</TableHead>
              <TableHead>{t("Date")}</TableHead>
              <TableHead>{t("Status")}</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {shown.map((tr) => {
              const items = tr.transfer_items.map((ti) => ti.inventory_items).filter((i) => !!i);
              return (
                <Fragment key={tr.id}>
                  <TableRow>
                    <TableCell className="font-mono text-xs">{tr.transfer_no}</TableCell>
                    <TableCell>{bname(tr.from_branch_id)}</TableCell>
                    <TableCell>{bname(tr.to_branch_id)}</TableCell>
                    <TableCell>{tr.transfer_items.length}</TableCell>
                    <TableCell>{new Date(tr.created_at).toLocaleDateString()}</TableCell>
                    <TableCell>
                      <Badge
                        variant="outline"
                        className={
                          tr.status === "received" ? "bg-success/15 text-success" : "bg-warning/20"
                        }
                      >
                        {tr.status.replace("_", " ")}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      {tr.status === "in_transit" && canReceive(tr.to_branch_id) && (
                        <Button size="sm" onClick={() => receive(tr.id)}>
                          {t("Receive")}
                        </Button>
                      )}
                      {tr.status === "in_transit" && canCancel(tr.from_branch_id) && (
                        <Button size="sm" variant="outline" onClick={() => cancel(tr.id)}>
                          Cancel
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                  {(items.length > 0 || tr.note) && (
                    <TableRow className="bg-muted/40">
                      <TableCell colSpan={7} className="py-2 text-xs">
                        {items.length > 0 && (
                          <div>
                            <span className="text-muted-foreground">Items: </span>
                            {items.map((i, idx) => (
                              <span key={i.imei}>
                                {idx > 0 && ", "}
                                <span className="font-mono">{i.imei}</span>
                                {i.imei2 ? ` / ${i.imei2}` : ""}
                                {i.products ? ` (${i.products.brand} ${i.products.model})` : ""}
                              </span>
                            ))}
                          </div>
                        )}
                        {tr.note && <div className="text-muted-foreground">Note: {tr.note}</div>}
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              );
            })}
            {shown.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="py-8 text-center text-muted-foreground">
                  {list.length ? "No transfers match these filters." : "No transfers yet."}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}

function NewTransfer() {
  const { t } = useT();
  const qc = useQueryClient();
  const { data: me } = useMe();
  const { data: branches = [] } = useBranches();
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [note, setNote] = useState("");
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const fromOptions = me?.canWriteHq ? branches : branches.filter((b) => b.id === me?.branch_id);

  const { data: items = [] } = useQuery({
    queryKey: ["inventory", from, "in_stock", "transfer"],
    enabled: !!from,
    queryFn: async () => {
      return fetchAllPages(
        supabase
          .from("inventory_items")
          .select("id,imei,imei2,products(brand,model,variant)")
          .eq("branch_id", from)
          .eq("status", "in_stock"),
      );
    },
  });
  const shown = items.filter(
    (i) =>
      !q ||
      i.imei.includes(q) ||
      (i.imei2 ?? "").includes(q) ||
      productLabel(i.products).toLowerCase().includes(q.toLowerCase()),
  );

  const findByCode = (code: string) => {
    const c = code.trim();
    return items.find((i) => matchesImei(i.imei, c) || matchesImei(i.imei2, c));
  };
  function pick(code: string) {
    const hit = findByCode(code);
    if (hit) {
      setSel((s) => new Set(s).add(hit.id));
      setQ("");
      toast.success(hit.imei);
    } else toast.error("IMEI not in stock at this branch");
  }
  function onScan(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key !== "Enter") return;
    const hit = findByCode(q);
    if (hit) {
      setSel((s) => new Set(s).add(hit.id));
      setQ("");
    } else toast.error("IMEI not in stock at this branch");
  }

  async function submit() {
    if (busy) return;
    setBusy(true);
    try {
      const { error } = await supabase.rpc("create_transfer", {
        _from: from,
        _to: to,
        _item_ids: [...sel],
        _note: note.trim(),
      });
      if (error) {
        toast.error(error.message);
        return;
      }
      toast.success(`${sel.size} items sent`);
      setSel(new Set());
      setQ("");
      setNote("");
      setFrom("");
      setTo("");
      setOpen(false);
      qc.invalidateQueries({ queryKey: ["transfers"] });
      qc.invalidateQueries({ queryKey: ["inventory"] });
    } finally {
      setBusy(false);
    }
  }

  // An auditor only reads; everyone else the database lets move stock may send it.
  if (!me || me.roles.every((r) => r === "auditor")) return null;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>{t("New transfer")}</Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("New transfer")}</DialogTitle>
          <DialogDescription>
            Pick the source and destination showroom, then scan the IMEIs to send.
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-2">
          <Select
            value={from}
            onValueChange={(v) => {
              setFrom(v);
              // The destination must differ from the source — clear it so the
              // database never rejects the transfer with "must differ".
              setTo("");
              setSel(new Set());
            }}
          >
            <SelectTrigger aria-label="Source branch">
              <SelectValue placeholder="From" />
            </SelectTrigger>
            <SelectContent>
              {fromOptions.map((b) => (
                <SelectItem key={b.id} value={b.id}>
                  {b.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={to} onValueChange={setTo}>
            <SelectTrigger aria-label="Destination branch">
              <SelectValue placeholder="To" />
            </SelectTrigger>
            <SelectContent>
              {branches
                .filter((b) => b.id !== from)
                .map((b) => (
                  <SelectItem key={b.id} value={b.id}>
                    {b.name}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="transfer-note" className="text-xs">
            Note
          </Label>
          <Input
            id="transfer-note"
            placeholder="Reason or instructions for the receiving showroom (optional)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
        <div className="flex gap-2">
          <Input
            aria-label={t("Scan or type IMEI")}
            placeholder={t("Scan or type IMEI")}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onScan}
          />
          <ScanButton continuous onScan={pick} />
        </div>
        <div className="max-h-72 overflow-y-auto rounded-md border">
          {shown.map((i) => (
            <label
              key={i.id}
              className="flex cursor-pointer items-center gap-3 border-b px-3 py-2 text-sm last:border-0 hover:bg-muted"
            >
              <Checkbox
                checked={sel.has(i.id)}
                onCheckedChange={(c) => {
                  setSel((prev) => {
                    const n = new Set(prev);
                    if (c) n.add(i.id);
                    else n.delete(i.id);
                    return n;
                  });
                }}
              />
              <span className="font-mono text-xs">{i.imei}</span>
              <span className="text-muted-foreground">{productLabel(i.products)}</span>
            </label>
          ))}
          {from && shown.length === 0 && (
            <div className="p-4 text-center text-sm text-muted-foreground">No stock</div>
          )}
        </div>
        <Button disabled={busy || !from || !to || sel.size === 0} onClick={submit}>
          Send {sel.size} items
        </Button>
      </DialogContent>
    </Dialog>
  );
}
