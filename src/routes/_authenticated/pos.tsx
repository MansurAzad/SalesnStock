import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type KeyboardEvent } from "react";
import { toast } from "sonner";
import { enqueue, isNetworkError, offlineSoldIds, useOutbox } from "@/lib/offline";
import { supabase } from "@/integrations/supabase/client";
import { BranchPicker, PageHeader } from "@/components/BranchPicker";
import { productLabel, taka, useBranches, useMe } from "@/lib/erp";
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
import { matchesImei } from "@/lib/imei";
import { SALE_METHODS, methodLabel } from "@/lib/payment-methods";
import { fetchAllPages } from "@/lib/paginated-query";
import { useDebouncedValue } from "@/lib/use-debounced-value";
import { calculatePartnerFinancing } from "@/lib/partner-financing";

export const Route = createFileRoute("/_authenticated/pos")({
  head: () => ({ meta: [{ title: "POS — Dealer ERP" }] }),
  component: POS,
});

type CartLine = {
  item_id: string;
  imei: string;
  label: string;
  price: number;
  list_price: number;
  cost: number;
};

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
  const [financePartner, setFinancePartner] = useState("");
  const [payerName, setPayerName] = useState("");
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

  const box = useOutbox(me?.id);
  const { data: allStock = [] } = useQuery({
    queryKey: ["inventory", branch, "in_stock", "pos"],
    enabled: !!branch,
    queryFn: async () => {
      return fetchAllPages(
        supabase
          .from("inventory_items")
          .select("id,imei,imei2,purchase_price,products(brand,model,variant,sale_price)")
          .eq("branch_id", branch)
          .eq("status", "in_stock"),
      );
    },
  });
  const { data: branches = [] } = useBranches();
  const { data: financePartners = [] } = useQuery({
    queryKey: ["finance-partners-active"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("finance_partners")
        .select("id,name")
        .eq("active", true)
        .order("name");
      if (error) throw error;
      return data ?? [];
    },
  });
  const maxDiscountPct = Number(branches.find((b) => b.id === branch)?.max_discount_pct ?? 0);

  const soldOffline = offlineSoldIds(box.ops);
  const stock = allStock.filter((i) => !soldOffline.has(i.id));

  const debouncedPhone = useDebouncedValue(phone, 400);
  const { data: existing } = useQuery({
    queryKey: ["customer-phone", branch, debouncedPhone],
    enabled: !!branch && debouncedPhone.length === 11,
    queryFn: async () => {
      // customers.phone is not unique, so take the first match instead of
      // maybeSingle() which errors out when duplicates exist.
      const { data } = await supabase
        .from("customers")
        .select("id,name,phone")
        .eq("branch_id", branch)
        .eq("phone", debouncedPhone)
        .order("created_at", { ascending: true })
        .limit(1);
      return data?.[0] ?? null;
    },
  });

  const num = (v: string) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  const subtotal = cart.reduce((a, c) => a + c.price, 0);
  const listSubtotal = cart.reduce((a, c) => a + c.list_price, 0);
  const cartCost = cart.reduce((a, c) => a + c.cost, 0);
  const baseDownPayment =
    saleType === "installment" ? Math.min(Math.max(num(down), 0), subtotal) : 0;
  const discountAmount = Math.min(
    Math.max(num(discount), 0),
    saleType === "installment" ? baseDownPayment : subtotal,
  );
  const partnerAmounts =
    saleType === "installment" && baseDownPayment > 0 && baseDownPayment < subtotal
      ? calculatePartnerFinancing(subtotal, baseDownPayment, discountAmount)
      : null;
  const total = partnerAmounts?.netSaleTotal ?? Math.max(0, subtotal - discountAmount);
  // The server measures the discount against the catalogue price, so an edited line price
  // counts as a discount too and needs a reason.
  const effectiveDiscount = Math.max(listSubtotal - total, 0);
  // The server asks for a reason for any discount, and also when the total falls
  // below what the shop paid for the handsets.
  const belowCost = cart.length > 0 && total < cartCost;
  const needsReason = discountAmount > 0 || effectiveDiscount > 0 || belowCost;
  // …and above the branch limit the sale has to be approved by a manager.
  const discountLimit =
    Math.round((saleType === "installment" ? baseDownPayment : listSubtotal) * maxDiscountPct) /
    100;
  const needsApproval = effectiveDiscount > discountLimit || belowCost;
  const canApprove =
    !!me && (me.canWriteHq || (me.branch_id === branch && me.roles.includes("branch_manager")));
  const downPayment =
    partnerAmounts?.customerDownPayment ??
    (saleType === "installment" ? baseDownPayment - discountAmount : 0);
  const financed =
    partnerAmounts?.partnerReceivable ??
    (saleType === "installment" ? Math.max(0, subtotal - baseDownPayment) : 0);

  function add(imei: string) {
    const it = stock.find((s) => matchesImei(s.imei, imei) || matchesImei(s.imei2, imei));
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
              list_price: Number(it.products?.sale_price ?? 0),
              cost: Number(it.purchase_price ?? 0),
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
        discount: discountAmount,
        paid: saleType === "cash" ? total : downPayment,
        method,
        sale_type: saleType,
        months: "",
        discount_reason: reason.trim(),
      },
      `Sale ${taka(total)} · ${cart.length} pcs${phone ? " · " + phone : ""}`,
      me?.id,
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
        if (saleType === "installment") {
          throw new Error(
            "Partner-financed sales require an internet connection. Please reconnect before checkout.",
          );
        }
        await queueOffline();
        return;
      }
      let customerId: string | null = existing?.id ?? null;
      if (!customerId && phone) {
        // Re-check server-side: the debounced lookup may not have resolved yet.
        const { data: dup } = await supabase
          .from("customers")
          .select("id")
          .eq("branch_id", branch)
          .eq("phone", phone)
          .order("created_at", { ascending: true })
          .limit(1);
        customerId = dup?.[0]?.id ?? null;
      }
      if (!customerId && phone) {
        if (!custName.trim()) throw new Error("Customer name is required");
        const { data, error } = await supabase
          .from("customers")
          .insert({ branch_id: branch, name: custName.trim(), phone, nid: nid || null })
          .select("id")
          .single();
        if (error) throw error;
        customerId = data.id;
      }
      const saleArgs = {
        _branch: branch,
        _customer: customerId as string,
        _items: cart.map((c) => ({ item_id: c.item_id, price: c.price })),
        _discount: discountAmount,
        _paid: saleType === "cash" ? total : downPayment,
        _method: method,
        _sale_type: saleType,
        _months: null as unknown as number,
        _discount_reason: reason.trim(),
      };
      const { data: saleId, error } =
        saleType === "installment"
          ? await supabase.rpc("create_partner_financed_sale", {
              _branch: branch,
              _customer: customerId as string,
              _items: cart.map((c) => ({ item_id: c.item_id, price: c.price })),
              _down_payment: baseDownPayment,
              _down_payment_discount: discountAmount,
              _method: method,
              _partner: financePartner,
              _payer_name: payerName.trim() || null,
              _ref: null,
              _discount_reason: reason.trim(),
            })
          : await supabase.rpc("create_sale", saleArgs);
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
      if (isNetworkError(e) && saleType === "cash") {
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
                  min={0}
                  aria-label={`Price for ${c.label}`}
                  className="w-32 text-right"
                  value={c.price}
                  onChange={(e) =>
                    setCart((prev) =>
                      prev.map((x, j) =>
                        j === i ? { ...x, price: Math.max(0, Number(e.target.value) || 0) } : x,
                      ),
                    )
                  }
                />
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove ${c.label} from cart`}
                  onClick={() => setCart((prev) => prev.filter((_, j) => j !== i))}
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
                aria-pressed={saleType === s}
                className={`rounded py-1.5 text-sm font-medium ${saleType === s ? "bg-card shadow-sm" : "text-muted-foreground"}`}
              >
                {s === "cash" ? t("Cash") : "Partner finance"}
              </button>
            ))}
          </div>
          <div className="space-y-2">
            <Label className="text-xs">
              {t("Customer")} {saleType === "installment" ? "(required)" : "(optional)"}
            </Label>
            <Input
              placeholder={t("Phone") + " 01XXXXXXXXX"}
              inputMode="numeric"
              maxLength={11}
              value={phone}
              onChange={(e) => setPhone(e.target.value.replace(/\D/g, "").slice(0, 11))}
              aria-invalid={phone.length > 0 && !/^01\d{9}$/.test(phone)}
            />
            {phone.length > 0 && !/^01\d{9}$/.test(phone) && (
              <p className="text-xs text-destructive">Phone must be 11 digits starting with 01.</p>
            )}
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
              <Label className="text-xs" htmlFor="pos-discount">
                {saleType === "installment" ? "Down payment discount" : t("Discount")}
              </Label>
              <Input
                id="pos-discount"
                type="number"
                min={0}
                value={discount}
                onChange={(e) => setDiscount(e.target.value)}
              />
            </div>
            {needsReason && (
              <div className="col-span-full">
                <Label className="text-xs" htmlFor="pos-reason">
                  Discount reason
                </Label>
                <Input
                  id="pos-reason"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="e.g. Eid campaign, loyal customer"
                />
                {belowCost && (
                  <p className="mt-1 text-xs text-destructive">
                    This price is below what the shop paid ({taka(cartCost)}) — a reason is
                    required.
                  </p>
                )}
              </div>
            )}
            <div>
              <Label className="text-xs" htmlFor="pos-method">
                Method
              </Label>
              <Select value={method} onValueChange={setMethod}>
                <SelectTrigger id="pos-method">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SALE_METHODS.map((m) => (
                    <SelectItem key={m} value={m}>
                      {methodLabel(m)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          {saleType === "installment" && (
            <div className="space-y-2">
              <div>
                <Label className="text-xs">Financial partner</Label>
                <Select value={financePartner} onValueChange={setFinancePartner}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select financial partner" />
                  </SelectTrigger>
                  <SelectContent>
                    {financePartners.map((partner) => (
                      <SelectItem key={partner.id} value={partner.id}>
                        {partner.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-xs">Payment sender / settlement brand (optional)</Label>
                <Input
                  value={payerName}
                  onChange={(e) => setPayerName(e.target.value)}
                  placeholder="If payment comes under another brand"
                />
              </div>
              <div>
                <Label className="text-xs" htmlFor="pos-down">
                  Down payment
                </Label>
                <Input
                  id="pos-down"
                  type="number"
                  min={0}
                  value={down}
                  onChange={(e) => setDown(e.target.value)}
                />
              </div>
            </div>
          )}
          <div className="space-y-1 border-t pt-3 text-sm tabular">
            <Row l="Subtotal" v={taka(listSubtotal)} />
            {effectiveDiscount > discountAmount && (
              <Row l="Price adjustment" v={"− " + taka(effectiveDiscount - discountAmount)} />
            )}
            <Row
              l={saleType === "installment" ? "Down payment discount" : t("Discount")}
              v={"− " + taka(discountAmount)}
            />
            <Row l={t("Total")} v={taka(total)} big />
            {saleType === "installment" && (
              <>
                <Row l="Actual down payment received" v={taka(downPayment)} />
                <Row l="Receivable from financial partner" v={taka(financed)} />
              </>
            )}
          </div>
          <Button
            size="lg"
            className="w-full"
            disabled={
              busy ||
              cart.length === 0 ||
              !canSell ||
              (needsReason && !reason.trim()) ||
              (needsApproval && !canApprove) ||
              (saleType === "installment" &&
                (!/^01\d{9}$/.test(phone) ||
                  financed <= 0 ||
                  downPayment <= 0 ||
                  !financePartner ||
                  (!existing && !custName.trim())))
            }
            onClick={checkout}
          >
            {t("Checkout")} · {taka(saleType === "cash" ? total : downPayment)}
          </Button>
          {!canSell && (
            <p className="text-xs text-muted-foreground">
              Your account cannot sell at this branch — ask the admin for a sales role.
            </p>
          )}
          {canSell && needsApproval && !canApprove && (
            <p className="text-xs text-destructive">
              This discount is above the {maxDiscountPct}% limit of this showroom — a branch manager
              has to complete the sale.
            </p>
          )}
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
