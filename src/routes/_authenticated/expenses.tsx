import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { enqueue, isNetworkError } from "@/lib/offline";
import { supabase } from "@/integrations/supabase/client";
import { BranchPicker, PageHeader } from "@/components/BranchPicker";
import { taka, useBranches, useMe } from "@/lib/erp";
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
import { localDate, localDayEndIso, localDayStartIso } from "@/lib/date";
import { downloadCsv } from "@/lib/csv";
import { safeUrl } from "@/lib/url";
import { EXPENSE_METHODS, methodLabel } from "@/lib/payment-methods";
import { EXPENSE_HEADS } from "@/lib/expense-heads";
import { useT } from "@/lib/i18n";

export const Route = createFileRoute("/_authenticated/expenses")({
  head: () => ({
    meta: [
      { title: "Expenses & petty cash — Dealer ERP" },
      { name: "description", content: "Record showroom expenses with approval limits." },
    ],
  }),
  component: Expenses,
});

// The ten heads a showroom keeps its day book in. The same list is a CHECK
// constraint on expenses.category, so what is filed here is what totals in the
// expense report — "Rent" and "Shop rent" can no longer be two different heads.
const CATS: string[] = [...EXPENSE_HEADS];

/**
 * expense_date is a `date` column, so the value is already YYYY-MM-DD and can be
 * compared as text. If it ever comes back as a timestamp we fall back to the
 * local day boundaries instead.
 */
function inDayRange(value: string, from: string, to: string) {
  if (!from && !to) return true;
  if (value.length <= 10) {
    if (from && value < from) return false;
    if (to && value > to) return false;
    return true;
  }
  const at = new Date(value).getTime();
  if (from && at < new Date(localDayStartIso(from)).getTime()) return false;
  if (to && at > new Date(localDayEndIso(to)).getTime()) return false;
  return true;
}

