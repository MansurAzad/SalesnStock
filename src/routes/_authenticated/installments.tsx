import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { enqueue, isNetworkError } from "@/lib/offline";
import { supabase } from "@/integrations/supabase/client";
import { BranchPicker, PageHeader } from "@/components/BranchPicker";
import { taka, useBranches, useMe } from "@/lib/erp";
import { useT } from "@/lib/i18n";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { fetchAllPages } from "@/lib/paginated-query";
import { localDate } from "@/lib/date";
import { COLLECTION_METHODS, methodLabel } from "@/lib/payment-methods";

export const Route = createFileRoute("/_authenticated/installments")({
  head: () => ({ meta: [{ title: "Installments — Dealer ERP" }] }),
  component: Installments,
});

function Installments() {
  const { t } = useT();
  const qc = useQueryClient();
  const { data: me } = useMe();
  const [branch, setBranch] = useState("");
  const [filter, setFilter] = useState<"due" | "upcoming" | "paid">("due");
  const [search, setSearch] = useState("");
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  // Which pocket the money came from matters to the day book: the drawer and
  // the wallet are counted separately, so a collection needs its own method.
  const [methods, setMethods] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const { data: branches = [] } = useBranches();
  const today = localDate();

  const { data = [], error } = useQuery({
    queryKey: ["installments", branch],
    enabled: !!branch,
    queryFn: async () => {
      let q = supabase
        .from("installments")
        .select(
          "*, installment_plans(customer_id, months, sales(invoice_no), customers(name,phone))",
        )
        .eq("cancelled", false)
        .order("due_date");
      if (branch !== "all") q = q.eq("branch_id", branch);
      return fetchAllPages(q);
    },
  });
  const rows = data
    .filter((r) => {
      const paid = Number(r.paid_amount) >= Number(r.amount);
      if (filter === "paid") return paid;
      if (paid) return false;
      return filter === "due" ? r.due_date <= today : r.due_date > today;
    })
    .filter(
      (r) =>
        !search ||
        `${r.installment_plans?.customers?.name ?? ""} ${r.installment_plans?.customers?.phone ?? ""} ${r.installment_plans?.sales?.invoice_no ?? ""}`
          .toLowerCase()
          .includes(search.toLowerCase()),
    );
  const bname = (id: string) => branches.find((b) => b.id === id)?.name ?? "";
  const canCollect = (rowBranch: string) =>
    !!me &&
    (me.canWriteHq ||
      (me.branch_id === rowBranch &&
        me.roles.some((r) => ["branch_manager", "sales", "accountant"].includes(r))));

  async function pay(id: string, due: number) {
    const raw = amounts[id];
    // An empty box means "collect the full due"; anything the cashier typed has
    // to be a real amount — 0 or a negative must never turn into a full collection.
    const typed = raw === undefined || raw.trim() === "" ? due : Number(raw);
    if (!Number.isFinite(typed) || typed <= 0) {
      toast.error("Enter an amount greater than zero");
      return;
    }
    const amt = Math.min(typed, due);
    const method = methods[id] ?? "cash";
    if (busy) return;
    setBusy(true);
    const offline = async () => {
      await enqueue("kisti", { inst: id, amount: amt, method }, `Kisti ${taka(amt)}`, me?.id);
      toast.success("Offline — collection saved and will sync when internet returns");
    };
    try {
      if (!navigator.onLine) {
        await offline();
        return;
      }
      const { error } = await supabase.rpc("pay_installment", {
        _inst: id,
        _amount: amt,
        _method: method,
      });
      if (error && isNetworkError(error)) {
        await offline();
        return;
      }
      if (error) {
        toast.error(error.message);
        return;
      }
      toast.success(`${taka(amt)} collected`);
      setAmounts((prev) => ({ ...prev, [id]: "" }));
      qc.invalidateQueries();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <PageHeader title={t("Installments")}>
        <BranchPicker value={branch} onChange={setBranch} allowAll />
      </PageHeader>
      <div className="mb-3 flex gap-1">
        {(["due", "upcoming", "paid"] as const).map((f) => (
          <Button
            key={f}
            size="sm"
            variant={filter === f ? "default" : "outline"}
            onClick={() => setFilter(f)}
            aria-pressed={filter === f}
            className="capitalize"
          >
            {f === "due" ? "Due / overdue" : f}
          </Button>
        ))}
      </div>
      <Input
        className="mb-3 max-w-sm bg-card"
        placeholder="Search customer, phone or invoice"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      {error && (
        <p
          role="alert"
          className="mb-3 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
        >
          Could not load installments: {error.message}
        </p>
      )}
      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("Customer")}</TableHead>
              <TableHead>Invoice</TableHead>
              <TableHead>{t("Branch")}</TableHead>
              <TableHead>#</TableHead>
              <TableHead>Due date</TableHead>
              <TableHead className="text-right">{t("Amount")}</TableHead>
              <TableHead className="text-right">{t("Due")}</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => {
              const due = Number(r.amount) - Number(r.paid_amount);
              const overdue = due > 0 && r.due_date < today;
              return (
                <TableRow key={r.id}>
                  <TableCell>
                    {r.installment_plans?.customer_id ? (
                      <Link
                        to="/customers/$customerId"
                        params={{ customerId: r.installment_plans.customer_id }}
                        className="text-primary hover:underline"
                      >
                        {r.installment_plans?.customers?.name}
                      </Link>
                    ) : (
                      r.installment_plans?.customers?.name
                    )}
                    <div className="text-xs text-muted-foreground">
                      {r.installment_plans?.customers?.phone}
                    </div>
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {r.installment_plans?.sales?.invoice_no}
                  </TableCell>
                  <TableCell>{bname(r.branch_id)}</TableCell>
                  <TableCell>
                    {r.seq}/{r.installment_plans?.months}
                  </TableCell>
                  <TableCell>
                    {r.due_date}{" "}
                    {overdue && (
                      <Badge variant="outline" className="ml-1 bg-destructive/15 text-destructive">
                        overdue
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular">{taka(r.amount)}</TableCell>
                  <TableCell className="text-right tabular">{taka(due)}</TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-2">
                      {due > 0 && canCollect(r.branch_id) && (
                        <>
                          <select
                            aria-label={`How the kisti for invoice ${r.installment_plans?.sales?.invoice_no ?? ""} was paid`}
                            className="h-8 w-24 rounded-md border bg-background px-1 text-sm"
                            value={methods[r.id] ?? "cash"}
                            onChange={(e) =>
                              setMethods((prev) => ({ ...prev, [r.id]: e.target.value }))
                            }
                          >
                            {COLLECTION_METHODS.map((m) => (
                              <option key={m} value={m}>
                                {methodLabel(m)}
                              </option>
                            ))}
                          </select>
                          <Input
                            type="number"
                            className="h-8 w-24"
                            aria-label={`Amount to collect for invoice ${r.installment_plans?.sales?.invoice_no ?? ""}`}
                            placeholder={String(due)}
                            value={amounts[r.id] ?? ""}
                            onChange={(e) =>
                              setAmounts((prev) => ({ ...prev, [r.id]: e.target.value }))
                            }
                          />
                          <Button size="sm" disabled={busy} onClick={() => pay(r.id, due)}>
                            {t("Pay")}
                          </Button>
                        </>
                      )}
                      <Link
                        to="/kisti-receipt/$installmentId"
                        params={{ installmentId: r.id }}
                        className="text-sm text-primary hover:underline"
                      >
                        Receipt
                      </Link>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
            {rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={8} className="py-8 text-center text-muted-foreground">
                  {error ? "Could not load installments." : "Nothing here."}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}
