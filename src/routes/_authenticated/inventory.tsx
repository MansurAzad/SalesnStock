import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { BranchPicker, PageHeader } from "@/components/BranchPicker";
import { productLabel, taka, useBranches, useMe, useProducts } from "@/lib/erp";
import { useT } from "@/lib/i18n";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
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
import { ScanButton } from "@/components/BarcodeScanner";
import { isValidImei } from "@/lib/imei";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { fetchAllPages } from "@/lib/paginated-query";

export const Route = createFileRoute("/_authenticated/inventory")({
  head: () => ({ meta: [{ title: "Inventory — Dealer ERP" }] }),
  component: Inventory,
});

const statusVariant: Record<string, string> = {
  in_stock: "bg-success/15 text-success",
  in_transit: "bg-warning/20 text-accent-foreground",
  sold: "bg-muted text-muted-foreground",
  returned: "bg-secondary text-secondary-foreground",
  damaged: "bg-destructive/15 text-destructive",
};

function Inventory() {
  const { t } = useT();
  const { data: me } = useMe();
  const qc = useQueryClient();
  const [branch, setBranch] = useState("");
  const [status, setStatus] = useState("in_stock");
  const [q, setQ] = useState("");
  const { data: branches = [] } = useBranches();
  const { data: items = [] } = useQuery({
    queryKey: ["inventory", branch, status],
    enabled: !!branch,
    queryFn: async () => {
      let qq = supabase
        .from("inventory_items")
        .select("*, products(brand,model,variant,sale_price)")
        .order("created_at", { ascending: false });
      if (branch !== "all") qq = qq.eq("branch_id", branch);
      if (status !== "any") qq = qq.eq("status", status);
      return fetchAllPages(qq);
    },
  });
  const filtered = items.filter(
    (i) =>
      !q || i.imei.includes(q) || productLabel(i.products).toLowerCase().includes(q.toLowerCase()),
  );
  const bname = (id: string) => branches.find((b) => b.id === id)?.name ?? "";
  const canManageStock = (itemBranch: string) =>
    !!me && (me.canWriteHq || (me.roles.includes("branch_manager") && me.branch_id === itemBranch));
  const canManageAny = !!me && (me.canWriteHq || me.roles.includes("branch_manager"));

  async function setDamageStatus(id: string, damaged: boolean) {
    const reason = window.prompt(
      damaged
        ? "Why is this item being marked damaged?"
        : "Why is this item being restored to stock?",
    );
    if (!reason?.trim()) return;
    const { error } = await supabase.rpc(
      damaged ? "mark_inventory_damaged" : "restore_damaged_inventory",
      { _item: id, _reason: reason.trim() },
    );
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success(damaged ? "Item marked damaged" : "Item restored to stock");
    qc.invalidateQueries({ queryKey: ["inventory"] });
  }

  return (
    <div>
      <PageHeader title={t("Inventory")}>
        <BranchPicker value={branch} onChange={setBranch} allowAll />
        {me?.canWriteHq && <AddStock />}
      </PageHeader>
      <Tabs defaultValue="items">
        <TabsList>
          <TabsTrigger value="items">IMEI</TabsTrigger>
          <TabsTrigger value="products">{t("Products")}</TabsTrigger>
        </TabsList>
        <TabsContent value="items">
          <div className="mb-3 flex gap-2">
            <Input
              placeholder={t("Search") + " IMEI / model"}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              className="max-w-xs bg-card"
            />
            <ScanButton
              onScan={(c) => {
                setQ(c);
                setStatus("any");
              }}
            />
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger className="w-40 bg-card">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {["any", "in_stock", "in_transit", "sold", "returned", "damaged"].map((s) => (
                  <SelectItem key={s} value={s}>
                    {s.replace("_", " ")}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="ml-auto self-center text-sm text-muted-foreground">
              {filtered.length} pcs
            </div>
          </div>
          <Card>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>IMEI</TableHead>
                  <TableHead>{t("Product")}</TableHead>
                  <TableHead>{t("Branch")}</TableHead>
                  <TableHead>{t("Status")}</TableHead>
                  {me?.isHq && <TableHead className="text-right">Cost</TableHead>}
                  <TableHead className="text-right">{t("Price")}</TableHead>
                  {canManageAny && <TableHead />}
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((i) => (
                  <TableRow key={i.id}>
                    <TableCell className="font-mono text-xs">{i.imei}</TableCell>
                    <TableCell>{productLabel(i.products)}</TableCell>
                    <TableCell>{bname(i.branch_id)}</TableCell>
                    <TableCell>
                      <Badge className={statusVariant[i.status]} variant="outline">
                        {i.status.replace("_", " ")}
                      </Badge>
                    </TableCell>
                    {me?.isHq && (
                      <TableCell className="text-right tabular">{taka(i.purchase_price)}</TableCell>
                    )}
                    <TableCell className="text-right tabular">
                      {taka(i.products?.sale_price)}
                    </TableCell>
                    {canManageStock(i.branch_id) && (
                      <TableCell className="text-right">
                        {i.status === "in_stock" ? (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setDamageStatus(i.id, true)}
                          >
                            Mark damaged
                          </Button>
                        ) : i.status === "damaged" ? (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setDamageStatus(i.id, false)}
                          >
                            Restore
                          </Button>
                        ) : null}
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        </TabsContent>
        <TabsContent value="products">
          <ProductsTab canEdit={!!me?.canWriteHq} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function ProductsTab({ canEdit }: { canEdit: boolean }) {
  const { data: products = [] } = useProducts();
  const qc = useQueryClient();
  const [f, setF] = useState({
    brand: "",
    model: "",
    variant: "",
    kind: "phone",
    purchase_price: "",
    sale_price: "",
    min_stock: "",
  });
  const [editing, setEditing] = useState<{
    id: string;
    brand: string;
    model: string;
    variant: string;
    kind: string;
    purchase_price: string;
    sale_price: string;
    min_stock: string;
  } | null>(null);
  async function add() {
    const brand = f.brand.trim();
    const model = f.model.trim();
    if (!brand || !model) {
      toast.error("Brand and model are required");
      return;
    }
    const purchase_price = Number(f.purchase_price);
    const sale_price = Number(f.sale_price);
    if (!Number.isFinite(purchase_price) || purchase_price < 0) {
      toast.error("Enter a valid purchase price");
      return;
    }
    if (!Number.isFinite(sale_price) || sale_price < 0) {
      toast.error("Enter a valid sale price");
      return;
    }
    const { error } = await supabase.from("products").insert({
      ...f,
      brand,
      model,
      variant: f.variant.trim() || null,
      purchase_price,
      sale_price,
      min_stock: Number(f.min_stock) || 0,
    });
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Product added");
    setF({
      brand: "",
      model: "",
      variant: "",
      kind: "phone",
      purchase_price: "",
      sale_price: "",
      min_stock: "",
    });
    qc.invalidateQueries({ queryKey: ["products"] });
  }
  async function saveProduct() {
    if (!editing) return;
    const { id, ...fields } = editing;
    const purchase_price = Number(fields.purchase_price);
    const sale_price = Number(fields.sale_price);
    const min_stock = Number(fields.min_stock) || 0;
    if (!fields.brand.trim() || !fields.model.trim()) {
      toast.error("Brand and model are required");
      return;
    }
    if (!Number.isFinite(purchase_price) || purchase_price < 0) {
      toast.error("Enter a valid purchase price");
      return;
    }
    if (!Number.isFinite(sale_price) || sale_price < 0) {
      toast.error("Enter a valid sale price");
      return;
    }
    if (min_stock < 0) {
      toast.error("Reorder level cannot be negative");
      return;
    }
    const { error } = await supabase
      .from("products")
      .update({
        ...fields,
        brand: fields.brand.trim(),
        model: fields.model.trim(),
        variant: fields.variant.trim() || null,
        purchase_price,
        sale_price,
        min_stock,
      })
      .eq("id", id);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Product updated");
    setEditing(null);
    qc.invalidateQueries({ queryKey: ["products"] });
    qc.invalidateQueries({ queryKey: ["inventory"] });
  }
  async function deleteProduct(product: (typeof products)[number]) {
    if (
      !window.confirm(
        `Delete ${productLabel(product)}? Products used by inventory cannot be deleted.`,
      )
    )
      return;
    const { error } = await supabase.from("products").delete().eq("id", product.id);
    if (error) {
      toast.error(
        error.code === "23503"
          ? "This product has stock or sales history and cannot be deleted."
          : error.message,
      );
      return;
    }
    toast.success("Product deleted");
    qc.invalidateQueries({ queryKey: ["products"] });
  }
  return (
    <div className="space-y-3">
      {canEdit && (
        <Card className="flex flex-wrap items-end gap-2 p-4">
          {(
            ["brand", "model", "variant", "purchase_price", "sale_price", "min_stock"] as const
          ).map((k) => (
            <div key={k} className="space-y-1">
              <Label className="text-xs capitalize">
                {k === "min_stock" ? "Reorder at" : k.replace("_", " ")}
              </Label>
              <Input
                className="w-36"
                type={k.includes("price") || k === "min_stock" ? "number" : "text"}
                min={k.includes("price") || k === "min_stock" ? 0 : undefined}
                value={f[k]}
                onChange={(e) => setF({ ...f, [k]: e.target.value })}
              />
            </div>
          ))}
          <Select value={f.kind} onValueChange={(v) => setF({ ...f, kind: v })}>
            <SelectTrigger className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="phone">Phone</SelectItem>
              <SelectItem value="accessory">Accessory</SelectItem>
            </SelectContent>
          </Select>
          <Button
            onClick={add}
            disabled={
              !f.brand.trim() ||
              !f.model.trim() ||
              !Number.isFinite(Number(f.purchase_price)) ||
              !Number.isFinite(Number(f.sale_price)) ||
              Number(f.purchase_price) < 0 ||
              Number(f.sale_price) < 0
            }
          >
            Add product
          </Button>
        </Card>
      )}
      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Brand</TableHead>
              <TableHead>Model</TableHead>
              <TableHead>Type</TableHead>
              <TableHead className="text-right">Cost</TableHead>
              <TableHead className="text-right">MRP</TableHead>
              <TableHead className="text-right">Reorder at</TableHead>
              {canEdit && <TableHead />}
            </TableRow>
          </TableHeader>
          <TableBody>
            {products.map((p) => (
              <TableRow key={p.id}>
                <TableCell>{p.brand}</TableCell>
                <TableCell>
                  {p.model} {p.variant}
                </TableCell>
                <TableCell className="capitalize">{p.kind}</TableCell>
                <TableCell className="text-right tabular">{taka(p.purchase_price)}</TableCell>
                <TableCell className="text-right tabular">{taka(p.sale_price)}</TableCell>
                <TableCell className="text-right tabular">{p.min_stock || "—"}</TableCell>
                {canEdit && (
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          setEditing({
                            id: p.id,
                            brand: p.brand,
                            model: p.model,
                            variant: p.variant ?? "",
                            kind: p.kind,
                            purchase_price: String(p.purchase_price),
                            sale_price: String(p.sale_price),
                            min_stock: String(p.min_stock ?? 0),
                          })
                        }
                      >
                        Edit
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-destructive"
                        onClick={() => deleteProduct(p)}
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
            <DialogTitle>Edit product</DialogTitle>
            <DialogDescription>Update this product's model details and prices.</DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-3">
            {(
              ["brand", "model", "variant", "purchase_price", "sale_price", "min_stock"] as const
            ).map((field) => (
              <div key={field} className="space-y-1">
                <Label className="text-xs capitalize">
                  {field === "min_stock" ? "Reorder at" : field.replace("_", " ")}
                </Label>
                <Input
                  type={field.includes("price") || field === "min_stock" ? "number" : "text"}
                  min={field.includes("price") || field === "min_stock" ? 0 : undefined}
                  step={field.includes("price") ? "0.01" : undefined}
                  value={editing?.[field] ?? ""}
                  onChange={(e) =>
                    setEditing((current) =>
                      current ? { ...current, [field]: e.target.value } : current,
                    )
                  }
                />
              </div>
            ))}
            <div className="space-y-1">
              <Label className="text-xs">Type</Label>
              <Select
                value={editing?.kind ?? "phone"}
                onValueChange={(kind) =>
                  setEditing((current) => (current ? { ...current, kind } : current))
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="phone">Phone</SelectItem>
                  <SelectItem value="accessory">Accessory</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button
              className="col-span-2"
              disabled={
                !editing?.brand.trim() ||
                !editing.model.trim() ||
                Number(editing.purchase_price) < 0 ||
                Number(editing.sale_price) < 0
              }
              onClick={saveProduct}
            >
              Save changes
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function AddStock() {
  const { t } = useT();
  const qc = useQueryClient();
  const { data: products = [] } = useProducts();
  const { data: branches = [] } = useBranches();
  const { data: suppliers = [] } = useQuery({
    queryKey: ["suppliers"],
    queryFn: async () => {
      const { data, error } = await supabase.from("suppliers").select("*").order("name");
      if (error) throw error;
      return data ?? [];
    },
  });
  const [open, setOpen] = useState(false);
  const [productId, setProductId] = useState("");
  const [branchId, setBranchId] = useState("");
  const [imeis, setImeis] = useState("");
  const [supplierId, setSupplierId] = useState("");
  const [invoice, setInvoice] = useState("");
  const [cost, setCost] = useState("");
  const [paid, setPaid] = useState("");
  const [method, setMethod] = useState("cash");
  const [note, setNote] = useState("");
  const product = products.find((p) => p.id === productId);
  // Each line is "imei" or "imei,imeei2" — a phone with two IMEI codes is the
  // normal case in this trade, so the second one must not be thrown away.
  const list = Array.from(
    new Map(
      imeis
        .split(/\n+/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [a, b] = line.split(/[,|]/).map((s) => s.trim());
          return { imei: a ?? "", imei2: b || null };
        })
        .map((row) => [row.imei, row] as const),
    ).values(),
  );
  const invalid = list.filter((x) => !isValidImei(x.imei));
  const unitCost = cost === "" ? Number(product?.purchase_price ?? 0) : Number(cost);
  const totalCost = list.length * unitCost;
  const paidAmount = Number(paid) || 0;

  async function save() {
    if (!product || !branchId || !supplierId) return;
    if (!Number.isFinite(unitCost) || unitCost < 0) {
      toast.error("Enter a valid purchase cost");
      return;
    }
    if (paidAmount > totalCost) {
      toast.error("Paid amount cannot be more than the total cost");
      return;
    }
    const { error } = await supabase.rpc("create_purchase", {
      _supplier: supplierId,
      _branch: branchId,
      _invoice: invoice,
      _paid: paidAmount,
      _method: method,
      _note: note.trim() || "Stock received from inventory page",
      _items: list.map((row) => ({
        product_id: product.id,
        imei: row.imei,
        imei2: row.imei2,
        cost: unitCost,
      })),
    });
    if (error) {
      toast.error(
        error.message.includes("duplicate") ? "One or more IMEIs already exist" : error.message,
      );
      return;
    }
    toast.success(`${list.length} items added`);
    setImeis("");
    setInvoice("");
    setPaid("");
    setNote("");
    setOpen(false);
    qc.invalidateQueries();
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>{t("Add stock")}</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("Add stock")} (purchase)</DialogTitle>
          <DialogDescription>
            Enter one IMEI per line — the stock is booked in as a supplier purchase.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Select value={productId} onValueChange={setProductId}>
            <SelectTrigger>
              <SelectValue placeholder={t("Product")} />
            </SelectTrigger>
            <SelectContent>
              {products.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {productLabel(p)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="grid grid-cols-2 gap-2">
            <Select value={branchId} onValueChange={setBranchId}>
              <SelectTrigger>
                <SelectValue placeholder={t("Branch")} />
              </SelectTrigger>
              <SelectContent>
                {branches.map((b) => (
                  <SelectItem key={b.id} value={b.id}>
                    {b.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={supplierId} onValueChange={setSupplierId}>
              <SelectTrigger>
                <SelectValue placeholder="Supplier" />
              </SelectTrigger>
              <SelectContent>
                {suppliers.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Input
            placeholder="Supplier invoice no. (optional)"
            value={invoice}
            onChange={(e) => setInvoice(e.target.value)}
          />
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label className="text-xs" htmlFor="stock-cost">
                Cost per item
              </Label>
              <Input
                id="stock-cost"
                type="number"
                min={0}
                step="0.01"
                placeholder={String(product?.purchase_price ?? "")}
                value={cost}
                onChange={(e) => setCost(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs" htmlFor="stock-paid">
                Amount paid now
              </Label>
              <Input
                id="stock-paid"
                type="number"
                min={0}
                step="0.01"
                placeholder="0"
                value={paid}
                onChange={(e) => setPaid(e.target.value)}
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label className="text-xs">Payment method</Label>
              <Select value={method} onValueChange={setMethod}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {["cash", "bank", "bkash", "nagad", "cheque", "online"].map((m) => (
                    <SelectItem key={m} value={m}>
                      {m}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs" htmlFor="stock-note">
                Note
              </Label>
              <Input
                id="stock-note"
                placeholder="Optional note for this purchase"
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            </div>
          </div>
          {product && (
            <div className="rounded-md border bg-muted/40 px-3 py-2 text-xs">
              Total cost <span className="font-semibold">{taka(totalCost)}</span> for {list.length}{" "}
              item{list.length === 1 ? "" : "s"}
              {paidAmount > 0 && (
                <>
                  {" "}
                  · due <span className="font-semibold">{taka(totalCost - paidAmount)}</span>
                </>
              )}
            </div>
          )}
          <div>
            <div className="flex items-center justify-between">
              <Label className="text-xs">
                IMEI numbers (one per line, 15 digits — add IMEI2 after a comma)
              </Label>
              <ScanButton
                continuous
                label="Scan"
                onScan={(c) => setImeis((v) => (v.includes(c) ? v : (v ? v + "\n" : "") + c))}
              />
            </div>
            <Textarea
              rows={6}
              className="font-mono text-xs"
              placeholder={"356938035643809\n356938035643817,356938035643825"}
              value={imeis}
              onChange={(e) => setImeis(e.target.value)}
            />
            <div className="mt-1 text-xs text-muted-foreground">
              {list.length} IMEI
              {invalid.length > 0 && (
                <span className="text-destructive"> · {invalid.length} invalid</span>
              )}
            </div>
          </div>
          <Button
            className="w-full"
            disabled={
              !productId || !branchId || !supplierId || list.length === 0 || invalid.length > 0
            }
            onClick={save}
          >
            {t("Save")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
