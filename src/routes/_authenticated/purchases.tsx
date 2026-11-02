import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment, useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { BranchPicker, PageHeader } from "@/components/BranchPicker";
import { ScanButton } from "@/components/BarcodeScanner";
import { productLabel, taka, useBranches, useMe, useProducts } from "@/lib/erp";
import { isValidImei } from "@/lib/imei";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { fetchAllPages } from "@/lib/paginated-query";

export const Route = createFileRoute("/_authenticated/purchases")({
  head: () => ({
    meta: [
      { title: "Purchases & suppliers — Dealer ERP" },
      {
        name: "description",
        content: "Receive IMEI stock from suppliers, track supplier dues, payments and returns.",
      },
    ],
  }),
  component: Purchases,
});

function Purchases() {
  const [branch, setBranch] = useState("");
  return (
    <div>
      <PageHeader title="Purchases">
        <BranchPicker value={branch} onChange={setBranch} allowAll />
      </PageHeader>
      <Tabs defaultValue="receive">
        <TabsList>
          <TabsTrigger value="receive">Goods receive</TabsTrigger>
          <TabsTrigger value="history">History & dues</TabsTrigger>
          <TabsTrigger value="suppliers">Suppliers</TabsTrigger>
        </TabsList>
        <TabsContent value="receive">
          <Receive branch={branch} />
        </TabsContent>
        <TabsContent value="history">
          <History branch={branch} />
        </TabsContent>
        <TabsContent value="suppliers">
          <Suppliers />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function useSuppliers() {
  return useQuery({
    queryKey: ["suppliers"],
    queryFn: async () => fetchAllPages(supabase.from("suppliers").select("*").order("name")),
  });
}

function Receive({ branch }: { branch: string }) {
  const qc = useQueryClient();
  const { data: me } = useMe();
  const { data: suppliers = [] } = useSuppliers();
  const { data: products = [] } = useProducts();
  const [supplier, setSupplier] = useState("");
  const [product, setProduct] = useState("");
  const [cost, setCost] = useState("");
  const [imeis, setImeis] = useState("");
  const [invoice, setInvoice] = useState("");
  const [paid, setPaid] = useState("0");
  const [method, setMethod] = useState("cash");
  const [busy, setBusy] = useState(false);
  const canReceive =
    !!me &&
    !!branch &&
    branch !== "all" &&
    (me.canWriteHq || (me.branch_id === branch && me.roles.includes("branch_manager")));
  // Each line: IMEI[,IMEI2][,cost] — lets staff paste from Excel/CSV
  const lines = imeis
    .split(/\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [a, b, c] = l.split(/[,\t;]/).map((x) => x.trim());
      return {
        imei: a ?? "",
        imei2: b && !/^\d{1,7}(\.\d+)?$/.test(b) ? b : "",
        cost: Number((c ?? (b && /^\d{1,7}(\.\d+)?$/.test(b) ? b : "")) || cost || 0),
      };
    });
  const bad = lines.filter((l) => !isValidImei(l.imei));
  const total = lines.reduce((s, l) => s + l.cost, 0);
  const sel = products.find((p) => p.id === product);

  async function save() {
    if (!canReceive) {
      toast.error("Choose a branch you are allowed to purchase for");
      return;
    }
    setBusy(true);
    const { error } = await supabase.rpc("create_purchase", {
      _supplier: supplier,
      _branch: branch,
      _invoice: invoice,
      _paid: Number(paid || 0),
      _method: method,
      _note: "",
      _items: lines.map((l) => ({
        product_id: product,
        imei: l.imei,
        imei2: l.imei2,
        cost: l.cost,
      })),
    });
    setBusy(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success(`${lines.length} items received`);
    setImeis("");
    setInvoice("");
    setPaid("0");
    qc.invalidateQueries();
  }

  if (!canReceive)
    return (
      <Card className="p-6 text-sm text-muted-foreground">
        Choose a branch you manage to receive a purchase.
      </Card>
    );

  return (
    <Card className="grid gap-3 p-4 md:grid-cols-2">
      <div className="space-y-2">
        <Label>Supplier</Label>
        <select
          className="w-full rounded-md border bg-background px-2 py-2"
          value={supplier}
          onChange={(e) => setSupplier(e.target.value)}
        >
          <option value="">Choose…</option>
          {suppliers.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <Label>Product</Label>
        <select
          className="w-full rounded-md border bg-background px-2 py-2"
          value={product}
          onChange={(e) => {
            setProduct(e.target.value);
            const p = products.find((x) => x.id === e.target.value);
            if (p) setCost(String(p.purchase_price));
          }}
        >
          <option value="">Choose…</option>
          {products.map((p) => (
            <option key={p.id} value={p.id}>
              {productLabel(p)}
            </option>
          ))}
        </select>
        {sel && (
          <p className="text-xs text-muted-foreground">
            Dealer/purchase price {taka(sel.purchase_price)} · Retail price {taka(sel.sale_price)}
          </p>
        )}
        <div className="grid grid-cols-2 gap-2">
          <div>
            <Label>Unit cost ৳</Label>
            <Input type="number" value={cost} onChange={(e) => setCost(e.target.value)} />
          </div>
          <div>
            <Label>Supplier invoice no.</Label>
            <Input value={invoice} onChange={(e) => setInvoice(e.target.value)} />
          </div>
          <div>
            <Label>Paid now ৳</Label>
            <Input type="number" value={paid} onChange={(e) => setPaid(e.target.value)} />
          </div>
          <div>
            <Label>Method</Label>
            <select
              className="w-full rounded-md border bg-background px-2 py-2"
              value={method}
              onChange={(e) => setMethod(e.target.value)}
            >
              {["cash", "bank", "bkash", "nagad"].map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
          </div>
        </div>
      </div>
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label>IMEIs (one per line; or paste from Excel: IMEI, IMEI2, cost)</Label>
          <ScanButton
            continuous
            onScan={(c) => setImeis((v) => (v.includes(c) ? v : (v ? v + "\n" : "") + c))}
          />
        </div>
        <Textarea
          rows={9}
          className="font-mono text-xs"
          value={imeis}
          onChange={(e) => setImeis(e.target.value)}
        />
        <p className="text-sm">
          {lines.length} items · Total {taka(total)} · Due{" "}
          {taka(Math.max(0, total - Number(paid || 0)))}
        </p>
        {bad.length > 0 && (
          <p className="text-xs text-destructive">
            Invalid IMEI: {bad.map((b) => b.imei).join(", ")}
          </p>
        )}
        <Button
          className="w-full"
          disabled={busy || !canReceive || !supplier || !product || !lines.length || bad.length > 0}
          onClick={save}
        >
          Receive stock
        </Button>
      </div>
    </Card>
  );
}

function History({ branch }: { branch: string }) {
  const qc = useQueryClient();
  const { data: me } = useMe();
  const { data: branches = [] } = useBranches();
  const [open, setOpen] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [paying, setPaying] = useState<{ id: string; amount: string } | null>(null);
  const [payMethod, setPayMethod] = useState("cash");
  const { data = [] } = useQuery({
    queryKey: ["purchases", branch],
    enabled: !!branch,
    queryFn: async () => {
      let q = supabase
        .from("purchases")
        .select(
          "*, suppliers(name), purchase_items(id, cost, returned, inventory_items(imei, status, products(brand,model,variant)))",
        )
        .order("created_at", { ascending: false });
      if (branch !== "all") q = q.eq("branch_id", branch);
      return fetchAllPages(q);
    },
  });
  const can = !!me && (me.canWriteHq || me.roles.includes("branch_manager"));
  const due = (p: { total: number; returned: number; paid: number }) =>
    Number(p.total) - Number(p.returned) - Number(p.paid);
  const totalDue = data.reduce((s, p) => s + due(p), 0);
  const shown = data.filter(
    (p) =>
      !search ||
      [
        p.supplier_invoice,
        p.suppliers?.name,
        ...p.purchase_items.map((i) => i.inventory_items?.imei),
      ]
        .join(" ")
        .toLowerCase()
        .includes(search.toLowerCase()),
  );

  async function pay() {
    if (!paying) return;
    const { error } = await supabase.rpc("pay_supplier", {
      _purchase: paying.id,
      _amount: Number(paying.amount),
      _method: payMethod,
    });
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Payment saved");
    setPaying(null);
    qc.invalidateQueries();
  }
  async function ret(id: string, imei: string) {
    if (!window.confirm(`Return IMEI ${imei} to supplier?`)) return;
    const { error } = await supabase.rpc("return_purchase_item", { _purchase_item: id });
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Returned to supplier");
    qc.invalidateQueries();
  }

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-3 p-4">
        <div className="text-sm">
          Total supplier due: <b>{taka(totalDue)}</b>
        </div>
        <Input
          className="max-w-sm bg-card"
          placeholder="Search supplier, invoice or IMEI"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Date</TableHead>
            <TableHead>Supplier</TableHead>
            <TableHead>Invoice</TableHead>
            <TableHead>Branch</TableHead>
            <TableHead>Items</TableHead>
            <TableHead className="text-right">Total</TableHead>
            <TableHead className="text-right">Paid</TableHead>
            <TableHead className="text-right">Due</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {shown.map((p) => (
            <Fragment key={p.id}>
              <TableRow key={p.id}>
                <TableCell>{new Date(p.created_at).toLocaleDateString()}</TableCell>
                <TableCell>{p.suppliers?.name}</TableCell>
                <TableCell className="font-mono text-xs">{p.supplier_invoice}</TableCell>
                <TableCell>{branches.find((b) => b.id === p.branch_id)?.name}</TableCell>
                <TableCell>
                  <button
                    className="text-primary"
                    onClick={() => setOpen(open === p.id ? null : p.id)}
                  >
                    {p.purchase_items.length} items
                  </button>
                </TableCell>
                <TableCell className="text-right">
                  {taka(p.total)}
                  {Number(p.returned) > 0 && (
                    <div className="text-xs text-muted-foreground">
                      −{taka(p.returned)} returned
                    </div>
                  )}
                </TableCell>
                <TableCell className="text-right">{taka(p.paid)}</TableCell>
                <TableCell className="text-right">
                  {due(p) > 0 ? (
                    <Badge variant="destructive">{taka(due(p))}</Badge>
                  ) : (
                    <Badge variant="outline">Paid</Badge>
                  )}
                </TableCell>
                <TableCell>
                  <div className="flex gap-1">
                    {can && due(p) > 0 && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          setPaying({ id: p.id, amount: String(due(p)) });
                          setPayMethod("cash");
                        }}
                      >
                        Pay
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" asChild>
                      <Link to="/purchase-print/$purchaseId" params={{ purchaseId: p.id }}>
                        Print
                      </Link>
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
              {open === p.id &&
                p.purchase_items.map((it) => (
                  <TableRow key={it.id} className="bg-muted/40">
                    <TableCell colSpan={4} className="font-mono text-xs">
                      {it.inventory_items?.imei} · {productLabel(it.inventory_items?.products)}
                    </TableCell>
                    <TableCell>{it.returned ? "returned" : it.inventory_items?.status}</TableCell>
                    <TableCell className="text-right">{taka(it.cost)}</TableCell>
                    <TableCell colSpan={3}>
                      {can && !it.returned && it.inventory_items?.status === "in_stock" && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => ret(it.id, it.inventory_items?.imei ?? "")}
                        >
                          Return to supplier
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
            </Fragment>
          ))}
          {shown.length === 0 && (
            <TableRow>
              <TableCell colSpan={9} className="py-8 text-center text-muted-foreground">
                {data.length ? "No purchases match this search." : "No purchases yet."}
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
      <Dialog
        open={!!paying}
        onOpenChange={(value) => {
          if (!value) setPaying(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Pay supplier</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label>Amount ৳</Label>
              <Input
                type="number"
                min="0.01"
                value={paying?.amount ?? ""}
                onChange={(e) => setPaying((p) => (p ? { ...p, amount: e.target.value } : p))}
              />
            </div>
            <div className="space-y-1">
              <Label>Payment method</Label>
              <select
                className="w-full rounded-md border bg-background px-2 py-2"
                value={payMethod}
                onChange={(e) => setPayMethod(e.target.value)}
              >
                {["cash", "bank", "bkash", "nagad"].map((m) => (
                  <option key={m}>{m}</option>
                ))}
              </select>
            </div>
            <Button
              className="w-full"
              disabled={!paying || !(Number(paying.amount) > 0)}
              onClick={pay}
            >
              Save payment
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function Suppliers() {
  const qc = useQueryClient();
  const { data: me } = useMe();
  const { data = [] } = useSuppliers();
  const { data: dues = [] } = useQuery({
    queryKey: ["supplier-dues"],
    queryFn: async () =>
      fetchAllPages(supabase.from("purchases").select("supplier_id,total,returned,paid")),
  });
  const [f, setF] = useState({ name: "", phone: "", address: "" });
  const [editing, setEditing] = useState<{
    id: string;
    name: string;
    phone: string;
    address: string;
  } | null>(null);
  async function add() {
    const { error } = await supabase.from("suppliers").insert(f);
    if (error) {
      toast.error(error.message);
      return;
    }
    setF({ name: "", phone: "", address: "" });
    qc.invalidateQueries({ queryKey: ["suppliers"] });
  }
  async function saveSupplier() {
    if (!editing) return;
    const { error } = await supabase
      .from("suppliers")
      .update({
        name: editing.name.trim(),
        phone: editing.phone || null,
        address: editing.address || null,
      })
      .eq("id", editing.id);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Supplier updated");
    setEditing(null);
    qc.invalidateQueries({ queryKey: ["suppliers"] });
  }
  async function deleteSupplier(supplier: (typeof data)[number]) {
    if (
      !window.confirm(`Delete ${supplier.name}? Suppliers with purchase history cannot be deleted.`)
    )
      return;
    const { error } = await supabase.from("suppliers").delete().eq("id", supplier.id);
    if (error) {
      toast.error(
        error.code === "23503"
          ? "This supplier has purchase history and cannot be deleted."
          : error.message,
      );
      return;
    }
    toast.success("Supplier deleted");
    qc.invalidateQueries({ queryKey: ["suppliers"] });
  }
  const dueOf = (id: string) =>
    dues
      .filter((d) => d.supplier_id === id)
      .reduce((s, d) => s + Number(d.total) - Number(d.returned) - Number(d.paid), 0);
  return (
    <Card>
      {me?.canWriteHq && (
        <div className="flex flex-wrap gap-2 p-4">
          <Input
            className="w-48"
            placeholder="Name"
            value={f.name}
            onChange={(e) => setF({ ...f, name: e.target.value })}
          />
          <Input
            className="w-40"
            placeholder="Phone"
            value={f.phone}
            onChange={(e) => setF({ ...f, phone: e.target.value })}
          />
          <Input
            className="w-64"
            placeholder="Address"
            value={f.address}
            onChange={(e) => setF({ ...f, address: e.target.value })}
          />
          <Button onClick={add} disabled={!f.name}>
            Add supplier
          </Button>
        </div>
      )}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Phone</TableHead>
            <TableHead>Address</TableHead>
            <TableHead className="text-right">Due</TableHead>
            {me?.canWriteHq && <TableHead />}
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.map((s) => (
            <TableRow key={s.id}>
              <TableCell>{s.name}</TableCell>
              <TableCell>{s.phone}</TableCell>
              <TableCell>{s.address}</TableCell>
              <TableCell className="text-right">{taka(dueOf(s.id))}</TableCell>
              {me?.canWriteHq && (
                <TableCell className="text-right">
                  <div className="flex justify-end gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        setEditing({
                          id: s.id,
                          name: s.name,
                          phone: s.phone ?? "",
                          address: s.address ?? "",
                        })
                      }
                    >
                      Edit
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-destructive"
                      onClick={() => deleteSupplier(s)}
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
      <Dialog
        open={!!editing}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit supplier</DialogTitle>
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
            <Button className="w-full" disabled={!editing?.name.trim()} onClick={saveSupplier}>
              Save changes
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
