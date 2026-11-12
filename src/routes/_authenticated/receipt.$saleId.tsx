import { logoSrc } from "@/lib/brand";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { ArrowLeft, Printer } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { productLabel, taka, useBranches, useSettings } from "@/lib/erp";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/_authenticated/receipt/$saleId")({
  head: () => ({
    meta: [
      { title: "Print sale — Dealer ERP" },
      { name: "description", content: "Printable receipt, voucher, invoice and pad." },
    ],
  }),
  component: ReceiptPage,
});

const FORMATS = {
  receipt: { name: "Receipt (80mm)", page: "80mm auto", width: "76mm" },
  voucher: { name: "Voucher (A5)", page: "A5", width: "100%" },
  invoice: { name: "Invoice (A4)", page: "A4", width: "100%" },
  pad: { name: "Pad (A4)", page: "A4", width: "100%" },
} as const;
type Fmt = keyof typeof FORMATS;
const PREFIX: Record<string, string> = {
  receipt: "RCP",
  voucher: "VCH",
  invoice: "INV",
  pad: "PAD",
};
const BN: Record<string, string> = {
  "Sales Receipt": "বিক্রয় রসিদ",
  "Money Receipt / Voucher": "মানি রসিদ / ভাউচার",
  Invoice: "ইনভয়েস",
  Pad: "প্যাড",
  "Doc no": "ক্রমিক নং",
  "Invoice no": "ইনভয়েস নং",
  "Date & time": "তারিখ ও সময়",
  Type: "ধরন",
  "Cash sale": "নগদ বিক্রয়",
  "Kisti (installment)": "পার্টনার ফাইন্যান্স বিক্রয়",
  Customer: "ক্রেতা",
  Phone: "ফোন",
  NID: "এনআইডি",
  Address: "ঠিকানা",
  "Walk-in": "সাধারণ ক্রেতা",
  "Walk-in customer": "সাধারণ ক্রেতা",
  "Item / IMEI": "পণ্য / IMEI",
  Price: "মূল্য",
  Subtotal: "উপমোট",
  Discount: "ছাড়",
  Total: "সর্বমোট",
  Paid: "পরিশোধিত",
  "Down payment": "ডাউন পেমেন্ট",
  "Financed (kisti)": "কিস্তিতে বাকি",
  Due: "বকেয়া",
  "Partner receivable": "ফাইন্যান্স পার্টনারের পাওনা",
  "Financial partner": "ফাইন্যান্স পার্টনার",
  "Kisti schedule": "কিস্তির তালিকা",
  "Due date": "নির্ধারিত তারিখ",
  Amount: "পরিমাণ",
  Signature: "স্বাক্ষর",
  "Customer signature": "ক্রেতার স্বাক্ষর",
  "Authorised signature": "কর্তৃপক্ষের স্বাক্ষর",
  "Thank you for shopping with us.": "আমাদের সাথে কেনাকাটার জন্য ধন্যবাদ।",
  To: "প্রতি",
  Printed: "প্রিন্টের সময়",
};

