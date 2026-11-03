import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { PageHeader } from "@/components/BranchPicker";
import { taka, useBranches, useMe } from "@/lib/erp";
import { useT } from "@/lib/i18n";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { fetchAllPages } from "@/lib/paginated-query";
import { localToday } from "@/lib/date";

export const Route = createFileRoute("/_authenticated/customers_/$customerId")({
  head: () => ({ meta: [{ title: "Customer — Dealer ERP" }] }),
  component: CustomerDetail,
});

function CustomerDetail() {
  const { customerId } = Route.useParams();
  const { t } = useT();
  const { data: me } = useMe();
  const qc = useQueryClient();
  const { data: branches = [] } = useBranches();
  const [notes, setNotes] = useState<string | null>(null);
  const [savingNotes, setSavingNotes] = useState(false);
  const [collectAmounts, setCollectAmounts] = useState<Record<string, string>>({});

  const { data, error } = useQuery({
    queryKey: ["customer", customerId],
    enabled: !!customerId,
    queryFn: async () => {
      const [cust, sales] = await Promise.all([
        supabase.from("customers").select("*").eq("id", customerId).maybeSingle(),
        fetchAllPages(
          supabase
            .from("sales")
            .select("*")
            .eq("customer_id", customerId)
            .order("created_at", { ascending: false }),
        ),
      ]);
      const plans = await fetchAllPages(
        supabase.from("installment_plans").select("*").eq("customer_id", customerId),
      );
      const insts = plans.length
        ? await fetchAllPages(
            supabase
              .from("installments")
              .select("*")
              .in(
                "plan_id",
                plans.map((p) => p.id),
              ),
          )
        : [];
      return { customer: cust.data, sales, plans, installments: insts };
    },
  });

  const customer = data?.customer ?? null;
  const sales = data?.sales ?? [];
  const plans = data?.plans ?? [];
  const installments = data?.installments ?? [];
  const bname = (id: string) => branches.find((b) => b.id === id)?.name ?? "";

  const totalBought = sales
    .filter((s) => s.status !== "returned")
    .reduce((a, s) => a + Number(s.total), 0);
  const totalPaid = sales
    .filter((s) => s.status !== "returned")
    .reduce((a, s) => a + Number(s.paid), 0);
  const kistiPaid = installments
    .filter((i) => !i.cancelled)
    .reduce((a, i) => a + Number(i.paid_amount), 0);
  const kistiDue = installments
    .filter((i) => !i.cancelled)
    .reduce((a, i) => a + Math.max(0, Number(i.amount) - Number(i.paid_amount)), 0);
  const overdue = installments
    .filter(
      (i) => !i.cancelled && i.due_date < localToday() && Number(i.paid_amount) < Number(i.amount),
    )
    .reduce((a, i) => a + (Number(i.amount) - Number(i.paid_amount)), 0);
  const outstanding = Math.max(0, totalBought - totalPaid - kistiPaid);

  const canEdit =
    !!me &&
    !!customer &&
    (me.canWriteHq ||
      (me.branch_id === customer.branch_id &&
        me.roles.some((r) => ["branch_manager", "sales", "accountant"].includes(r))));

  async function collect(installmentId: string, amount: number) {
    if (!(amount > 0)) {
      toast.error("Enter an amount greater than zero");
      return;
    }
    const { error: e } = await supabase.rpc("pay_installment", {
      _inst: installmentId,
      _amount: amount,
    });
    if (e) {
      toast.error(e.message);
      return;
    }
    toast.success(`${taka(amount)} collected`);
    qc.invalidateQueries({ queryKey: ["customer", customerId] });
    qc.invalidateQueries({ queryKey: ["installments"] });
  }

  async function saveNotes() {
    if (!customer) return;
    setSavingNotes(true);
    const { error: e } = await supabase
      .from("customers")
      .update({ notes: notes?.trim() || null })
      .eq("id", customer.id);
    setSavingNotes(false);
    if (e) {
      toast.error(e.message);
      return;
    }
    toast.success("Note saved");
    qc.invalidateQueries({ queryKey: ["customer", customerId] });
  }

  if (error) {
    return (
      <div>
        <PageHeader title={t("Customers")} />
        <p className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          Could not load this customer: {error.message}
        </p>
      </div>
    );
  }

  if (!customer) {
    return (
      <div>
        <PageHeader title={t("Customers")} />
        <p className="p-6 text-sm text-muted-foreground">This customer does not exist any more.</p>
      </div>
    );
  }

  return (
    <div>
      <PageHeader title={customer.name}>
        <Link to="/customers" className="text-sm text-primary hover:underline">
          ← {t("Customers")}
        </Link>
      </PageHeader>

      <div className="mb-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card className="p-5">
          <div className="text-xs uppercase text-muted-foreground">Total bought</div>
          <div className="mt-1 font-display text-2xl tabular">{taka(totalBought)}</div>
        </Card>
        <Card className="p-5">
          <div className="text-xs uppercase text-muted-foreground">Paid so far</div>
          <div className="mt-1 font-display text-2xl text-success tabular">
            {taka(totalPaid + kistiPaid)}
          </div>
        </Card>
        <Card className="p-5">
          <div className="text-xs uppercase text-muted-foreground">Outstanding</div>
          <div
            className={`mt-1 font-display text-2xl tabular ${outstanding > 0 ? "text-destructive" : ""}`}
          >
            {taka(outstanding)}
          </div>
        </Card>
        <Card className="p-5">
          <div className="text-xs uppercase text-muted-foreground">Overdue kisti</div>
          <div
            className={`mt-1 font-display text-2xl tabular ${overdue > 0 ? "text-destructive" : ""}`}
          >
            {taka(overdue)}
          </div>
        </Card>
      </div>

      <Card className="mb-4 p-5">
        <div className="mb-3 font-semibold">Details</div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <div className="text-xs uppercase text-muted-foreground">{t("Name")}</div>
            <div className="font-medium">{customer.name}</div>
          </div>
          <div>
            <div className="text-xs uppercase text-muted-foreground">{t("Phone")}</div>
            <div className="font-medium tabular">{customer.phone}</div>
          </div>
          <div>
            <div className="text-xs uppercase text-muted-foreground">NID</div>
            <div className="font-medium">{customer.nid || "—"}</div>
          </div>
          <div>
            <div className="text-xs uppercase text-muted-foreground">{t("Branch")}</div>
            <div className="font-medium">{bname(customer.branch_id)}</div>
          </div>
        </div>
        <div className="mt-3">
          <div className="text-xs uppercase text-muted-foreground">{t("Address")}</div>
          <div className="font-medium">{customer.address || "—"}</div>
        </div>
        <div className="mt-3">
          <Label className="text-xs" htmlFor="cust-notes">
            Notes
          </Label>
          <div className="flex gap-2">
            <Input
              id="cust-notes"
              value={notes ?? customer.notes ?? ""}
              disabled={!canEdit}
              placeholder="Anything worth remembering about this customer"
              onChange={(e) => setNotes(e.target.value)}
            />
            {canEdit && (
              <Button
                variant="outline"
                disabled={savingNotes || (notes ?? customer.notes ?? "") === (customer.notes ?? "")}
                onClick={saveNotes}
              >
                Save note
              </Button>
            )}
          </div>
        </div>
      </Card>

      <Card className="mb-4">
        <div className="border-b p-4 font-semibold">Sales</div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("Date")}</TableHead>
              <TableHead>Invoice</TableHead>
              <TableHead>{t("Branch")}</TableHead>
              <TableHead>Type</TableHead>
              <TableHead className="text-right">{t("Amount")}</TableHead>
              <TableHead className="text-right">{t("Paid")}</TableHead>
              <TableHead>{t("Status")}</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {sales.map((s) => (
              <TableRow key={s.id}>
                <TableCell>{new Date(s.created_at).toLocaleDateString()}</TableCell>
                <TableCell className="font-mono text-xs">{s.invoice_no}</TableCell>
                <TableCell>{bname(s.branch_id)}</TableCell>
                <TableCell>{s.sale_type}</TableCell>
                <TableCell className="text-right tabular">{taka(s.total)}</TableCell>
                <TableCell className="text-right tabular">{taka(s.paid)}</TableCell>
                <TableCell>
                  <Badge variant="outline" className="capitalize">
                    {s.status ?? "active"}
                  </Badge>
                </TableCell>
                <TableCell className="text-right">
                  <Link
                    to="/receipt/$saleId"
                    params={{ saleId: s.id }}
                    className="text-sm text-primary hover:underline"
                  >
                    Receipt
                  </Link>
                </TableCell>
              </TableRow>
            ))}
            {!sales.length && (
              <TableRow>
                <TableCell colSpan={8} className="py-8 text-center text-muted-foreground">
                  No purchases yet.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Card>

      <Card>
        <div className="border-b p-4 font-semibold">Kisti schedule</div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>#</TableHead>
              <TableHead>Invoice</TableHead>
              <TableHead>{t("Due date")}</TableHead>
              <TableHead className="text-right">{t("Amount")}</TableHead>
              <TableHead className="text-right">{t("Paid")}</TableHead>
              <TableHead className="text-right">{t("Due")}</TableHead>
              <TableHead>{t("Status")}</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {installments
              .slice()
              .sort((a, b) => a.due_date.localeCompare(b.due_date))
              .map((i) => {
                const plan = plans.find((p) => p.id === i.plan_id);
                const sale = sales.find((s) => s.id === plan?.sale_id);
                const due = Math.max(0, Number(i.amount) - Number(i.paid_amount));
                const late = !i.cancelled && due > 0 && i.due_date < localToday();
                return (
                  <TableRow key={i.id}>
                    <TableCell className="tabular">{i.seq}</TableCell>
                    <TableCell className="font-mono text-xs">{sale?.invoice_no ?? "—"}</TableCell>
                    <TableCell>{i.due_date}</TableCell>
                    <TableCell className="text-right tabular">{taka(i.amount)}</TableCell>
                    <TableCell className="text-right tabular">{taka(i.paid_amount)}</TableCell>
                    <TableCell className="text-right tabular">{taka(due)}</TableCell>
                    <TableCell>
                      {i.cancelled ? (
                        <Badge variant="outline">cancelled</Badge>
                      ) : late ? (
                        <Badge variant="destructive">overdue</Badge>
                      ) : due === 0 ? (
                        <Badge variant="outline" className="text-success">
                          paid
                        </Badge>
                      ) : (
                        <Badge variant="outline">due</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-2">
                        {due > 0 && canEdit && (
                          <>
                            <Input
                              type="number"
                              className="h-8 w-24"
                              aria-label={`Amount to collect for kisti ${i.seq}`}
                              placeholder={String(due)}
                              value={collectAmounts[i.id] ?? ""}
                              onChange={(e) =>
                                setCollectAmounts((prev) => ({
                                  ...prev,
                                  [i.id]: e.target.value,
                                }))
                              }
                            />
                            <Button
                              size="sm"
                              onClick={() => {
                                const typed = Number(collectAmounts[i.id]);
                                const amt =
                                  Number.isFinite(typed) && typed > 0 ? Math.min(typed, due) : due;
                                void collect(i.id, amt);
                              }}
                            >
                              {t("Pay")}
                            </Button>
                          </>
                        )}
                        <Link
                          to="/kisti-receipt/$installmentId"
                          params={{ installmentId: i.id }}
                          className="text-sm text-primary hover:underline"
                        >
                          Receipt
                        </Link>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            {!installments.length && (
              <TableRow>
                <TableCell colSpan={8} className="py-8 text-center text-muted-foreground">
                  No installment plan for this customer.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}
