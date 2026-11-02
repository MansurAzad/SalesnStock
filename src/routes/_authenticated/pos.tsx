import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type KeyboardEvent } from "react";
import { toast } from "sonner";
import { enqueue, isNetworkError, offlineSoldIds, useOutbox } from "@/lib/offline";
import { supabase } from "@/integrations/supabase/client";
import { BranchPicker, PageHeader } from "@/components/BranchPicker";
import { productLabel, taka, useMe } from "@/lib/erp";
import { useT } from "@/lib/i18n";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { X } from "lucide-react";
import { ScanButton } from "@/components/BarcodeScanner";
import { extractImei } from "@/lib/imei";
import { fetchAllPages } from "@/lib/paginated-query";

export const Route = createFileRoute("/_authenticated/pos")({
  head: () => ({ meta: [{ title: "POS — Dealer ERP" }] }),
  component: POS,
});

type CartLine = { item_id: string; imei: string; label: string; price: number };

function POS() {
  const { t } = useT();
  const { data: me } = useMe();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [branch, setBranch] = useState("");
  const [scan, setScan] = useState("");
  const [cart, setCart] = useState<CartLine[]>([]);
  const [discount, setDiscount] = useState("0");
  const [reason, setReason] = useState("");
  const [saleType, setSaleType] = useState<"cash" | "installment">("cash");
  const [method, setMethod] = useState("cash");
  const [down, setDown] = useState("0");
  const [months, setMonths] = useState("6");
  const [phone, setPhone] = useState("");
  const [custName, setCustName] = useState("");
  const [nid, setNid] = useState("");
  const [busy, setBusy] = useState(false);
  const canSell =
    !!me &&
    !!branch &&
    (me.canWriteHq ||
      (me.branch_id === branch &&
        me.roles.some((r) => ["branch_manager", "sales", "accountant"].includes(r))));

  const box = useOutbox();
  const { data: allStock = [] } = useQuery({
    queryKey: ["inventory", branch, "in_stock", "pos"],
    enabled: !!branch,
    queryFn: async () => {
      return fetchAllPages(
        supabase
          .from("inventory_items")
          .select("id,imei,imei2,products(brand,model,variant,sale_price)")
          .eq("branch_id", branch)
          .eq("status", "in_stock"),
      );
    },
  });

  const soldOffline = offlineSoldIds(box.ops);
  const stock = allStock.filter((i) => !soldOffline.has(i.id));

  const { data: existing } = useQuery({
    queryKey: ["customer-phone", branch, phone],
    enabled: !!branch && phone.length >= 11,
    queryFn: async () => {
      const { data } = await supabase
        .from("customers")
        .select("id,name,phone")
        .eq("branch_id", branch)
        .eq("phone", phone)
        .maybeSingle();
      return data;
    },
  });

  const subtotal = cart.reduce((a, c) => a + c.price, 0);
  const total = Math.max(0, subtotal - Number(discount || 0));
  const financed = total - Number(down || 0);
  const monthly = saleType === "installment" && Number(months) > 0 ? financed / Number(months) : 0;

  function add(imei: string) {
    const code = extractImei(imei) ?? imei.trim();
    const it = stock.find((s) => s.imei === code || s.imei2 === code);
    if (!it) {
      toast.error("IMEI not available in this branch");
      return;
    }
    if (cart.some((c) => c.item_id === it.id)) {
      toast.error("Already in cart");
      return;
    }
    setCart((cart) =>
      cart.some((c) => c.item_id === it.id)
        ? cart
        : [
            ...cart,
            {
              item_id: it.id,
              imei: it.imei,
              label: productLabel(it.products),
              price: Number(it.products?.sale_price ?? 0),
            },
          ],
    );
    setScan("");
  }
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => e.key === "Enter" && add(scan);

  async function queueOffline() {
    await enqueue(
      "sale",
      {
        branch,
        customer: existing?.id ?? "",
        phone,
        cust_name: custName,
        nid,
        items: cart.map((c) => ({ item_id: c.item_id, price: c.price })),
        discount: Number(discount || 0),
        paid: saleType === "cash" ? total : Number(down || 0),
        method,
        sale_type: saleType,
        months: saleType === "installment" ? Number(months) : "",
        discount_reason: reason,
      },
      `Sale ${taka(total)} · ${cart.length} pcs${phone ? " · " + phone : ""}`,
    );
    toast.success("Offline — sale saved on this device and will sync when internet returns");
    setCart([]);
    setDiscount("0");
    setReason("");
    setDown("0");
    setPhone("");
    setCustName("");
    setNid("");
  }

  async function checkout() {
    setBusy(true);
    try {
      if (!navigator.onLine) {
        await queueOffline();
        return;
      }
      let customerId: string | null = existing?.id ?? null;
      if (!customerId && phone) {
        if (!custName) throw new Error("Customer name is required");
        const { data, error } = await supabase
          .from("customers")
          .insert({ branch_id: branch, name: custName, phone, nid: nid || null })
          .select("id")
          .single();
        if (error) throw error;
        customerId = data.id;
      }
      const { data: saleId, error } = await supabase.rpc("create_sale", {
        _branch: branch,
        _customer: customerId as string,
        _items: cart.map((c) => ({ item_id: c.item_id, price: c.price })),
        _discount: Number(discount || 0),
        _paid: saleType === "cash" ? total : Number(down || 0),
        _method: method,
        _sale_type: saleType,
        _months: saleType === "installment" ? Number(months) : (null as unknown as number),
        _discount_reason: reason,
      });
      if (error) throw error;
      toast.success("Sale completed");
      setCart([]);
      setDiscount("0");
      setReason("");
      setDown("0");
      setPhone("");
      setCustName("");
      setNid("");
      qc.invalidateQueries();
      if (saleId) navigate({ to: "/receipt/$saleId", params: { saleId } });
    } catch (e) {
      if (isNetworkError(e)) {
        await queueOffline();
        return;
      }
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <PageHeader title={t("POS")}>
        <BranchPicker
          value={branch}
          onChange={(v) => {
            setBranch(v);
            setCart([]);
          }}
        />
      </PageHeader>
      <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
        <div className="space-y-4">
          <div className="flex gap-2">
            <Input
              autoFocus
              className="h-12 bg-card font-mono text-lg"
              placeholder={t("Scan or type IMEI") + " ⏎"}
              value={scan}
              onChange={(e) => setScan(e.target.value)}
              onKeyDown={onKey}
              list="imei-list"
            />
            <ScanButton continuous onScan={add} />
          </div>
          <datalist id="imei-list">
            {stock.slice(0, 200).map((s) => (
              <option key={s.id} value={s.imei}>
                {productLabel(s.products)}
              </option>
            ))}
          </datalist>
          <Card className="divide-y">
            {cart.length === 0 && (
              <div className="p-10 text-center text-muted-foreground">
                {t("Cart")} is empty — scan an IMEI
              </div>
            )}
            {cart.map((c, i) => (
              <div key={c.item_id} className="flex items-center gap-4 p-4">
                <div className="flex-1">
                  <div className="font-medium">{c.label}</div>
                  <div className="font-mono text-xs text-muted-foreground">{c.imei}</div>
                </div>
                <Input
                  type="number"
                  className="w-32 text-right"
                  value={c.price}
                  onChange={(e) =>
                    setCart(
                      cart.map((x, j) => (j === i ? { ...x, price: Number(e.target.value) } : x)),
                    )
                  }
                />
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setCart(cart.filter((_, j) => j !== i))}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            ))}
          </Card>
          <p className="text-sm text-muted-foreground">
            {stock.length} phones in stock at this branch
          </p>
        </div>

        <Card className="h-fit space-y-4 p-5">
          <div className="grid grid-cols-2 gap-1 rounded-md bg-muted p-1">
            {(["cash", "installment"] as const).map((s) => (
              <button
                key={s}
                onClick={() => setSaleType(s)}
                className={`rounded py-1.5 text-sm font-medium ${saleType === s ? "bg-card shadow-sm" : "text-muted-foreground"}`}
              >
                {t(s === "cash" ? "Cash" : "Installment")}
              </button>
            ))}
          </div>
          <div className="space-y-2">
            <Label className="text-xs">
              {t("Customer")} {saleType === "installment" ? "(required)" : "(optional)"}
            </Label>
            <Input
              placeholder={t("Phone") + " 01XXXXXXXXX"}
              value={phone}
              onChange={(e) => setPhone(e.target.value.replace(/\D/g, ""))}
            />
            {existing ? (
              <div className="rounded-md bg-success/10 px-3 py-2 text-sm">
                {existing.name} · existing customer
              </div>
            ) : phone ? (
              <>
                <Input
                  placeholder={t("Name")}
                  value={custName}
                  onChange={(e) => setCustName(e.target.value)}
                />
                {saleType === "installment" && (
                  <Input placeholder="NID" value={nid} onChange={(e) => setNid(e.target.value)} />
                )}
              </>
            ) : null}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label className="text-xs">{t("Discount")}</Label>
              <Input type="number" value={discount} onChange={(e) => setDiscount(e.target.value)} />
            </div>
            {Number(discount) > 0 && (
              <div className="col-span-full">
                <Label className="text-xs">Discount reason</Label>
                <Input
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="e.g. Eid campaign, loyal customer"
                />
              </div>
            )}
            <div>
              <Label className="text-xs">Method</Label>
              <Select value={method} onValueChange={setMethod}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {["cash", "bkash", "nagad", "card", "bank"].map((m) => (
                    <SelectItem key={m} value={m} className="capitalize">
                      {m}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          {saleType === "installment" && (
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label className="text-xs">Down payment</Label>
                <Input type="number" value={down} onChange={(e) => setDown(e.target.value)} />
              </div>
              <div>
                <Label className="text-xs">Months</Label>
                <Input
                  type="number"
                  min={1}
                  max={36}
                  value={months}
                  onChange={(e) => setMonths(e.target.value)}
                />
              </div>
            </div>
          )}
          <div className="space-y-1 border-t pt-3 text-sm tabular">
            <Row l="Subtotal" v={taka(subtotal)} />
            <Row l={t("Discount")} v={"− " + taka(discount)} />
            <Row l={t("Total")} v={taka(total)} big />
            {saleType === "installment" && (
              <Row l={`${months} × monthly`} v={taka(monthly.toFixed(2))} />
            )}
          </div>
          <Button
            size="lg"
            className="w-full"
            disabled={
              busy ||
              cart.length === 0 ||
              !canSell ||
              (saleType === "installment" && (!phone || financed <= 0))
            }
            onClick={checkout}
          >
            {t("Checkout")} · {taka(saleType === "cash" ? total : down)}
          </Button>
        </Card>
      </div>
    </div>
  );
}

function Row({ l, v, big }: { l: string; v: string; big?: boolean }) {
  return (
    <div
      className={`flex justify-between ${big ? "font-display text-xl font-semibold" : "text-muted-foreground"}`}
    >
      <span>{l}</span>
      <span>{v}</span>
    </div>
  );
}