function Expenses() {
  const { t } = useT();
  const qc = useQueryClient();
  const { data: me } = useMe();
  const { data: branches = [] } = useBranches();
  const [branch, setBranch] = useState("");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("any");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const today = localDate();
  const [f, setF] = useState({
    category: CATS[0] ?? "Other",
    amount: "",
    date: today,
    method: "cash",
    note: "",
    attachment: "",
    billNo: "",
  });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const limit = branches.find((b) => b.id === branch)?.expense_limit;
  const amount = Number(f.amount);
  const amountOk = Number.isFinite(amount) && amount > 0;
  // What actually travels to the RPC as _category.
  const categoryValue = f.category.trim();
  const categoryOk = categoryValue.length > 0;
  // "Other" carries no meaning of its own, so the note is what makes the row
  // auditable when somebody reads the book a month later.
  const noteOk = categoryValue !== "Other" || f.note.trim().length > 0;
  const isAdmin = !!me?.canWriteHq;
  const isBranchManager = !!me && me.branch_id === branch && me.roles.includes("branch_manager");
  // The database decides approval — we only warn.
  const overLimit = limit != null && amountOk && amount > Number(limit);
  // Mirrors submit_expense's own rule: an admin, or a manager inside the limit.
  const autoApproved = isAdmin || (isBranchManager && !overLimit);
  const limitWarning =
    !overLimit || isAdmin
      ? null
      : isBranchManager
        ? `Above the branch limit of ${taka(limit)} — an admin must approve this`
        : `Above the branch limit of ${taka(limit)} — a manager must approve this`;
  const canSubmit =
    !!me &&
    !!branch &&
    branch !== "all" &&
    (me.canWriteHq ||
      (me.branch_id === branch &&
        me.roles.some((r) => ["branch_manager", "sales", "accountant"].includes(r))));
  const { data = [], error } = useQuery({
    queryKey: ["expenses", branch],
    enabled: !!branch,
    queryFn: async () => {
      let q = supabase.from("expenses").select("*").order("created_at", { ascending: false });
      if (branch !== "all") q = q.eq("branch_id", branch);
      return fetchAllPages(q);
    },
  });
  // approved_by has no foreign key, so PostgREST cannot embed the name. A
  // signature nobody can read is not proof of approval.
  const { data: staff = [] } = useQuery({
    queryKey: ["expense-staff"],
    queryFn: async () => fetchAllPages(supabase.from("profiles").select("id,full_name")),
  });

  function resetForm() {
    setF((p) => ({
      ...p,
      amount: "",
      note: "",
      attachment: "",
      billNo: "",
      date: localDate(),
    }));
  }

  async function submit() {
    if (busy) return;
    setBusy(true);
    try {
      await submitInner();
    } finally {
      setBusy(false);
    }
  }

  async function submitInner() {
    if (!canSubmit) {
      toast.error("Choose a branch you are allowed to operate");
      return;
    }
    if (!amountOk) {
      toast.error("Enter an amount greater than zero");
      return;
    }
    if (!categoryOk) {
      toast.error("Enter a category name");
      return;
    }
    if (!noteOk) {
      toast.error("Write a note when the head is Other");
      return;
    }
    if (f.attachment.trim() && !safeUrl(f.attachment)) {
      toast.error("Receipt link must start with http:// or https://");
      return;
    }
    if (editingId) {
      if (!navigator.onLine) {
        toast.error("Connect to the internet to edit a pending expense");
        return;
      }
      const { error } = await supabase.rpc("update_pending_expense", {
        _expense: editingId,
        _category: categoryValue,
        _amount: amount,
        _date: f.date,
        _method: f.method,
        _note: f.note,
        _attachment: f.attachment,
        _bill_no: f.billNo.trim(),
      });
      if (error) {
        toast.error(error.message);
        return;
      }
      toast.success("Pending expense updated");
      setEditingId(null);
      resetForm();
      qc.invalidateQueries();
      return;
    }
    const offline = async () => {
      await enqueue(
        "expense",
        {
          branch,
          category: categoryValue,
          amount: amount,
          date: f.date,
          method: f.method,
          note: f.note,
          attachment: f.attachment,
          bill_no: f.billNo.trim(),
        },
        `Expense ${categoryValue} ৳${amount}`,
        me?.id,
      );
      toast.success("Offline — expense saved and will sync when internet returns");
      resetForm();
    };
    if (!navigator.onLine) {
      await offline();
      return;
    }
    const { data: voucher, error } = await supabase.rpc("submit_expense", {
      _branch: branch,
      _category: categoryValue,
      _amount: amount,
      _date: f.date,
      _method: f.method,
      _note: f.note,
      _attachment: f.attachment,
      _bill_no: f.billNo.trim(),
    });
    if (error && isNetworkError(error)) {
      await offline();
      return;
    }
    if (error) {
      toast.error(error.message);
      return;
    }
    // submit_expense hands back the voucher it issued, which is the number the
    // shopkeeper quotes when the expense turns up on paper.
    toast.success(
      autoApproved
        ? `Expense saved — voucher ${voucher}`
        : overLimit
          ? `Voucher ${voucher} is above the branch limit — waiting for admin approval`
          : `Voucher ${voucher} sent for approval`,
    );
    resetForm();
    qc.invalidateQueries();
  }
  async function decide(id: string, ok: boolean) {
    const { error } = await supabase.rpc("decide_expense", { _expense: id, _approve: ok });
    if (error) {
      toast.error(error.message);
      return;
    }
    qc.invalidateQueries();
  }
  function editExpense(e: (typeof data)[number]) {
    setBranch(e.branch_id);
    setEditingId(e.id);
    setF({
      category: CATS.includes(e.category) ? e.category : "Other",
      amount: String(e.amount),
      date: e.expense_date.slice(0, 10),
      method: e.method,
      note: e.note ?? "",
      attachment: e.attachment_url ?? "",
      billNo: e.bill_no ?? "",
    });
  }
  const bname = (id: string) => branches.find((b) => b.id === id)?.name ?? "";
  const shown = data.filter(
    (e) =>
      inDayRange(e.expense_date, from, to) &&
      (!search ||
        `${e.category} ${e.note ?? ""} ${e.voucher_no ?? ""} ${e.bill_no ?? ""}`
          .toLowerCase()
          .includes(search.toLowerCase())) &&
      (statusFilter === "any" || e.status === statusFilter),
  );
  // The total must describe the rows on screen, not the whole table.
  const approved = shown
    .filter((e) => e.status === "approved")
    .reduce((s, e) => s + Number(e.amount), 0);
  const filtersActive = !!(search || statusFilter !== "any" || from || to);
  const rowCount = shown.length;
  const rowWord = rowCount === 1 ? "row" : "rows";

  function exportCsv() {
    downloadCsv(
      shown.map((e) => ({
        Voucher: e.voucher_no ?? "",
        Date: e.expense_date.slice(0, 10),
        Branch: bname(e.branch_id),
        Category: e.category,
        Bill: e.bill_no ?? "",
        Note: e.note ?? "",
        Method: methodLabel(e.method),
        Amount: Number(e.amount),
        Status: e.status,
        "Approved by": e.approved_by
          ? (staff.find((u) => u.id === e.approved_by)?.full_name ?? "")
          : "",
        "Approved on": e.approved_at ? new Date(e.approved_at).toLocaleString() : "",
        Receipt: e.attachment_url ?? "",
      })),
      `expenses-${from || "all"}-to-${to || "all"}.csv`,
    );
  }

  const emptyMessage = error
    ? "Could not load expenses — see the error above."
    : data.length
      ? "No expenses match these filters."
      : "No expenses yet.";

  return (
    <div>
      <PageHeader title={t("Expenses")}>
        <BranchPicker value={branch} onChange={setBranch} allowAll />
      </PageHeader>
      {canSubmit && (
        <Card className="mb-4 grid gap-2 p-4 md:grid-cols-4">
          <div>
            <Label className="text-xs" htmlFor="exp-category">
              {t("Category")}
            </Label>
            <select
              id="exp-category"
              className="w-full rounded-md border bg-background px-2 py-2"
              value={f.category}
              onChange={(e) => setF({ ...f, category: e.target.value })}
            >
              {CATS.map((c) => (
                <option key={c} value={c}>
                  {t(c)}
                </option>
              ))}
            </select>
          </div>
          <div>
            <Label className="text-xs" htmlFor="exp-amount">
              {t("Amount")} ৳
            </Label>
            <Input
              id="exp-amount"
              type="number"
              min={0}
              step="0.01"
              value={f.amount}
              onChange={(e) => setF({ ...f, amount: e.target.value })}
            />
          </div>
          <div>
            <Label className="text-xs" htmlFor="exp-date">
              Date
            </Label>
            <Input
              id="exp-date"
              type="date"
              value={f.date}
              onChange={(e) => setF({ ...f, date: e.target.value })}
            />
          </div>
          <div>
            <Label className="text-xs" htmlFor="exp-method">
              Method
            </Label>
            <select
              id="exp-method"
              className="w-full rounded-md border bg-background px-2 py-2"
              value={f.method}
              onChange={(e) => setF({ ...f, method: e.target.value })}
            >
              {EXPENSE_METHODS.map((m) => (
                <option key={m} value={m}>
                  {methodLabel(m)}
                </option>
              ))}
            </select>
          </div>
          <div>
            <Label className="text-xs" htmlFor="exp-note">
              {t("Note")}
            </Label>
            <Input
              id="exp-note"
              value={f.note}
              onChange={(e) => setF({ ...f, note: e.target.value })}
              placeholder={f.category === "Other" ? "What was the money for?" : ""}
            />
            {f.category === "Other" && !f.note.trim() && (
              <p className="mt-1 text-xs text-destructive">
                A note is required when the head is “Other”.
              </p>
            )}
          </div>
          <div>
            <Label className="text-xs" htmlFor="exp-bill">
              {t("Bill / token no")}
            </Label>
            <Input
              id="exp-bill"
              value={f.billNo}
              onChange={(e) => setF({ ...f, billNo: e.target.value })}
              placeholder="e.g. UNB-1049283"
            />
          </div>
          <div>
            <Label className="text-xs" htmlFor="exp-attachment">
              Receipt link (optional)
            </Label>
            <Input
              id="exp-attachment"
              value={f.attachment}
              onChange={(e) => setF({ ...f, attachment: e.target.value })}
              placeholder="https://"
            />
          </div>
          <div className="md:col-span-4 flex flex-wrap items-center gap-3">
            <Button
              onClick={submit}
              disabled={busy || !amountOk || !canSubmit || !categoryOk || !noteOk}
            >
              {editingId ? "Save changes" : t("Add expense")}
            </Button>
            {editingId && (
              <Button
                variant="ghost"
                onClick={() => {
                  setEditingId(null);
                  resetForm();
                }}
              >
                Cancel edit
              </Button>
            )}
            {limitWarning && (
              <span
                role="alert"
                className="rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1 text-xs font-semibold text-destructive"
              >
                {limitWarning}
              </span>
            )}
            {limit != null && (
              <span className="text-xs text-muted-foreground">
                Manager limit for this branch: {taka(limit)}. Larger amounts need admin approval.
              </span>
            )}
          </div>
        </Card>
      )}
      <div className="mb-3 flex flex-wrap items-end gap-2">
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground" htmlFor="exp-from">
            From
          </Label>
          <Input
            id="exp-from"
            type="date"
            className="w-40 bg-card"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground" htmlFor="exp-to">
            To
          </Label>
          <Input
            id="exp-to"
            type="date"
            className="w-40 bg-card"
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        </div>
        {(from || to) && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setFrom("");
              setTo("");
            }}
          >
            All time
          </Button>
        )}
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground" htmlFor="exp-search">
            Search
          </Label>
          <Input
            id="exp-search"
            className="w-64 bg-card"
            placeholder="Search category or note"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground" htmlFor="exp-status">
            Status
          </Label>
          <select
            id="exp-status"
            className="h-9 rounded-md border bg-background px-3 text-sm"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
          >
            <option value="any">All statuses</option>
            <option value="pending">Pending</option>
            <option value="approved">Approved</option>
            <option value="rejected">Rejected</option>
          </select>
        </div>
        <Button variant="outline" size="sm" onClick={exportCsv} disabled={!rowCount}>
          Export CSV
        </Button>
      </div>
      {error && (
        <p className="mb-3 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          Could not load expenses: {error.message}
        </p>
      )}
      <Card>
        <div className="flex flex-wrap items-baseline gap-2 p-4 text-sm">
          <span className="text-muted-foreground">Approved total</span>
          <b className="text-base tabular">{taka(approved)}</b>
          <span className="text-xs text-muted-foreground">
            {filtersActive ? `of ${rowCount} filtered ${rowWord}` : `of all ${rowCount} ${rowWord}`}
          </span>
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("Voucher")}</TableHead>
              <TableHead>{t("Date")}</TableHead>
              <TableHead>{t("Branch")}</TableHead>
              <TableHead>{t("Category")}</TableHead>
              <TableHead>{t("Bill")}</TableHead>
              <TableHead>{t("Note")}</TableHead>
              <TableHead>{t("Method")}</TableHead>
              <TableHead className="text-right">{t("Amount")}</TableHead>
              <TableHead>{t("Status")}</TableHead>
              <TableHead>{t("Approved by")}</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {shown.map((e) => (
              <TableRow key={e.id}>
                <TableCell className="text-xs tabular">{e.voucher_no ?? "—"}</TableCell>
                <TableCell>{e.expense_date.slice(0, 10)}</TableCell>
                <TableCell>{bname(e.branch_id)}</TableCell>
                <TableCell>{t(e.category)}</TableCell>
                <TableCell className="text-xs tabular">{e.bill_no ?? "—"}</TableCell>
                <TableCell className="text-xs">
                  {e.note}
                  {safeUrl(e.attachment_url) && (
                    <a
                      className="ml-1 text-primary"
                      href={safeUrl(e.attachment_url) ?? undefined}
                      target="_blank"
                      rel="noreferrer noopener"
                    >
                      receipt
                    </a>
                  )}
                </TableCell>
                <TableCell>{methodLabel(e.method)}</TableCell>
                <TableCell className="text-right tabular">{taka(e.amount)}</TableCell>
                <TableCell>
                  <Badge
                    variant={
                      e.status === "approved"
                        ? "outline"
                        : e.status === "pending"
                          ? "secondary"
                          : "destructive"
                    }
                  >
                    {e.status}
                  </Badge>
                </TableCell>
                <TableCell className="text-xs">
                  {e.approved_by
                    ? (staff.find((u) => u.id === e.approved_by)?.full_name ?? "approved")
                    : "—"}
                  {e.approved_at && (
                    <div className="text-muted-foreground">
                      {new Date(e.approved_at).toLocaleDateString()}
                    </div>
                  )}
                </TableCell>
                <TableCell>
                  <div className="flex gap-1">
                    {e.status === "pending" && (me?.canWriteHq || e.created_by === me?.id) && (
                      <Button size="sm" variant="outline" onClick={() => editExpense(e)}>
                        Edit
                      </Button>
                    )}
                    {me?.canWriteHq && e.status === "pending" && (
                      <>
                        <Button size="sm" onClick={() => decide(e.id, true)}>
                          Approve
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => decide(e.id, false)}>
                          Reject
                        </Button>
                      </>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ))}
            {shown.length === 0 && (
              <TableRow>
                <TableCell colSpan={11} className="py-8 text-center text-muted-foreground">
                  {emptyMessage}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}
