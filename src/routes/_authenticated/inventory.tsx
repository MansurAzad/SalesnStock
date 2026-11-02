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
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
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
      let qq = supabase.from("inventory_items").select("*, products(brand,model,variant,sale_price)").order("created_at", { ascending: false });
      if (branch !== "all") qq = qq.eq("branch_id", branch);
      if (status !== "any") qq = qq.eq("status", status);
      return fetchAllPages(qq);
    },
  });
  const filtered = items.filter((i) => !q || i.imei.includes(q) || productLabel(i.products).toLowerCase().includes(q.toLowerCase()));
  const bname = (id: string) => branches.find((b) => b.id === id)?.name ?? "";

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
            <Input placeholder={t("Search") + " IMEI / model"} value={q} onChange={(e) => setQ(e.target.value)} className="max-w-xs bg-card" />
            <ScanButton onScan={(c) => { setQ(c); setStatus("any"); }} />
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger className="w-40 bg-card"><SelectValue /></SelectTrigger>
              <SelectContent>
                {["any", "in_stock", "in_transit", "sold", "returned", "damaged"].map((s) => (
                  <SelectItem key={s} value={s}>{s.replace("_", " ")}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="ml-auto self-center text-sm text-muted-foreground">{filtered.length} pcs</div>
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
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((i) => (
                  <TableRow key={i.id}>
                    <TableCell className="font-mono text-xs">{i.imei}</TableCell>
                    <TableCell>{productLabel(i.products)}</TableCell>
                    <TableCell>{bname(i.branch_id)}</TableCell>
                    <TableCell><Badge className={statusVariant[i.status]} variant="outline">{i.status.replace("_", " ")}</Badge></TableCell>
                    {me?.isHq && <TableCell className="text-right tabular">{taka(i.purchase_price)}</TableCell>}
                    <TableCell className="text-right tabular">{taka(i.products?.sale_price)}</TableCell>
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
  const [f, setF] = useState({ brand: "", model: "", variant: "", kind: "phone", purchase_price: "", sale_price: "" });
  async function add() {
    const { error } = await supabase.from("products").insert({
      ...f, purchase_price: Number(f.purchase_price), sale_price: Number(f.sale_price),
    });
    if (error) { toast.error(error.message); return; }
    toast.success("Product added");
    setF({ brand: "", model: "", variant: "", kind: "phone", purchase_price: "", sale_price: "" });
    qc.invalidateQueries({ queryKey: ["products"] });
  }
  return (
    <div className="space-y-3">
      {canEdit && (
        <Card className="flex flex-wrap items-end gap-2 p-4">
          {(["brand", "model", "variant", "purchase_price", "sale_price"] as const).map((k) => (
            <div key={k} className="space-y-1">
              <Label className="text-xs capitalize">{k.replace("_", " ")}</Label>
              <Input className="w-36" value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} />
            </div>
          ))}
          <Select value={f.kind} onValueChange={(v) => setF({ ...f, kind: v })}>
            <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="phone">Phone</SelectItem>
              <SelectItem value="accessory">Accessory</SelectItem>
            </SelectContent>
          </Select>
          <Button onClick={add} disabled={!f.brand || !f.model}>Add product</Button>
        </Card>
      )}
      <Card>
        <Table>
          <TableHeader>
            <TableRow><TableHead>Brand</TableHead><TableHead>Model</TableHead><TableHead>Type</TableHead><TableHead className="text-right">Cost</TableHead><TableHead className="text-right">MRP</TableHead></TableRow>
          </TableHeader>
          <TableBody>
            {products.map((p) => (
              <TableRow key={p.id}>
                <TableCell>{p.brand}</TableCell>
                <TableCell>{p.model} {p.variant}</TableCell>
                <TableCell className="capitalize">{p.kind}</TableCell>
                <TableCell className="text-right tabular">{taka(p.purchase_price)}</TableCell>
                <TableCell className="text-right tabular">{taka(p.sale_price)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}

function AddStock() {
  const { t } = useT();
  const qc = useQueryClient();
  const { data: products = [] } = useProducts();
  const { data: branches = [] } = useBranches();
  const [open, setOpen] = useState(false);
  const [productId, setProductId] = useState("");
  const [branchId, setBranchId] = useState("");
  const [imeis, setImeis] = useState("");
  const [supplier, setSupplier] = useState("");
  const product = products.find((p) => p.id === productId);
  const list = Array.from(new Set(imeis.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean)));
  const invalid = list.filter((x) => !isValidImei(x));

  async function save() {
    if (!product || !branchId) return;
    const { error } = await supabase.from("inventory_items").insert(
      list.map((imei) => ({ imei, product_id: product.id, branch_id: branchId, purchase_price: product.purchase_price, supplier })),
    );
    if (error) { toast.error(error.message.includes("duplicate") ? "One or more IMEIs already exist" : error.message); return; }
    toast.success(`${list.length} items added`);
    setImeis("");
    setOpen(false);
    qc.invalidateQueries({ queryKey: ["inventory"] });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button>{t("Add stock")}</Button></DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>{t("Add stock")} (purchase)</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <Select value={productId} onValueChange={setProductId}>
            <SelectTrigger><SelectValue placeholder={t("Product")} /></SelectTrigger>
            <SelectContent>{products.map((p) => <SelectItem key={p.id} value={p.id}>{productLabel(p)}</SelectItem>)}</SelectContent>
          </Select>
          <Select value={branchId} onValueChange={setBranchId}>
            <SelectTrigger><SelectValue placeholder={t("Branch")} /></SelectTrigger>
            <SelectContent>{branches.map((b) => <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>)}</SelectContent>
          </Select>
          <Input placeholder="Supplier" value={supplier} onChange={(e) => setSupplier(e.target.value)} />
          <div>
            <div className="flex items-center justify-between"><Label className="text-xs">IMEI numbers (one per line, 15 digits)</Label><ScanButton continuous label="Scan" onScan={(c) => setImeis((v) => (v.includes(c) ? v : (v ? v + "\n" : "") + c))} /></div>
            <Textarea rows={6} className="font-mono text-xs" value={imeis} onChange={(e) => setImeis(e.target.value)} />
            <div className="mt-1 text-xs text-muted-foreground">
              {list.length} IMEI{invalid.length > 0 && <span className="text-destructive"> · {invalid.length} invalid</span>}
            </div>
          </div>
          <Button className="w-full" disabled={!productId || !branchId || list.length === 0 || invalid.length > 0} onClick={save}>
            {t("Save")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
