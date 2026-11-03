import { logoSrc } from "@/lib/brand";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { ArrowLeft, Printer } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { taka, useBranches, useSettings } from "@/lib/erp";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/_authenticated/kisti-receipt/$installmentId")({
  head: () => ({
    meta: [
      { title: "Kisti receipt — Dealer ERP" },
      { name: "description", content: "Printable money receipt for an installment collection." },
    ],
  }),
  component: KistiReceiptPage,
});

const FORMATS = {
  receipt: { name: "Receipt (80mm)", page: "80mm auto", width: "76mm" },
  voucher: { name: "Voucher (A5)", page: "A5", width: "100%" },
} as const;
type Fmt = keyof typeof FORMATS;

const BN: Record<string, string> = {
  "Kisti Money Receipt": "কিস্তি মানি রসিদ",
  "Money Receipt / Voucher": "মানি রসিদ / ভাউচার",
  "Doc no": "ক্রমিক নং",
  "Date & time": "তারিখ ও সময়",
  "Invoice no": "ইনভয়েস নং",
  Customer: "ক্রেতা",
  Phone: "ফোন",
  Branch: "শাখা",
  "Kisti no": "কিস্তি নং",
  "Due date": "নির্ধারিত তারিখ",
  Amount: "পরিমাণ",
  "Paid so far": "এ পর্যন্ত পরিশোধিত",
  "Remaining due": "বকেয়া",
  "Total kisti": "মোট কিস্তি",
  "Amount received": "গৃহীত অর্থ",
  "Received with thanks": "সধন্যবাদে গৃহীত হলো",
  Signature: "স্বাক্ষর",
  "Customer signature": "ক্রেতার স্বাক্ষর",
  "Authorised signature": "কর্তৃপক্ষের স্বাক্ষর",
  "Thank you for shopping with us.": "আমাদের সাথে কেনাকাটার জন্য ধন্যবাদ।",
  Printed: "প্রিন্টের সময়",
};

