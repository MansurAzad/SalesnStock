import { useQuery } from "@tanstack/react-query";
import { Fragment, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { taka } from "@/lib/erp";
import { Card } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { fetchAllPages } from "@/lib/paginated-query";
import { methodLabel } from "@/lib/payment-methods";

/** Partner balance: unpaid sale receivables owed to the showroom by each partner. */
export function partnerBalance(
  cases: { amount: number; commission: number; status: string }[],
  ledger: { kind: string; amount: number }[],
) {
  const owed = cases
    .filter((c) => c.status !== "cancelled")
    .reduce(
      (sum, c) => sum + Number(c.amount) - (c.status === "settled" ? Number(c.commission) : 0),
      0,
    );
  const received = ledger
    .filter((entry) => entry.kind === "received")
    .reduce((sum, entry) => sum + Number(entry.amount), 0);
  return owed - received;
}

export function PartnerAccounts({ branch }: { branch: string }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const { data } = useQuery({
    queryKey: ["partner-accounts", branch],
    enabled: !!branch,
    queryFn: async () => {
      let c = supabase.from("finance_cases").select("partner_id, amount, commission, status");
      let l = supabase
        .from("finance_partner_ledger")
        .select("*")
        .order("created_at", { ascending: false });
      if (branch !== "all") {
        c = c.eq("branch_id", branch);
        l = l.eq("branch_id", branch);
      }
      const [partners, cases, ledger] = await Promise.all([
        fetchAllPages(supabase.from("finance_partners").select("*").order("name")),
        fetchAllPages(c),
        fetchAllPages(l),
      ]);
      return { partners, cases, ledger };
    },
  });
  const partners = data?.partners ?? [];

  return (
    <Card className="mb-4 p-4">
      <div className="mb-1 font-semibold">Finance partner receivables</div>
      <p className="mb-3 text-xs text-muted-foreground">
        Partner receipts are posted from the linked sale in Finance after the money reaches the
        business bank account. This statement is read-only to prevent duplicate receipts or outgoing
        partner payments.
      </p>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Partner</TableHead>
            <TableHead className="text-right">Received</TableHead>
            <TableHead className="text-right">Partner owes us</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {partners.map((partner) => {
            const cases = (data?.cases ?? []).filter((item) => item.partner_id === partner.id);
            const ledger = (data?.ledger ?? []).filter((item) => item.partner_id === partner.id);
            const received = ledger
              .filter((item) => item.kind === "received")
              .reduce((sum, item) => sum + Number(item.amount), 0);
            const open = expanded === partner.id;
            return (
              <Fragment key={partner.id}>
                <TableRow>
                  <TableCell>
                    <button
                      type="button"
                      className="text-left hover:underline"
                      aria-expanded={open}
                      onClick={() => setExpanded(open ? null : partner.id)}
                    >
                      {partner.name}
                    </button>
                  </TableCell>
                  <TableCell className="text-right tabular">{taka(received)}</TableCell>
                  <TableCell className="text-right tabular font-semibold">
                    {taka(partnerBalance(cases, ledger))}
                  </TableCell>
                </TableRow>
                {open && (
                  <TableRow>
                    <TableCell colSpan={3} className="bg-muted/40">
                      {ledger.length === 0 ? (
                        <span className="text-sm text-muted-foreground">
                          No settlement history with {partner.name} yet.
                        </span>
                      ) : (
                        <div className="space-y-1">
                          <div className="text-xs font-semibold uppercase text-muted-foreground">
                            Settlement statement — {partner.name}
                          </div>
                          {ledger.map((entry) => (
                            <div
                              key={entry.id}
                              className="flex flex-wrap items-center justify-between gap-2 text-sm"
                            >
                              <span>
                                {new Date(entry.created_at).toLocaleString()} ·{" "}
                                {entry.kind === "received" ? "Received" : "Legacy outgoing entry"}
                                {entry.note ? ` — ${entry.note}` : ""}
                              </span>
                              <span className="tabular">
                                {entry.kind === "received" ? "+" : "−"} {taka(entry.amount)} (
                                {methodLabel(entry.method ?? "bank")})
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                )}
              </Fragment>
            );
          })}
          {!partners.length && (
            <TableRow>
              <TableCell colSpan={3} className="py-6 text-center text-muted-foreground">
                No finance partners yet — add them on the Finance page.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </Card>
  );
}
