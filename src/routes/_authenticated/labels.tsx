import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Printer } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { BranchPicker, PageHeader } from "@/components/BranchPicker";
import { ScanButton } from "@/components/BarcodeScanner";
import { productLabel, taka, useSettings } from "@/lib/erp";
import { useT } from "@/lib/i18n";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { fetchAllPages } from "@/lib/paginated-query";

export const Route = createFileRoute("/_authenticated/labels")({
  head: () => ({ meta: [{ title: "Barcode labels — Dealer ERP" }, { name: "description", content: "Print IMEI barcode labels for phones in stock." }] }),
  component: Labels,
});

const sizes: Record<string, { w: string; h: string; name: string }> = {
  small: { w: "38mm", h: "25mm", name: "38 × 25 mm" },
  medium: { w: "50mm", h: "30mm", name: "50 × 30 mm" },
  large: { w: "70mm", h: "40mm", name: "70 × 40 mm" },
};

function Bar({ value, height }: { value: string; height: number }) {
  const ref = useRef<SVGSVGElement>(null);
  useEffect(() => {
    import("jsbarcode").then(({ default: JsBarcode }) => {
      if (ref.current) JsBarcode(ref.current, value, { format: "CODE128", width: 1.4, height, fontSize: 11, margin: 0, displayValue: true });
    });
  }, [value, height]);
  return <svg ref={ref} className="h-auto max-w-full" />;
}

function Labels() {
  const { t } = useT();
  const { data: settings } = useSettings();
  const [branch, setBranch] = useState("");
  const [q, setQ] = useState("");
  const [size, setSize] = useState("medium");
  const [showPrice, setShowPrice] = useState(true);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const { data: items = [] } = useQuery({
    queryKey: ["inventory", branch, "in_stock", "labels"],
    enabled: !!branch,
    queryFn: async () => {
      let qq = supabase.from("inventory_items").select("id,imei,products(brand,model,variant,sale_price)").eq("status", "in_stock").order("created_at", { ascending: false });
      if (branch !== "all") qq = qq.eq("branch_id", branch);
      return fetchAllPages(qq);
    },
  });
  const shown = items.filter((i) => !q || i.imei.includes(q) || productLabel(i.products).toLowerCase().includes(q.toLowerCase()));
  const chosen = items.filter((i) => sel.has(i.id));
  const sz = sizes[size] ?? sizes["medium"]!;
  const toggle = (id: string) => setSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  return (
    <div>
      <div className="print:hidden">
        <PageHeader title={t("Labels")}>
          <BranchPicker value={branch} onChange={(v) => { setBranch(v); setSel(new Set()); }} allowAll />
          <Select value={size} onValueChange={setSize}>
            <SelectTrigger className="w-36 bg-card"><SelectValue /></SelectTrigger>
            <SelectContent>{Object.entries(sizes).map(([k, v]) => <SelectItem key={k} value={k}>{v.name}</SelectItem>)}</SelectContent>
          </Select>
          <label className="flex items-center gap-2 text-sm"><Checkbox checked={showPrice} onCheckedChange={(v) => setShowPrice(!!v)} /> Price</label>
          <Button disabled={!chosen.length} onClick={() => window.print()}><Printer className="mr-1 h-4 w-4" /> Print {chosen.length || ""}</Button>
        </PageHeader>
        <div className="mb-3 flex gap-2">
          <Input className="max-w-xs bg-card" placeholder={t("Search") + " IMEI / model"} value={q} onChange={(e) => setQ(e.target.value)} />
          <ScanButton continuous onScan={(c) => { const hit = items.find((i) => i.imei === c); if (hit) setSel((s) => new Set(s).add(hit.id)); }} />
          <Button variant="outline" onClick={() => setSel(new Set(shown.map((i) => i.id)))}>Select all shown</Button>
          <Button variant="ghost" onClick={() => setSel(new Set())}>Clear</Button>
        </div>
        <Card className="max-h-[45vh] divide-y overflow-auto">
          {shown.map((i) => (
            <label key={i.id} className="flex cursor-pointer items-center gap-3 px-4 py-2 text-sm">
              <Checkbox checked={sel.has(i.id)} onCheckedChange={() => toggle(i.id)} />
              <span className="flex-1">{productLabel(i.products)}</span>
              <span className="font-mono text-xs">{i.imei}</span>
            </label>
          ))}
          {!shown.length && <div className="p-8 text-center text-muted-foreground">No phones in stock.</div>}
        </Card>
        {chosen.length > 0 && <h3 className="mb-2 mt-6 font-medium">Preview</h3>}
      </div>
      <div className="flex flex-wrap gap-2 print:gap-0">
        {chosen.map((i) => (
          <div key={i.id} style={{ width: sz.w, height: sz.h }} className="flex break-inside-avoid flex-col items-center justify-center overflow-hidden border bg-card p-1 text-center text-card-foreground print:border-dashed">
            <div className="w-full truncate text-[8px] font-semibold uppercase">{settings?.company_name}</div>
            <div className="w-full truncate text-[9px]">{productLabel(i.products)}</div>
            <Bar value={i.imei} height={size === "small" ? 28 : size === "large" ? 50 : 36} />
            {showPrice && <div className="text-[10px] font-bold">{taka(i.products?.sale_price)}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}
