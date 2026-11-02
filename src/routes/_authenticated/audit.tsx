import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { PageHeader } from "@/components/BranchPicker";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { fetchAllPages } from "@/lib/paginated-query";

export const Route = createFileRoute("/_authenticated/audit")({
  head: () => ({ meta: [
    { title: "Audit log — Dealer ERP" },
    { name: "description", content: "Who did what and when across all showrooms." },
  ] }),
  component: Audit,
});

function Audit() {
  const [q, setQ] = useState("");
  const [from, setFrom] = useState(new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10));
  const { data = [] } = useQuery({
    queryKey: ["audit", from],
    queryFn: async () => {
      const [{ data: logs }, { data: people }] = await Promise.all([
        fetchAllPages(supabase.from("audit_logs").select("*").gte("created_at", from).order("created_at", { ascending: false })),
        fetchAllPages(supabase.from("profiles").select("id,full_name,email")),
      ]);
      const name = new Map(people.map((p) => [p.id, p.full_name || p.email]));
      return logs.map((l) => ({ ...l, who: (l.user_id && name.get(l.user_id)) || "system" }));
    },
  });
  const rows = data.filter((r) => !q || `${r.action} ${r.who} ${JSON.stringify(r.details)}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <div>
      <PageHeader title="Audit log">
        <Input type="date" className="w-40" value={from} onChange={(e) => setFrom(e.target.value)} />
        <Input className="w-56" placeholder="Search action, user, IMEI…" value={q} onChange={(e) => setQ(e.target.value)} />
      </PageHeader>
      <Card>
        <Table>
          <TableHeader><TableRow><TableHead>Time</TableHead><TableHead>User</TableHead><TableHead>Action</TableHead><TableHead>Details</TableHead></TableRow></TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.id}>
                <TableCell className="whitespace-nowrap text-xs">{new Date(r.created_at).toLocaleString()}</TableCell>
                <TableCell>{r.who}</TableCell>
                <TableCell className="font-mono text-xs">{r.action}</TableCell>
                <TableCell className="max-w-xl break-all font-mono text-[11px] text-muted-foreground">{JSON.stringify(r.details)}</TableCell>
              </TableRow>
            ))}
            {rows.length === 0 && <TableRow><TableCell colSpan={4} className="py-8 text-center text-muted-foreground">No entries.</TableCell></TableRow>}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}
