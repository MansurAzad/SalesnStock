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
  const canManageStock = !!me && (me.canWriteHq || me.roles.includes("branch_manager"));

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
                  {canManageStock && <TableHead />}
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
                    {canManageStock && (
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
  });
  const [editing, setEditing] = useState<{
    id: string;
    brand: string;
    model: string;
    variant: string;
    kind: string;
    purchase_price: string;
    sale_price: string;
  } | null>(null);
  async function add() {
    const { error } = await supabase.from("products").insert({
      ...f,
      purchase_price: Number(f.purchase_price),
      sale_price: Number(f.sale_price),
    });
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Product added");
    setF({ brand: "", model: "", variant: "", kind: "phone", purchase_price: "", sale_price: "" });
    qc.invalidateQueries({ queryKey: ["products"] });
  }
  async function saveProduct() {
    if (!editing) return;
    const { id, ...fields } = editing;
    const { error } = await supabase
      .from("products")
      .update({
        ...fields,
        purchase_price: Number(fields.purchase_price),
        sale_price: Number(fields.sale_price),
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
          {(["brand", "model", "variant", "purchase_price", "sale_price"] as const).map((k) => (
            <div key={k} className="space-y-1">
              <Label className="text-xs capitalize">{k.replace("_", " ")}</Label>
              <Input
                className="w-36"
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
          <Button onClick={add} disabled={!f.brand || !f.model}>
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
          </DialogHeader>
          <div className="grid grid-cols-2 gap-3">
            {(["brand", "model", "variant", "purchase_price", "sale_price"] as const).map(
              (field) => (
                <div key={field} className="space-y-1">
                  <Label className="text-xs capitalize">{field.replace("_", " ")}</Label>
                  <Input
                    type={field.includes("price") ? "number" : "text"}
                    min={field.includes("price") ? 0 : undefined}
                    step={field.includes("price") ? "0.01" : undefined}
                    value={editing?.[field] ?? ""}
                    onChange={(e) =>
                      setEditing((current) =>
                        current ? { ...current, [field]: e.target.value } : current,
                      )
                    }
                  />
                </div>
              ),
            )}
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
  const product = products.find((p) => p.id === productId);
  const list = Array.from(
    new Set(
      imeis
        .split(/[\s,]+/)
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  );
  const invalid = list.filter((x) => !isValidImei(x));

  async function save() {
    if (!product || !branchId || !supplierId) return;
    const { error } = await supabase.rpc("create_purchase", {
      _supplier: supplierId,
      _branch: branchId,
      _invoice: invoice,
      _paid: 0,
      _method: "cash",
      _note: "Stock received from inventory page",
      _items: list.map((imei) => ({
        product_id: product.id,
        imei,
        imei2: null,
        cost: Number(product.purchase_price),
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
          <Input
            placeholder="Supplier invoice no. (optional)"
            value={invoice}
            onChange={(e) => setInvoice(e.target.value)}
          />
          <div>
            <div className="flex items-center justify-between">
              <Label className="text-xs">IMEI numbers (one per line, 15 digits)</Label>
              <ScanButton
                continuous
                label="Scan"
                onScan={(c) => setImeis((v) => (v.includes(c) ? v : (v ? v + "\n" : "") + c))}
              />
            </div>
            <Textarea
              rows={6}
              className="font-mono text-xs"
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
