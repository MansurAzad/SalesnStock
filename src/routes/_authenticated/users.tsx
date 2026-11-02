import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { PageHeader } from "@/components/BranchPicker";
import { roleLabel, useBranches, useMe } from "@/lib/erp";
import { useT } from "@/lib/i18n";
import { Card } from "@/components/ui/card";
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

export const Route = createFileRoute("/_authenticated/users")({
  head: () => ({ meta: [{ title: "Users & roles — Dealer ERP" }] }),
  component: Users,
});

type Role = "super_admin" | "dealer_admin" | "branch_manager" | "sales" | "accountant" | "auditor";

function Users() {
  const { t } = useT();
  const { data: me } = useMe();
  const qc = useQueryClient();
  const { data: branches = [] } = useBranches();
  const { data = [] } = useQuery({
    queryKey: ["users"],
    queryFn: async () => {
      const [profiles, roleRows] = await Promise.all([
        fetchAllPages(supabase.from("profiles").select("*").order("created_at")),
        fetchAllPages(supabase.from("user_roles").select("*")),
      ]);
      return profiles.map((x) => ({
        ...x,
        role: roleRows.find((y) => y.user_id === x.id)?.role ?? "",
      }));
    },
  });
  const [edits, setEdits] = useState<Record<string, { role: string; branch: string }>>({});
  const [search, setSearch] = useState("");
  const shown = data.filter(
    (u) =>
      !search ||
      `${u.full_name ?? ""} ${u.email ?? ""} ${roleLabel[u.role] ?? u.role} ${branches.find((b) => b.id === u.branch_id)?.name ?? ""}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );

  async function save(id: string) {
    const row = data.find((d) => d.id === id)!;
    const e = edits[id] ?? { role: row.role, branch: row.branch_id ?? "none" };
    if (!e.role) {
      toast.error("Choose a role");
      return;
    }
    const { error } = await supabase.rpc("admin_set_user", {
      _user: id,
      _role: e.role as Role,
      _branch: (e.branch === "none" ? null : e.branch) as string,
    });
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Saved");
    qc.invalidateQueries({ queryKey: ["users"] });
  }

  async function revoke(id: string, name: string | null) {
    if (
      !window.confirm(
        `Revoke access for ${name || "this user"}? Their account and historical records will remain.`,
      )
    )
      return;
    const { error } = await supabase.rpc("admin_revoke_user_access", { _user: id });
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("User access revoked");
    setEdits((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
    qc.invalidateQueries({ queryKey: ["users"] });
  }

  const roles = Object.keys(roleLabel).filter(
    (r) => r !== "super_admin" || me?.roles.includes("super_admin"),
  );

  return (
    <div>
      <PageHeader title={t("Users")} />
      <p className="mb-4 text-sm text-muted-foreground">
        Staff sign up themselves, then you assign their role and branch here. Showroom roles need a
        branch.
      </p>
      <Input
        className="mb-3 max-w-sm bg-card"
        placeholder="Search name, email, role or branch"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("Name")}</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>{t("Role")}</TableHead>
              <TableHead>{t("Branch")}</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {shown.map((u) => {
              const e = edits[u.id] ?? { role: u.role, branch: u.branch_id ?? "none" };
              const set = (patch: Partial<typeof e>) =>
                setEdits({ ...edits, [u.id]: { ...e, ...patch } });
              return (
                <TableRow key={u.id}>
                  <TableCell className="font-medium">{u.full_name}</TableCell>
                  <TableCell>{u.email}</TableCell>
                  <TableCell>
                    <Select
                      value={e.role}
                      onValueChange={(v) => set({ role: v })}
                      disabled={!me?.canWriteHq}
                    >
                      <SelectTrigger className="w-48">
                        <SelectValue placeholder="No role" />
                      </SelectTrigger>
                      <SelectContent>
                        {roles.map((r) => (
                          <SelectItem key={r} value={r}>
                            {roleLabel[r]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </TableCell>
                  <TableCell>
                    <Select
                      value={e.branch}
                      onValueChange={(v) => set({ branch: v })}
                      disabled={!me?.canWriteHq}
                    >
                      <SelectTrigger className="w-56">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">— None (HQ) —</SelectItem>
                        {branches.map((b) => (
                          <SelectItem key={b.id} value={b.id}>
                            {b.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </TableCell>
                  <TableCell>
                    {me?.canWriteHq && (
                      <div className="flex gap-2">
                        <Button size="sm" onClick={() => save(u.id)}>
                          {t("Save")}
                        </Button>
                        {u.role && u.id !== me.id && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="text-destructive"
                            onClick={() => revoke(u.id, u.full_name)}
                          >
                            Revoke
                          </Button>
                        )}
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
            {shown.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                  {data.length ? "No users match this search." : "No users yet."}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}
