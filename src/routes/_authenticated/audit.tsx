import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Download } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { PageHeader } from "@/components/BranchPicker";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
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
import { downloadCsv } from "@/lib/csv";
import { localDate, localDayEndIso, localDayStartIso } from "@/lib/date";
import { useMe } from "@/lib/erp";
import { HqOnly } from "@/components/HqOnly";

/** Rows rendered in the table; the CSV export always contains every filtered row. */
const MAX_ROWS = 500;

export const Route = createFileRoute("/_authenticated/audit")({
  head: () => ({
    meta: [
      { title: "Audit log — Dealer ERP" },
      { name: "description", content: "Who did what and when across all showrooms." },
    ],
  }),
  component: Audit,
});

/** Details are stored as JSON — render them as a flat string for the table and the export. */
const detailsText = (details: unknown) =>
  details === null || details === undefined ? "" : JSON.stringify(details);

function Audit() {
  const { data: me } = useMe();
  const [q, setQ] = useState("");
  const [action, setAction] = useState("all");
  const [from, setFrom] = useState(localDate(new Date(Date.now() - 7 * 86400000)));
  const [to, setTo] = useState(localDate());
  const { data = [], error } = useQuery({
    queryKey: ["audit", from, to],
    enabled: !!me?.isHq,
    queryFn: async () => {
      const [logs, people] = await Promise.all([
        fetchAllPages(
          supabase
            .from("audit_logs")
            .select("*")
            .gte("created_at", localDayStartIso(from))
            .lte("created_at", localDayEndIso(to))
            .order("created_at", { ascending: false }),
        ),
        fetchAllPages(supabase.from("profiles").select("id,full_name,email")),
      ]);
      const name = new Map(people.map((p) => [p.id, p.full_name || p.email]));
      return logs.map((l) => ({ ...l, who: (l.user_id && name.get(l.user_id)) || "system" }));
    },
  });

  // The distinct actions available in the selected period.
  const actions = useMemo(
    () => [...new Set(data.map((r) => r.action))].sort((a, b) => a.localeCompare(b)),
    [data],
  );

  const rows = useMemo(
    () =>
      data.filter(
        (r) =>
          (action === "all" || r.action === action) &&
          (!q ||
            `${r.action} ${r.who} ${detailsText(r.details)}`
              .toLowerCase()
              .includes(q.toLowerCase())),
      ),
    [data, action, q],
  );

  // A new period has a different set of actions, so a stale filter would
  // hide every row without saying why.
  function changePeriod(nextFrom: string, nextTo: string) {
    setFrom(nextFrom);
    setTo(nextTo);
    setAction("all");
  }

  const visible = rows.slice(0, MAX_ROWS);

  function exportCsv() {
    downloadCsv(
      rows.map((r) => ({
        Time: new Date(r.created_at).toLocaleString(),
        User: r.who,
        Action: r.action,
        Details: detailsText(r.details),
      })),
      `audit_${from}_${to}.csv`,
    );
  }

  return (
    <HqOnly>
      <div>
        <PageHeader title="Audit log">
          <div className="flex items-center gap-1">
            <Label htmlFor="audit-from" className="text-xs">
              From
            </Label>
            <Input
              id="audit-from"
              type="date"
              className="w-40"
              value={from}
              onChange={(e) => changePeriod(e.target.value, to)}
            />
          </div>
          <div className="flex items-center gap-1">
            <Label htmlFor="audit-to" className="text-xs">
              To
            </Label>
            <Input
              id="audit-to"
              type="date"
              className="w-40"
              value={to}
              onChange={(e) => changePeriod(from, e.target.value)}
            />
          </div>
          <div className="flex items-center gap-1">
            <Label htmlFor="audit-action" className="text-xs">
              Action
            </Label>
            <Select value={action} onValueChange={setAction}>
              <SelectTrigger id="audit-action" className="w-44 bg-card">
                <SelectValue placeholder="All actions" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All actions</SelectItem>
                {actions.map((a) => (
                  <SelectItem key={a} value={a}>
                    {a}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Input
            id="audit-search"
            aria-label="Search the audit log"
            className="w-64"
            placeholder="Search action, user, details…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </PageHeader>
        {error && (
          <p className="mb-3 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            Could not load the audit log: {error.message}
          </p>
        )}
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-2 border-b p-3">
            <span className="text-sm text-muted-foreground">
              Showing {visible.length} of {rows.length} rows
            </span>
            <Button
              size="sm"
              variant="outline"
              disabled={!rows.length}
              onClick={exportCsv}
              aria-label="Export the filtered audit log as CSV"
            >
              <Download className="mr-1 h-4 w-4" /> CSV
            </Button>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Time</TableHead>
                <TableHead>User</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Details</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="whitespace-nowrap text-xs">
                    {new Date(r.created_at).toLocaleString()}
                  </TableCell>
                  <TableCell>{r.who}</TableCell>
                  <TableCell className="font-mono text-xs">{r.action}</TableCell>
                  <TableCell className="max-w-xl break-all font-mono text-[11px] text-muted-foreground">
                    {detailsText(r.details)}
                  </TableCell>
                </TableRow>
              ))}
              {visible.length === 0 && (
                <TableRow>
                  <TableCell colSpan={4} className="py-8 text-center text-muted-foreground">
                    No entries.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
          {rows.length > MAX_ROWS && (
            <div className="p-2 text-center text-xs text-muted-foreground">
              Showing the first {MAX_ROWS} rows — the CSV export contains all {rows.length} filtered
              rows.
            </div>
          )}
        </Card>
      </div>
    </HqOnly>
  );
}
