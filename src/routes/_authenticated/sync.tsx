import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { PageHeader } from "@/components/BranchPicker";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { dismiss, syncNow, useOnline, useOutbox, deviceName } from "@/lib/offline";
import { useMe } from "@/lib/erp";
import { useT } from "@/lib/i18n";
import { fetchAllPages } from "@/lib/paginated-query";

export const Route = createFileRoute("/_authenticated/sync")({
  head: () => ({
    meta: [
      { title: "Offline sync — Dealer ERP" },
      { name: "description", content: "Entries saved without internet and sync conflicts." },
    ],
  }),
  component: SyncPage,
});

function SyncPage() {
  const { t } = useT();
  const online = useOnline();
  const box = useOutbox();
  const qc = useQueryClient();
  const { data: me } = useMe();
  // deviceName() writes to localStorage — resolve it once, not on every render.
  const [device] = useState(deviceName);
  const { data: conflicts = [] } = useQuery({
    queryKey: ["offline-conflicts"],
    queryFn: async () => {
      return fetchAllPages(
        supabase
          .from("offline_ops")
          .select("*")
          .eq("status", "conflict")
          .eq("resolved", false)
          .order("synced_at", { ascending: false }),
      );
    },
  });

  async function run() {
    try {
      const r = await syncNow();
      if (r.applied || r.conflicts)
        toast.success(`${r.applied} synced${r.conflicts ? `, ${r.conflicts} conflicts` : ""}`);
      else toast.info("Nothing to sync");
      qc.invalidateQueries();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }
  async function resolve(ref: string) {
    const { error } = await supabase
      .from("offline_ops")
      .update({ resolved: true, resolved_by: me?.id ?? null })
      .eq("client_ref", ref);
    if (error) {
      toast.error(error.message);
      return;
    }
    qc.invalidateQueries({ queryKey: ["offline-conflicts"] });
  }

  // Resolving a conflict needs the "managers resolve offline conflicts" RLS policy.
  const canResolve = !!me && (me.canWriteHq || me.roles.includes("branch_manager"));

  return (
    <div>
      <PageHeader title={t("Offline sync")}>
        <Badge variant={online ? "default" : "destructive"}>
          {online ? t("Online") : "Offline"}
        </Badge>
        <Button onClick={run} disabled={!online || box.pending === 0}>
          Sync now
        </Button>
      </PageHeader>
      <p className="mb-4 text-sm text-muted-foreground">
        Device: <span className="font-mono">{device}</span>. Without internet, POS sales, kisti
        collections and expenses are saved here and sent automatically when the connection returns.
        If the same phone was sold elsewhere first, the later sale is rejected and listed below for
        a manager.
      </p>
      <h2 className="mb-2 font-semibold">On this device</h2>
      <Card className="mb-8">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Saved</TableHead>
              <TableHead>Entry</TableHead>
              <TableHead>Status</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {box.ops.map((o) => (
              <TableRow key={o.client_ref}>
                <TableCell className="whitespace-nowrap text-xs">
                  {new Date(o.queued_at).toLocaleString()}
                </TableCell>
                <TableCell>{o.label}</TableCell>
                <TableCell>
                  {o.state === "pending" ? (
                    <Badge variant="secondary">Waiting</Badge>
                  ) : (
                    <span className="text-sm text-destructive">{o.error}</span>
                  )}
                </TableCell>
                <TableCell className="text-right">
                  {o.state === "conflict" && (
                    <Button size="sm" variant="outline" onClick={() => dismiss(o.client_ref)}>
                      Dismiss
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
            {box.ops.length === 0 && (
              <TableRow>
                <TableCell colSpan={4} className="py-8 text-center text-muted-foreground">
                  Nothing waiting.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Card>
      <h2 className="mb-2 font-semibold">Rejected on sync (all devices)</h2>
      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Made offline</TableHead>
              <TableHead>Device</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Reason</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {conflicts.map((c) => (
              <TableRow key={c.client_ref}>
                <TableCell className="whitespace-nowrap text-xs">
                  {new Date(c.queued_at).toLocaleString()}
                </TableCell>
                <TableCell className="font-mono text-xs">{c.device}</TableCell>
                <TableCell className="capitalize">{c.kind}</TableCell>
                <TableCell className="text-sm text-destructive">{c.error}</TableCell>
                <TableCell className="text-right">
                  {canResolve && (
                    <Button size="sm" variant="outline" onClick={() => resolve(c.client_ref)}>
                      Mark handled
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
            {conflicts.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                  No conflicts.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}