function ReceiptPage() {
  const { saleId } = Route.useParams();
  const [fmt, setFmt] = useState<Fmt>("invoice");
  const [lang, setLang] = useState<"en" | "bn">("en");
  const { data: s } = useSettings();
  useEffect(() => {
    void (async () => {
      const { data: u } = await supabase.auth.getUser();
      if (!u.user) return;
      const { data: p } = await supabase
        .from("profiles")
        .select("print_lang")
        .eq("id", u.user.id)
        .maybeSingle();
      if (p?.print_lang === "en" || p?.print_lang === "bn") setLang(p.print_lang);
      else if (s?.default_print_lang === "bn") setLang("bn");
    })();
  }, [s?.default_print_lang]);
  const chooseLang = async (l: "en" | "bn") => {
    setLang(l);
    const { data: u } = await supabase.auth.getUser();
    if (u.user) await supabase.from("profiles").update({ print_lang: l }).eq("id", u.user.id);
  };
  const T = (x: string) => (lang === "bn" ? (BN[x] ?? x) : x);
  const { data: branches = [] } = useBranches();
  const { data, isLoading } = useQuery({
    queryKey: ["sale-print", saleId],
    queryFn: async () => {
      const { data: sale, error } = await supabase
        .from("sales")
        .select(
          "*, customers(name,phone,nid,address), sale_items(id, price, inventory_items(imei, imei2, products(brand,model,variant)))",
        )
        .eq("id", saleId)
        .maybeSingle();
      if (error) throw error;
      const { data: financeCase } = await supabase
        .from("finance_cases")
        .select("amount, payer_name, finance_partners(name)")
        .eq("sale_id", saleId)
        .maybeSingle();
      return { sale, financeCase };
    },
  });
  if (isLoading) return <p className="p-8 text-sm text-muted-foreground">Loading receipt…</p>;
  const sale = data?.sale;
  if (!sale) return <p>Sale not found.</p>;
  const financeCase = data?.financeCase;
  const branch = branches.find((b) => b.id === sale.branch_id);
  const due = Number(sale.total) - Number(sale.paid);
  const f = FORMATS[fmt];
  const small = fmt === "receipt";
  const docTitle = T(
    { receipt: "Sales Receipt", voucher: "Money Receipt / Voucher", invoice: "Invoice", pad: "" }[
      fmt
    ],
  );
  const docNo = `${PREFIX[fmt]}-${String(sale.seq_no ?? 0).padStart(6, "0")}`;
  const when = new Date(sale.created_at).toLocaleString(lang === "bn" ? "bn-BD" : "en-GB", {
    dateStyle: "medium",
    timeStyle: "medium",
  });
  const Meta = (
    <div className="my-2 flex justify-between text-xs">
      <span>
        <b>{T("Doc no")}:</b> <span className="font-mono">{docNo}</span>
      </span>
      <span>
        <b>{T("Date & time")}:</b> {when}
      </span>
    </div>
  );

  const Header = (
    <div
      className={`flex items-center gap-3 ${small ? "flex-col text-center" : "border-b-2 border-foreground pb-3"}`}
    >
      {<img src={logoSrc(s?.logo_url)} alt="" className={small ? "h-7 max-w-[72px] object-contain" : "h-8 max-w-[100px] object-contain"} />}
      <div className={small ? "" : "flex-1"}>
        <div className={small ? "text-base font-bold" : "text-2xl font-bold"}>
          {s?.company_name ?? "Dealer ERP"}
        </div>
        {s?.tagline && <div className="text-xs">{s.tagline}</div>}
        <div className="text-xs">
          {branch?.name}
          {branch?.address ? `, ${branch.address}` : ""}
        </div>
        <div className="text-xs">
          {[branch?.phone, s?.phone].filter(Boolean).join(" · ")}
          {s?.address && !small ? ` · ${s.address}` : ""}
        </div>
      </div>
    </div>
  );

  const Info = (
    <div className={`my-3 grid gap-1 text-xs ${small ? "" : "grid-cols-2"}`}>
      <div>
        <div>
          <b>{T("Invoice no")}:</b> {sale.invoice_no}
        </div>
        <div>
          <b>{T("Type")}:</b> {T(sale.sale_type === "cash" ? "Cash sale" : "Kisti (installment)")} · {sale.payment_method}
        </div>
        {financeCase?.finance_partners?.name && (
          <div><b>{T("Financial partner")}:</b> {financeCase.finance_partners.name}</div>
        )}
      </div>
      <div className={small ? "" : "text-right"}>
        <div>
          <b>{T("Customer")}:</b> {sale.customers?.name ?? T("Walk-in")}
        </div>
        {sale.customers?.phone && (
          <div>
            <b>{T("Phone")}:</b> {sale.customers.phone}
          </div>
        )}
        {sale.customers?.nid && (
          <div>
            <b>{T("NID")}:</b> {sale.customers.nid}
          </div>
        )}
        {sale.customers?.address && (
          <div>
            <b>{T("Address")}:</b> {sale.customers.address}
          </div>
        )}
      </div>
    </div>
  );

  const Items = (
    <table className="w-full text-xs">
      <thead>
        <tr className="border-y border-foreground text-left">
          <th className="py-1">#</th>
          <th>{T("Item / IMEI")}</th>
          <th className="text-right">{T("Price")}</th>
        </tr>
      </thead>
      <tbody>
        {sale.sale_items.map((i, k) => (
          <tr key={i.id ?? k} className="border-b border-dashed align-top">
            <td className="py-1 pr-1">{k + 1}</td>
            <td>
              {productLabel(i.inventory_items?.products)}
              <div className="font-mono text-[10px]">
                IMEI: {i.inventory_items?.imei}
                {i.inventory_items?.imei2 ? ` / ${i.inventory_items.imei2}` : ""}
              </div>
            </td>
            <td className="text-right tabular">{taka(i.price)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );

  const Pay = (
    <div className={`mt-2 text-xs tabular ${small ? "" : "ml-auto w-64"}`}>
      {[
        ["Subtotal", sale.subtotal],
        ["Discount", -Number(sale.discount)],
        ["Total", sale.total],
      ].map(([l, v]) => (
        <div
          key={String(l)}
          className={`flex justify-between ${l === "Total" ? "border-t border-foreground pt-1 font-bold" : ""}`}
        >
          <span>{T(String(l))}</span>
          <span>{taka(v as number)}</span>
        </div>
      ))}
      <div className="flex justify-between">
        <span>
          {T(sale.sale_type === "cash" ? "Paid" : "Down payment")} ({sale.payment_method})
        </span>
        <span>{taka(sale.paid)}</span>
      </div>
      {due > 0 && (
        <div className="flex justify-between font-semibold">
          <span>{T(financeCase ? "Partner receivable" : "Due")}</span>
          <span>{taka(due)}</span>
        </div>
      )}
    </div>
  );

  const Sign = !small && (
    <div className="mt-12 flex justify-between text-xs">
      <div className="w-40 border-t border-foreground pt-1 text-center">
        {T("Customer signature")}
      </div>
      <div className="w-40 border-t border-foreground pt-1 text-center">
        {T("Authorised signature")}
      </div>
    </div>
  );

  return (
    <div>
      <style>{`@media print { @page { size: ${f.page}; margin: ${small ? "3mm" : "12mm"}; } }`}</style>
      <div className="mb-4 flex flex-wrap items-center gap-2 print:hidden">
        <Button variant="ghost" asChild>
          <Link to="/sales">
            <ArrowLeft className="mr-1 h-4 w-4" /> Sales
          </Link>
        </Button>
        {(Object.keys(FORMATS) as Fmt[]).map((k) => (
          <Button key={k} variant={fmt === k ? "default" : "outline"} onClick={() => setFmt(k)}>
            {FORMATS[k].name}
          </Button>
        ))}
        <div className="ml-auto flex rounded-md border p-0.5">
          {(["en", "bn"] as const).map((l) => (
            <Button
              key={l}
              size="sm"
              variant={lang === l ? "default" : "ghost"}
              onClick={() => chooseLang(l)}
            >
              {l === "en" ? "English" : "বাংলা"}
            </Button>
          ))}
        </div>
        <Button onClick={() => window.print()}>
          <Printer className="mr-1 h-4 w-4" /> Print
        </Button>
      </div>
      <div
        className="mx-auto bg-card p-6 text-card-foreground shadow print:p-0 print:shadow-none"
        style={{
          width: small ? f.width : undefined,
          maxWidth: small ? undefined : fmt === "voucher" ? "148mm" : "210mm",
        }}
      >
        {Header}
        {docTitle && (
          <div className="my-2 text-center text-sm font-bold uppercase tracking-wide">
            {docTitle}
          </div>
        )}
        {Meta}
        {fmt === "pad" ? (
          <>
            <div className="my-1 text-xs">
              {T("Invoice no")}: {sale.invoice_no}
            </div>
            <p className="text-xs">
              {T("To")}, <b>{sale.customers?.name ?? T("Walk-in customer")}</b>
              {sale.customers?.phone ? `, ${sale.customers.phone}` : ""}
            </p>
            <p className="my-3 text-xs">
              {lang === "bn"
                ? "এই মর্মে নিশ্চিত করা যাচ্ছে যে, নিম্নোক্ত হ্যান্ডসেট(সমূহ) আমাদের শোরুম থেকে ক্রয় করা হয়েছে।"
                : "This is to confirm the purchase of the following handset(s) from our showroom."}
            </p>
            {Items}
            {Pay}
            <div className="min-h-[60mm]" />
            {Sign}
          </>
        ) : fmt === "voucher" ? (
          <>
            {Info}
            <p className="text-sm">
              {lang === "bn" ? (
                <>
                  জনাব <b>{sale.customers?.name ?? T("Walk-in customer")}</b> এর নিকট হতে{" "}
                  {sale.invoice_no} বাবদ {sale.payment_method} মাধ্যমে <b>{taka(sale.paid)}</b>{" "}
                  সধন্যবাদে গৃহীত হলো।
                </>
              ) : (
                <>
                  Received with thanks from <b>{sale.customers?.name ?? T("Walk-in customer")}</b>{" "}
                  the sum of <b>{taka(sale.paid)}</b> by {sale.payment_method} against{" "}
                  {sale.invoice_no}.
                </>
              )}
            </p>
            {Items}
            {Pay}
            {Sign}
          </>
        ) : (
          <>
            {Info}
            {Items}
            {Pay}
            {Sign}
          </>
        )}
        {s?.invoice_footer && (
          <div
            className={`mt-4 border-t pt-2 text-center ${small ? "text-[10px]" : "text-xs"} whitespace-pre-line`}
          >
            {s.invoice_footer}
          </div>
        )}
        <div className="mt-2 text-center text-[9px] text-muted-foreground">
          {T("Thank you for shopping with us.")}
        </div>
      </div>
    </div>
  );
}
