import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { BranchPicker, PageHeader } from "@/components/BranchPicker";
import { PartnerAccounts } from "@/components/PartnerAccounts";
import { taka, useBranches, useMe } from "@/lib/erp";
import { useT } from "@/lib/i18n";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
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
import { downloadCsv } from "@/lib/csv";
import { localDayEndIso, localDayStartIso, localToday } from "@/lib/date";

export const Route = createFileRoute("/_authenticated/accounts")({
  head: () => ({ meta: [{ title: "Accounts — Dealer ERP" }] }),
  component: Accounts,
});

const METHODS = ["cash", "bank", "bkash", "nagad"] as const;
const methodLabel = (m: string) =>
  m === "cash"
    ? "Cash"
    : m === "bank"
      ? "Bank"
      : m === "bkash"
        ? "bKash"
        : m === "nagad"
          ? "Nagad"
          : m;

const firstOfMonth = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
};

function Accounts() {
  const { t } = useT();
  const { data: me } = useMe();
  const qc = useQueryClient();
  const [branch, setBranch] = useState("");
  const [search, setSearch] = useState("");
  const [from, setFrom] = useState(firstOfMonth);
  const [to, setTo] = useState(localToday);
  const [f, setF] = useState({
    category: "Other income",
    amount: "",
    method: "cash",
    note: "",
  });
  const { data: branches = [] } = useBranches();
  const { data = [], error } = useQuery({
    queryKey: ["transactions", branch],
    enabled: !!branch,
    queryFn: async () => {
      let q = supabase.from("transactions").select("*").order("created_at", { ascending: false });
      if (branch !== "all") q = q.eq("branch_id", branch);
      return fetchAllPages(q);
    },
  });
  const bname = (id: string) => branches.find((b) => b.id === id)?.name ?? "";
  const canAddIncome =
    !!me &&
    !!branch &&
    branch !== "all" &&
    (me.canWriteHq ||
      (me.branch_id === branch &&
        me.roles.some((r) => ["branch_manager", "accountant"].includes(r))));
  const canPartner =
    !!me &&
    !!branch &&
    branch !== "all" &&
    (me.canWriteHq ||
      (me.branch_id === branch &&
        me.roles.some((r) => ["branch_manager", "sales", "accountant"].includes(r))));
  const canReverse = (x: { branch_id: string }) =>
    !!me &&
    (me.canWriteHq ||
      (me.branch_id === x.branch_id &&
        me.roles.some((r) => ["branch_manager", "accountant"].includes(r))));
  const reversedIds = new Set(
    data.filter((x) => x.category === "Reversal" && x.ref_id).map((x) => x.ref_id),
  );

  // The ledger the user is actually looking at: branch + period + search.
  const shown = data.filter((x) => {
    const at = new Date(x.created_at);
    if (from && at < new Date(localDayStartIso(from))) return false;
    if (to && at > new Date(localDayEndIso(to))) return false;
    if (
      search &&
      !`${x.category} ${x.note ?? ""} ${bname(x.branch_id)} ${x.method ?? ""}`
        .toLowerCase()
        .includes(search.toLowerCase())
    )
      return false;
    return true;
  });

  const income = shown.filter((x) => x.kind === "income").reduce((a, x) => a + Number(x.amount), 0);
  const expense = shown
    .filter((x) => x.kind === "expense")
    .reduce((a, x) => a + Number(x.amount), 0);
  const byMethod = METHODS.map((m) => {
    const rows = shown.filter((x) => (x.method ?? "cash") === m);
    const plus = rows.filter((x) => x.kind === "income").reduce((a, x) => a + Number(x.amount), 0);
    const minus = rows
      .filter((x) => x.kind === "expense")
      .reduce((a, x) => a + Number(x.amount), 0);
    return { method: m, in: plus, out: minus, net: plus - minus };
  });

  async function add() {
    if (branch === "all" || !branch) {
      toast.error("Choose one branch before adding an entry");
      return;
    }
    if (!f.category.trim()) {
      toast.error("Enter a category");
      return;
    }
    const amount = Number(f.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      toast.error("Enter an amount greater than zero");
      return;
    }
    const { error } = await supabase.rpc("add_manual_income", {
      _branch: branch,
      _category: f.category.trim(),
      _amount: amount,
      _note: f.note.trim(),
      _method: f.method,
    });
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Entry saved");
    setF({ ...f, amount: "", note: "" });
    qc.invalidateQueries({ queryKey: ["transactions"] });
  }

  async function reverse(id: string) {
    const reason = window.prompt("Why does this income entry need reversal?");
    if (!reason?.trim()) return;
    const { error } = await supabase.rpc("reverse_manual_transaction", {
      _transaction: id,
      _reason: reason.trim(),
    });
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Reversal recorded");
    qc.invalidateQueries({ queryKey: ["transactions"] });
  }

  function exportCsv() {
    downloadCsv(
      shown.map((x) => ({
        Date: new Date(x.created_at).toLocaleString(),
        Branch: bname(x.branch_id),
        Category: x.category,
        Note: x.note ?? "",
        Method: methodLabel(x.method ?? "cash"),
        Type: x.kind,
        Amount: Number(x.amount),
      })),
      `accounts-${from || "all"}-to-${to || "all"}.csv`,
    );
  }

  const filtered = !!(from || to || search);

  return (
    <div>
      <PageHeader title={t("Accounts")}>
        <BranchPicker value={branch} onChange={setBranch} allowAll />
      </PageHeader>
      <div className="mb-4 flex flex-wrap items-end gap-2">
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground" htmlFor="acc-from">
            From
          </label>
          <Input
            id="acc-from"
            type="date"
            className="w-40"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground" htmlFor="acc-to">
            To
          </label>
          <Input
            id="acc-to"
            type="date"
            className="w-40"
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
        <Button variant="outline" size="sm" onClick={exportCsv} disabled={!shown.length}>
          Export CSV
        </Button>
      </div>
      <div className="mb-4 grid gap-4 sm:grid-cols-3">
        <Card className="p-5">
          <div className="text-xs uppercase text-muted-foreground">{t("Income")}</div>
          <div className="mt-1 font-display text-2xl text-success tabular">{taka(income)}</div>
        </Card>
        <Card className="p-5">
          <div className="text-xs uppercase text-muted-foreground">{t("Expense")}</div>
          <div className="mt-1 font-display text-2xl text-destructive tabular">{taka(expense)}</div>
        </Card>
        <Card className="border-accent bg-accent/15 p-5">
          <div className="text-xs uppercase text-muted-foreground">{t("Cash balance")}</div>
          <div className="mt-1 font-display text-2xl tabular">{taka(income - expense)}</div>
          {filtered && (
            <div className="mt-1 text-xs text-muted-foreground">for the selected period</div>
          )}
        </Card>
      </div>
      {byMethod.some((m) => m.in || m.out) && (
        <div className="mb-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {byMethod
            .filter((m) => m.in || m.out)
            .map((m) => (
              <Card key={m.method} className="p-4">
                <div className="text-xs uppercase text-muted-foreground">
                  {methodLabel(m.method)}
                </div>
                <div className="mt-1 font-display text-xl tabular">{taka(m.net)}</div>
                <div className="mt-1 text-xs text-muted-foreground tabular">
                  +{taka(m.in)} / −{taka(m.out)}
                </div>
              </Card>
            ))}
        </div>
      )}
      {canAddIncome && (
        <Card className="mb-4 flex flex-wrap items-end gap-2 p-4">
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground" htmlFor="acc-cat">
              {t("Income category")}
            </label>
            <Input
              id="acc-cat"
              className="w-40"
              placeholder={t("Income category")}
              value={f.category}
              onChange={(e) => setF({ ...f, category: e.target.value })}
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground" htmlFor="acc-amount">
              {t("Amount")}
            </label>
            <Input
              id="acc-amount"
              type="number"
              className="w-36"
              placeholder={t("Amount")}
              value={f.amount}
              onChange={(e) => setF({ ...f, amount: e.target.value })}
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground" htmlFor="acc-method">
              Method
            </label>
            <select
              id="acc-method"
              className="h-9 rounded-md border bg-background px-2 text-sm"
              value={f.method}
              onChange={(e) => setF({ ...f, method: e.target.value })}
            >
              {METHODS.map((m) => (
                <option key={m} value={m}>
                  {methodLabel(m)}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground" htmlFor="acc-note">
              {t("Note")}
            </label>
            <Input
              id="acc-note"
              className="w-64"
              placeholder={t("Note")}
              value={f.note}
              onChange={(e) => setF({ ...f, note: e.target.value })}
            />
          </div>
          <Button onClick={add} disabled={!(Number(f.amount) > 0) || !f.category.trim()}>
            {t("Add")}
          </Button>
        </Card>
      )}
      {branch && <PartnerAccounts branch={branch} canAdd={canPartner} />}
      <Input
        className="mb-3 max-w-sm bg-card"
        aria-label="Search transactions"
        placeholder="Search category, note, branch or method"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      {error && (
        <p className="mb-3 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          Could not load the ledger: {error.message}
        </p>
      )}
      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("Date")}</TableHead>
              <TableHead>{t("Branch")}</TableHead>
              <TableHead>{t("Category")}</TableHead>
              <TableHead>{t("Note")}</TableHead>
              <TableHead>Method</TableHead>
              <TableHead className="text-right">{t("Amount")}</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {shown.map((x) => (
              <TableRow key={x.id}>
                <TableCell>{new Date(x.created_at).toLocaleString()}</TableCell>
                <TableCell>{bname(x.branch_id)}</TableCell>
                <TableCell>{x.category}</TableCell>
                <TableCell className="text-muted-foreground">{x.note}</TableCell>
                <TableCell>{methodLabel(x.method ?? "cash")}</TableCell>
                <TableCell
                  className={`text-right tabular ${x.kind === "income" ? "text-success" : "text-destructive"}`}
                >
                  {x.kind === "income" ? "+" : "−"} {taka(x.amount)}
                </TableCell>
                <TableCell className="text-right">
                  {canReverse(x) &&
                    x.ref_id === null &&
                    !reversedIds.has(x.id) &&
                    x.category !== "Reversal" && (
                      <Button size="sm" variant="outline" onClick={() => reverse(x.id)}>
                        Reverse
                      </Button>
                    )}
                </TableCell>
              </TableRow>
            ))}
            {shown.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="py-8 text-center text-muted-foreground">
                  {data.length ? "No entries match this period or search." : "No transactions yet."}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}
