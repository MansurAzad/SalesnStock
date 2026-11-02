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

export const Route = createFileRoute("/_authenticated/accounts")({
  head: () => ({ meta: [{ title: "Accounts — Dealer ERP" }] }),
  component: Accounts,
});

function Accounts() {
  const { t } = useT();
  const { data: me } = useMe();
  const qc = useQueryClient();
  const [branch, setBranch] = useState("");
  const [search, setSearch] = useState("");
  const [f, setF] = useState({ category: "Other income", amount: "", note: "" });
  const { data: branches = [] } = useBranches();
  const { data = [] } = useQuery({
    queryKey: ["transactions", branch],
    enabled: !!branch,
    queryFn: async () => {
      let q = supabase.from("transactions").select("*").order("created_at", { ascending: false });
      if (branch !== "all") q = q.eq("branch_id", branch);
      return fetchAllPages(q);
    },
  });
  const income = data.filter((x) => x.kind === "income").reduce((a, x) => a + Number(x.amount), 0);
  const expense = data
    .filter((x) => x.kind === "expense")
    .reduce((a, x) => a + Number(x.amount), 0);
  const bname = (id: string) => branches.find((b) => b.id === id)?.name ?? "";
  const canAdd =
    !!me &&
    !!branch &&
    branch !== "all" &&
    (me.canWriteHq ||
      (me.branch_id === branch &&
        me.roles.some((r) => ["branch_manager", "sales", "accountant"].includes(r))));
  const reversedIds = new Set(
    data.filter((x) => x.category === "Reversal" && x.ref_id).map((x) => x.ref_id),
  );
  const shown = data.filter(
    (x) =>
      !search ||
      `${x.category} ${x.note ?? ""} ${bname(x.branch_id)}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );

  async function add() {
    const { error } = await supabase.from("transactions").insert({
      branch_id: branch,
      kind: "income",
      category: f.category,
      amount: Number(f.amount),
      note: f.note,
      created_by: me!.id,
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

  return (
    <div>
      <PageHeader title={t("Accounts")}>
        <BranchPicker value={branch} onChange={setBranch} allowAll />
      </PageHeader>
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
        </Card>
      </div>
      {canAdd && (
        <Card className="mb-4 flex flex-wrap gap-2 p-4">
          <Input
            className="w-40"
            placeholder={t("Income category")}
            value={f.category}
            onChange={(e) => setF({ ...f, category: e.target.value })}
          />
          <Input
            type="number"
            className="w-36"
            placeholder={t("Amount")}
            value={f.amount}
            onChange={(e) => setF({ ...f, amount: e.target.value })}
          />
          <Input
            className="w-64"
            placeholder={t("Note")}
            value={f.note}
            onChange={(e) => setF({ ...f, note: e.target.value })}
          />
          <Button onClick={add} disabled={!(Number(f.amount) > 0)}>
            {t("Add")}
          </Button>
        </Card>
      )}
      {branch && <PartnerAccounts branch={branch} canAdd={!!canAdd} />}
      <Input
        className="mb-3 max-w-sm bg-card"
        placeholder="Search category, note or branch"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("Date")}</TableHead>
              <TableHead>{t("Branch")}</TableHead>
              <TableHead>{t("Category")}</TableHead>
              <TableHead>{t("Note")}</TableHead>
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
                <TableCell
                  className={`text-right tabular ${x.kind === "income" ? "text-success" : "text-destructive"}`}
                >
                  {x.kind === "income" ? "+" : "−"} {taka(x.amount)}
                </TableCell>
                <TableCell className="text-right">
                  {canAdd &&
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
                <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                  {data.length ? "No entries match this search." : "No transactions yet."}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}
