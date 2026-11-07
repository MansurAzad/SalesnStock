import { createFileRoute, Link } from "@tanstack/react-router";
import { Printer } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { BranchPicker, PageHeader } from "@/components/BranchPicker";
import { productLabel, taka, useBranches, useMe } from "@/lib/erp";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useT } from "@/lib/i18n";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
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
import { PAYMENT_METHODS } from "@/lib/payment-methods";

export const Route = createFileRoute("/_authenticated/sales")({
  head: () => ({ meta: [{ title: "Sales — Dealer ERP" }] }),
  component: Sales,
});

function Sales() {
  const { t } = useT();
  const [branch, setBranch] = useState("");
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState("any");
  const [statusFilter, setStatusFilter] = useState("any");
  const [period, setPeriod] = useState("30");
  const { data: branches = [] } = useBranches();
  const { data = [], error } = useQuery({
    queryKey: ["sales", branch, period],
    enabled: !!branch,
    queryFn: async () => {
      let q = supabase
        .from("sales")
        .select(
          "*, customers(name,phone), sale_items(price, inventory_items(imei, products(brand,model,variant)))",
        )
        .order("created_at", { ascending: false });
      if (branch !== "all") q = q.eq("branch_id", branch);
      if (period !== "all") {
        const days = Number(period);
        if (Number.isFinite(days) && days > 0) {
          q = q.gte("created_at", new Date(Date.now() - days * 86400000).toISOString());
        }
      }
      return fetchAllPages(q);
    },
  });
  const { data: me } = useMe();
  const qc = useQueryClient();
  const canReturn = (s: { branch_id: string }) =>
    !!me &&
    (me.canWriteHq || (me.branch_id === s.branch_id && me.roles.includes("branch_manager")));
  async function doReturn(id: string, inv: string, saleMethod: string) {
    const reason = window.prompt(
      `Return sale ${inv}? Stock goes back and a refund is recorded. Reason:`,
    );
    if (!reason?.trim()) return;
    const m = window.prompt(`Refund method (${PAYMENT_METHODS.join(", ")})`, saleMethod || "cash");
    if (m === null) return;
    const method = m.trim().toLowerCase();
    if (!(PAYMENT_METHODS as readonly string[]).includes(method)) {
      toast.error("Unknown payment method");
      return;
    }
    const { error } = await supabase.rpc("return_sale", {
      _sale: id,
      _reason: reason.trim(),
      _method: method,
    });
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Sale returned");
    qc.invalidateQueries();
  }
  const bname = (id: string) => branches.find((b) => b.id === id)?.name ?? "";
  const shown = data.filter((s) => {
    const text = [
      s.invoice_no,
      s.customers?.name,
      s.customers?.phone,
      ...s.sale_items.flatMap((i) => [
        i.inventory_items?.imei,
        productLabel(i.inventory_items?.products),
      ]),
    ]
      .join(" ")
      .toLowerCase();
    return (
      (!search || text.includes(search.toLowerCase())) &&
      (typeFilter === "any" || s.sale_type === typeFilter) &&
      (statusFilter === "any" || s.status === statusFilter)
    );
  });
  return (
    <div>
      <PageHeader title={t("Sales")}>
        <BranchPicker value={branch} onChange={setBranch} allowAll />
      </PageHeader>
      <div className="mb-3 flex flex-wrap gap-2">
        <Input
          className="max-w-sm bg-card"
          placeholder="Search invoice, customer, phone, model or IMEI"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <Select value={typeFilter} onValueChange={setTypeFilter}>
          <SelectTrigger className="w-40 bg-card">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="any">All sale types</SelectItem>
            <SelectItem value="cash">Cash</SelectItem>
            <SelectItem value="installment">Installment</SelectItem>
          </SelectContent>
        </Select>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-40 bg-card">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="any">All statuses</SelectItem>
            <SelectItem value="completed">Completed</SelectItem>
            <SelectItem value="returned">Returned</SelectItem>
          </SelectContent>
        </Select>
        <Select value={period} onValueChange={setPeriod}>
          <SelectTrigger className="w-40 bg-card">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="7">Last 7 days</SelectItem>
            <SelectItem value="30">Last 30 days</SelectItem>
            <SelectItem value="90">Last 90 days</SelectItem>
            <SelectItem value="all">All time</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {error && (
        <p
          role="alert"
          className="mb-3 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
        >
          Could not load sales: {error.message}
        </p>
      )}
      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Invoice</TableHead>
              <TableHead>{t("Date")}</TableHead>
              <TableHead>{t("Branch")}</TableHead>
              <TableHead>{t("Customer")}</TableHead>
              <TableHead>Items</TableHead>
              <TableHead>Type</TableHead>
              <TableHead className="text-right">{t("Total")}</TableHead>
              <TableHead className="text-right">{t("Paid")}</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {shown.map((s) => (
              <TableRow key={s.id}>
                <TableCell className="font-mono text-xs">{s.invoice_no}</TableCell>
                <TableCell>{new Date(s.created_at).toLocaleString()}</TableCell>
                <TableCell>{bname(s.branch_id)}</TableCell>
                <TableCell>
                  {s.customers && s.customer_id ? (
                    <>
                      <Link
                        to="/customers/$customerId"
                        params={{ customerId: s.customer_id }}
                        className="text-primary hover:underline"
                      >
                        {s.customers.name}
                      </Link>{" "}
                      <span className="tabular">{s.customers.phone}</span>
                    </>
                  ) : s.customers ? (
                    <>
                      {s.customers.name} <span className="tabular">{s.customers.phone}</span>
                    </>
                  ) : (
                    "Walk-in"
                  )}
                </TableCell>
                <TableCell className="text-xs">
                  {s.sale_items.map((i, k) => (
                    <div key={k}>
                      {productLabel(i.inventory_items?.products)}{" "}
                      <span className="font-mono text-muted-foreground">
                        {i.inventory_items?.imei}
                      </span>
                    </div>
                  ))}
                </TableCell>
                <TableCell>
                  <Badge variant="outline" className="capitalize">
                    {s.sale_type}
                  </Badge>
                  {s.status === "returned" && (
                    <Badge variant="destructive" className="ml-1">
                      Returned
                    </Badge>
                  )}
                  {Number(s.discount) > 0 && (
                    <div className="text-xs text-muted-foreground">
                      −{taka(s.discount)} {s.discount_reason}
                    </div>
                  )}
                </TableCell>
                <TableCell className="text-right tabular">{taka(s.total)}</TableCell>
                <TableCell className="text-right tabular">{taka(s.paid)}</TableCell>
                <TableCell>
                  <Link
                    to="/receipt/$saleId"
                    params={{ saleId: s.id }}
                    className="inline-flex items-center gap-1 text-sm text-primary"
                  >
                    <Printer className="h-4 w-4" /> Print
                  </Link>
                  {canReturn(s) && s.status !== "returned" && (
                    <button
                      className="ml-3 text-sm text-destructive"
                      onClick={() => doReturn(s.id, s.invoice_no, s.payment_method)}
                    >
                      Return
                    </button>
                  )}
                </TableCell>
              </TableRow>
            ))}
            {shown.length === 0 && (
              <TableRow>
                <TableCell colSpan={9} className="py-8 text-center text-muted-foreground">
                  {error
                    ? "Could not load sales."
                    : data.length
                      ? "No sales match these filters."
                      : "No sales yet."}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}
