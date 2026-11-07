import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { taka } from "@/lib/erp";
import { useT } from "@/lib/i18n";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { EXPENSE_METHODS, methodLabel } from "@/lib/payment-methods";
import { dhakaDate } from "@/lib/date";

/**
 * The showroom day book (requirement B): the opening till, every bucket of
 * money that came in or went out today, and the count that closes the day.
 *
 * The figures are not added up in the browser. daily_cash_reconciliation reads
 * the same ledger rows the rest of the app writes, buckets them by the Dhaka
 * calendar day, and hands back the closing figure, so what the screen shows is
 * what the database proved.
 */
export function DailyCash({ branch, canWrite }: { branch: string; canWrite: boolean }) {
  const { t } = useT();
  const qc = useQueryClient();
  // The day boundary the ledger buckets by is the Dhaka calendar day, so the
  // screen opens on the same day the server is counting.
  const [day, setDay] = useState(() => dhakaDate());
  const [opening, setOpening] = useState("");
  const [counted, setCounted] = useState("");
  const [note, setNote] = useState("");
  const [dep, setDep] = useState({ amount: "", method: "cash", note: "" });
  // Only copy the saved numbers into the boxes the first time a day loads, so
  // typing is never overwritten by a background refetch.
  const [seeded, setSeeded] = useState("");

  const {
    data: s,
    error,
    isFetching,
  } = useQuery({
    queryKey: ["daily-cash", branch, day],
    enabled: !!branch && branch !== "all",
    queryFn: async () => {
      const { data, error } = await supabase.rpc("daily_cash_reconciliation", {
        _branch: branch,
        _day: day,
      });
      if (error) throw error;
      return data?.[0] ?? null;
    },
  });

  useEffect(() => {
    if (!s) return;
    const key = `${branch}|${day}`;
    if (seeded === key) return;
    setOpening(String(Number(s.opening_cash)));
    setCounted(s.counted_cash === null ? "" : String(Number(s.counted_cash)));
    setSeeded(key);
  }, [s, branch, day, seeded]);

  async function save() {
    const n = (v: string) => (v.trim() === "" ? null : Number(v));
    const o = n(opening);
    const c = n(counted);
    if (o !== null && (!Number.isFinite(o) || o < 0)) {
      toast.error("Opening cash cannot be negative");
      return;
    }
    if (c !== null && (!Number.isFinite(c) || c < 0)) {
      toast.error("Counted cash cannot be negative");
      return;
    }
    if (o === null && c === null) {
      toast.error("Enter the opening cash, the counted cash, or both");
      return;
    }
    const { error } = await supabase.rpc("save_daily_cash_opening", {
      _branch: branch,
      _day: day,
      _opening: o,
      _counted: c,
      _note: note.trim(),
    });
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Day book saved");
    setNote("");
    qc.invalidateQueries({ queryKey: ["daily-cash"] });
    qc.invalidateQueries({ queryKey: ["transactions"] });
  }

  async function deposit() {
    const amount = Number(dep.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      toast.error("Enter an amount greater than zero");
      return;
    }
    const { error } = await supabase.rpc("record_hq_deposit", {
      _branch: branch,
      _amount: amount,
      _method: dep.method,
      _note: dep.note.trim(),
    });
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Deposit recorded");
    setDep({ amount: "", method: "cash", note: "" });
    qc.invalidateQueries({ queryKey: ["daily-cash"] });
    qc.invalidateQueries({ queryKey: ["transactions"] });
  }

  // A line that moves no cash is a memo: useful in the day book, but it must
  // not look like part of the till when somebody balances the drawer.
  const line = (label: string, value: number, opts: { memo?: boolean; cash?: boolean } = {}) => (
    <div className="flex items-baseline justify-between gap-3 py-1 text-sm">
      <span className={opts.memo ? "text-muted-foreground" : ""}>{t(label)}</span>
      <span
        className={`tabular ${
          opts.memo ? "text-muted-foreground" : opts.cash ? "font-semibold text-success" : ""
        }`}
      >
        {taka(value)}
      </span>
    </div>
  );

  return (
    <Card className="mb-4 p-4">
      <div className="mb-3 flex flex-wrap items-end gap-2">
        <h2 className="mr-auto text-base font-medium">{t("Daily cash")}</h2>
        <div className="space-y-1">
          <Label className="text-xs" htmlFor="dc-day">
            {t("Date")}
          </Label>
          <Input
            id="dc-day"
            type="date"
            className="w-40"
            value={day}
            onChange={(e) => setDay(e.target.value)}
          />
        </div>
        {day !== dhakaDate() && (
          <Button variant="ghost" size="sm" onClick={() => setDay(dhakaDate())}>
            Today
          </Button>
        )}
      </div>
      {error && (
        <p className="mb-3 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          Could not build the day book: {error.message}
        </p>
      )}
      {!s && !error && !isFetching && (
        <p className="text-sm text-muted-foreground">Choose a branch to see its day book.</p>
      )}
      {s && (
        <>
          <div className="grid gap-x-6 md:grid-cols-2">
            <div>
              <div className="mb-1 text-xs uppercase text-muted-foreground">{t("Money in")}</div>
              {line("Opening cash", Number(s.opening_cash), { cash: true })}
              {line("Cash sales", Number(s.cash_sales), { cash: true })}
              {line("Bank / card sales", Number(s.bank_card_sales))}
              {line("MFS sales", Number(s.mfs_sales))}
              {line("Sold on kisti today, still to collect", Number(s.credit_sales), {
                memo: true,
              })}
              {line("Kisti collected today", Number(s.collections))}
              {line("of which cash", Number(s.cash_collections), { cash: true })}
              {line("of which bKash / Nagad / Rocket", Number(s.mfs_collections), { memo: true })}
              {line("Other income today", Number(s.other_income))}
              {line("of which cash", Number(s.cash_other_income), { cash: true })}
            </div>
            <div>
              <div className="mb-1 mt-3 text-xs uppercase text-muted-foreground md:mt-6">
                {t("Money out")}
              </div>
              {line("Expenses today", Number(s.expenses))}
              {line("of which cash", Number(s.cash_expenses), { cash: true })}
              {line("Deposited to head office", Number(s.hq_deposits))}
              {line("of which cash", Number(s.cash_deposits), { cash: true })}
              <div className="mt-4 rounded-md border bg-muted/40 p-3">
                <div className="flex items-baseline justify-between">
                  <span className="text-sm">{t("Closing cash")}</span>
                  <span className="font-display text-xl tabular">{taka(s.closing_cash)}</span>
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {t("opening + cash sales + cash collected − cash spent − cash deposited")}
                </div>
                <div className="mt-2 flex items-baseline justify-between">
                  <span className="text-sm">{t("Counted in the drawer")}</span>
                  <span className="tabular">
                    {s.counted_cash === null ? "—" : taka(s.counted_cash)}
                  </span>
                </div>
                <div className="mt-1 flex items-baseline justify-between">
                  <span className="text-sm">{t("Variance")}</span>
                  <span
                    className={`tabular ${
                      s.variance !== null && Math.abs(Number(s.variance)) >= 0.005
                        ? "font-semibold text-destructive"
                        : ""
                    }`}
                  >
                    {s.variance === null ? "—" : taka(s.variance)}
                  </span>
                </div>
                <div className="mt-2">
                  {s.balanced ? (
                    <span className="rounded-full bg-success/15 px-2 py-0.5 text-xs font-semibold text-success">
                      {t("Balanced")}
                    </span>
                  ) : (
                    <span className="rounded-full bg-warning/20 px-2 py-0.5 text-xs font-semibold text-accent-foreground">
                      {s.counted_cash === null
                        ? t("Not counted yet")
                        : t("Does not match the drawer")}
                    </span>
                  )}
                </div>
              </div>
            </div>
          </div>
          {canWrite && (
            <div className="mt-4 grid gap-2 border-t pt-4 md:grid-cols-4">
              <div className="space-y-1">
                <Label className="text-xs" htmlFor="dc-opening">
                  {t("Opening cash")}
                </Label>
                <Input
                  id="dc-opening"
                  type="number"
                  min={0}
                  step="0.01"
                  value={opening}
                  onChange={(e) => setOpening(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs" htmlFor="dc-counted">
                  {t("Counted cash at close")}
                </Label>
                <Input
                  id="dc-counted"
                  type="number"
                  min={0}
                  step="0.01"
                  value={counted}
                  onChange={(e) => setCounted(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs" htmlFor="dc-note">
                  {t("Note")}
                </Label>
                <Input
                  id="dc-note"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder={t("Any explanation of a difference")}
                />
              </div>
              <div className="flex items-end">
                <Button className="w-full" onClick={save}>
                  {t("Save day book")}
                </Button>
              </div>
              <div className="space-y-1">
                <Label className="text-xs" htmlFor="dc-dep-amount">
                  {t("Deposit to head office")}
                </Label>
                <Input
                  id="dc-dep-amount"
                  type="number"
                  min={0}
                  step="0.01"
                  value={dep.amount}
                  onChange={(e) => setDep({ ...dep, amount: e.target.value })}
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs" htmlFor="dc-dep-method">
                  {t("Method")}
                </Label>
                <select
                  id="dc-dep-method"
                  className="w-full rounded-md border bg-background px-2 py-2"
                  value={dep.method}
                  onChange={(e) => setDep({ ...dep, method: e.target.value })}
                >
                  {EXPENSE_METHODS.map((m) => (
                    <option key={m} value={m}>
                      {methodLabel(m)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <Label className="text-xs" htmlFor="dc-dep-note">
                  {t("Note")}
                </Label>
                <Input
                  id="dc-dep-note"
                  value={dep.note}
                  onChange={(e) => setDep({ ...dep, note: e.target.value })}
                  placeholder={t("Slip or reference")}
                />
              </div>
              <div className="flex items-end">
                <Button
                  className="w-full"
                  variant="outline"
                  onClick={deposit}
                  disabled={!(Number(dep.amount) > 0)}
                >
                  {t("Record deposit")}
                </Button>
              </div>
            </div>
          )}
        </>
      )}
    </Card>
  );
}