function KistiReceiptPage() {
  const { installmentId } = Route.useParams();
  const [fmt, setFmt] = useState<Fmt>("voucher");
  const [lang, setLang] = useState<"en" | "bn">("en");
  const { data: settings } = useSettings();
  const { data: branches = [] } = useBranches();

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
      else if (settings?.default_print_lang === "bn") setLang("bn");
    });
  }, [settings?.default_print_lang]);

  const chooseLang = async (l: "en" | "bn") => {
    setLang(l);
    const { data: u } = await supabase.auth.getUser();
    if (u.user) await supabase.from("profiles").update({ print_lang: l }).eq("id", u.user.id);
  };
  const T = (x: string) => (lang === "bn" ? (BN[x] ?? x) : x);

  const { data, isLoading } = useQuery({
    queryKey: ["kisti-print", installmentId],
    queryFn: async () => {
      const { data: inst, error } = await supabase
        .from("installments")
        .select(
          "*, installment_plans(months, monthly_amount, financed_amount, down_payment, sales(invoice_no, total, paid, payment_method, customers(name,phone,nid,address)))",
        )
        .eq("id", installmentId)
        .maybeSingle();
      if (error) throw error;
      return inst;
    },
  });

  if (isLoading) return <p className="p-8 text-sm text-muted-foreground">Loading receipt…</p>;
  const inst = data;
  if (!inst) return <p className="p-8 text-sm text-muted-foreground">This kisti was not found.</p>;

  const plan = inst.installment_plans;
  const sale = plan?.sales;
  const customer = sale?.customers;
  const branch = branches.find((b) => b.id === inst.branch_id);
  const due = Math.max(0, Number(inst.amount) - Number(inst.paid_amount));
  const f = FORMATS[fmt];
  const small = fmt === "receipt";
  const docNo = `KRC-${String(inst.seq).padStart(3, "0")}-${String(inst.id).slice(0, 6).toUpperCase()}`;
  const when = new Date(inst.paid_at ?? inst.due_date).toLocaleString(
    lang === "bn" ? "bn-BD" : "en-GB",
    { dateStyle: "medium", timeStyle: "medium" },
  );
  const method = sale?.payment_method ?? "cash";
  const collected = Number(inst.paid_amount);

  const Header = (
    <div
      className={`flex items-center gap-3 ${small ? "flex-col text-center" : "border-b-2 border-foreground pb-3"}`}
    >
      <img src={logoSrc(settings?.logo_url)} alt="" className={small ? "h-10" : "h-16"} />
      <div className={small ? "" : "flex-1"}>
        <div className={small ? "text-base font-bold" : "text-2xl font-bold"}>
          {settings?.company_name ?? "Dealer ERP"}
        </div>
        {settings?.tagline && <div className="text-xs">{settings.tagline}</div>}
        <div className="text-xs">
          {branch?.name}
          {branch?.address ? `, ${branch.address}` : ""}
        </div>
        <div className="text-xs">
          {[branch?.phone, settings?.phone].filter(Boolean).join(" · ")}
        </div>
      </div>
    </div>
  );

  const Rows = (
    <table className="w-full text-xs">
      <tbody>
        {(
          [
            ["Invoice no", sale?.invoice_no ?? "—"],
            ["Customer", customer?.name ?? "—"],
            ["Phone", customer?.phone ?? "—"],
            ["Kisti no", `${inst.seq} of ${plan?.months ?? "?"}`],
            ["Due date", inst.due_date],
            ["Amount", taka(inst.amount)],
            ["Paid so far", taka(collected)],
            ["Remaining due", taka(due)],
          ] as [string, string][]
        ).map(([k, v]) => (
          <tr key={k} className="border-b border-dashed">
            <td className="py-1 pr-2 text-muted-foreground">{T(k)}</td>
            <td className="py-1 text-right font-medium tabular">{v}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );

  return (
    <div>
      <style>{`@media print { @page { size: ${f.page}; margin: ${small ? "3mm" : "12mm"}; } }`}</style>
      <div className="mb-4 flex flex-wrap items-center gap-2 print:hidden">
        <Button variant="ghost" asChild>
          <Link to="/installments">
            <ArrowLeft className="mr-1 h-4 w-4" /> Installments
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
          maxWidth: small ? undefined : "148mm",
        }}
      >
        {Header}
        <div className="my-2 text-center text-sm font-bold uppercase tracking-wide">
          {T(fmt === "receipt" ? "Kisti Money Receipt" : "Money Receipt / Voucher")}
        </div>
        <div className="my-2 flex justify-between text-xs">
          <span>
            <b>{T("Doc no")}:</b> <span className="font-mono">{docNo}</span>
          </span>
          <span>
            <b>{T("Date & time")}:</b> {when}
          </span>
        </div>
        {Rows}
        <p className="mt-4 text-sm">
          {lang === "bn" ? (
            <>
              জনাব <b>{customer?.name ?? "—"}</b> এর নিকট হতে <b>{taka(collected)}</b> {method}{" "}
              মাধ্যমে <b>{sale?.invoice_no ?? ""}</b> বাবদ <b>{inst.seq}</b> নং কিস্তির জন্য
              সধন্যবাদে গৃহীত হলো।
            </>
          ) : (
            <>
              {T("Received with thanks")} from <b>{customer?.name ?? "—"}</b> the sum of{" "}
              <b>{taka(collected)}</b> by {method} against {sale?.invoice_no ?? ""} for kisti no.{" "}
              {inst.seq}.
            </>
          )}
        </p>
        <div className="mt-2 text-xs tabular">
          <div className="flex justify-between border-t border-foreground pt-1 font-bold">
            <span>{T("Amount received")}</span>
            <span>{taka(collected)}</span>
          </div>
          <div className="flex justify-between">
            <span>{T("Remaining due")}</span>
            <span>{taka(due)}</span>
          </div>
        </div>
        {!small && (
          <div className="mt-12 flex justify-between text-xs">
            <div className="w-40 border-t border-foreground pt-1 text-center">
              {T("Customer signature")}
            </div>
            <div className="w-40 border-t border-foreground pt-1 text-center">
              {T("Authorised signature")}
            </div>
          </div>
        )}
        {settings?.invoice_footer && (
          <div className="mt-4 border-t pt-2 text-center text-xs whitespace-pre-line">
            {settings.invoice_footer}
          </div>
        )}
        <div className="mt-2 text-center text-[9px] text-muted-foreground">
          {T("Thank you for shopping with us.")}
        </div>
      </div>
    </div>
  );
}
