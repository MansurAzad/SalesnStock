import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { PageHeader } from "@/components/BranchPicker";
import { roleLabel, useBranches, useMe } from "@/lib/erp";
import { useT } from "@/lib/i18n";
import { HqOnly } from "@/components/HqOnly";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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

/** A pending role change, with the server values it was based on. */
type Edit = { role: string; branch: string; base: string };

type UserRow = { id: string; role: string; branch_id: string | null };

const baseOf = (u: UserRow) => `${u.role}|${u.branch_id ?? "none"}`;

function Users() {
  const { t } = useT();
  const { data: me } = useMe();
  const qc = useQueryClient();
  const { data: branches = [] } = useBranches();
  const { data = [], error } = useQuery({
    queryKey: ["users"],
    enabled: !!me?.isHq,
    queryFn: async () => {
      const [profiles, roleRows] = await Promise.all([
        fetchAllPages(supabase.from("profiles").select("*").order("created_at")),
        fetchAllPages(supabase.from("user_roles").select("*")),
      ]);
      return profiles.map((x) => {
        const roles = roleRows.filter((y) => y.user_id === x.id).map((y) => y.role as string);
        return { ...x, roles, role: roles[0] ?? "" };
      });
    },
  });
  const [edits, setEdits] = useState<Record<string, Edit>>({});
  const [search, setSearch] = useState("");
  const shown = data.filter(
    (u) =>
      !search ||
      `${u.full_name ?? ""} ${u.email ?? ""} ${u.roles.map((r) => roleLabel[r] ?? r).join(" ")} ${branches.find((b) => b.id === u.branch_id)?.name ?? ""}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );

  // A pending change is only valid while the server row still looks the way it
  // did when the change was made. If the row moved on, the edit is dropped so
  // nobody saves a role that was changed elsewhere.
  const pendingEdit = (u: UserRow): Edit | null => {
    const cur = edits[u.id];
    if (!cur) return null;
    if (cur.base !== baseOf(u)) return null;
    if (cur.role === u.role && cur.branch === (u.branch_id ?? "none")) return null;
    return cur;
  };

  async function save(id: string) {
    const row = data.find((d) => d.id === id);
    if (!row) return;
    const pending = pendingEdit(row);
    const e = pending ?? { role: row.role, branch: row.branch_id ?? "none" };
    if (!e.role) {
      toast.error("Choose a role");
      return;
    }
    // Showroom roles are locked to one branch by the database — catch it here
    // so the admin gets a clear message instead of a raw constraint error.
    if ((e.role === "sales" || e.role === "branch_manager") && e.branch === "none") {
      toast.error("Sales and Branch Manager need a branch");
      return;
    }
    const extra = row.roles.filter((r) => r !== e.role);
    if (
      extra.length &&
      !window.confirm(
        `${row.full_name ?? "This user"} also has ${extra.map((r) => roleLabel[r] ?? r).join(", ")}. Saving replaces all roles with ${roleLabel[e.role] ?? e.role}. Continue?`,
      )
    )
      return;
    const { error } = await supabase.rpc("admin_set_user", {
      _user: id,
      _role: e.role as Role,
      _branch: (e.branch === "none" ? null : e.branch) as string | null,
    });
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Saved");
    setEdits((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
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

  const isSuper = !!me?.roles.includes("super_admin");
  const anySuper = data.some((u) => u.roles.includes("super_admin"));
  // Only a super admin manages super admins — but if the project has none, any
  // HQ admin may appoint one, or nobody could ever reach the admin screens.
  const roles = Object.keys(roleLabel).filter((r) => r !== "super_admin" || isSuper || !anySuper);

  return (
    <HqOnly>
      <div>
        <PageHeader title={t("Users")} />
        <p className="mb-4 text-sm text-muted-foreground">
          Staff sign up themselves, then you assign their role and branch here. Showroom roles need
          a branch.
        </p>
        <Input
          className="mb-3 max-w-sm bg-card"
          aria-label="Search users"
          placeholder="Search name, email, role or branch"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {error && (
          <p className="mb-3 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            Could not load the users: {error.message}
          </p>
        )}
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
                const pending = pendingEdit(u);
                const e = pending ?? { role: u.role, branch: u.branch_id ?? "none" };
                // A super admin can only be touched by another super admin.
                const locked = u.roles.includes("super_admin") && !isSuper;
                const set = (patch: Partial<{ role: string; branch: string }>) =>
                  setEdits((current) => {
                    const base = baseOf(u);
                    const prev = current[u.id];
                    const prevBase =
                      prev && prev.base === base
                        ? prev
                        : { role: u.role, branch: u.branch_id ?? "none" };
                    return { ...current, [u.id]: { ...prevBase, ...patch, base } };
                  });
                return (
                  <TableRow key={u.id}>
                    <TableCell className="font-medium">{u.full_name}</TableCell>
                    <TableCell>{u.email}</TableCell>
                    <TableCell>
                      <Select
                        value={e.role}
                        onValueChange={(v) => set({ role: v })}
                        disabled={!me?.canWriteHq || locked}
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
                      {u.roles.length > 1 && (
                        <div className="mt-1 text-xs text-muted-foreground">
                          Also:{" "}
                          {u.roles
                            .slice(1)
                            .map((r) => roleLabel[r] ?? r)
                            .join(", ")}
                        </div>
                      )}
                      {u.roles.length === 0 && (
                        <div className="mt-1 text-xs text-muted-foreground">Access revoked</div>
                      )}
                    </TableCell>
                    <TableCell>
                      <Select
                        value={e.branch}
                        onValueChange={(v) => set({ branch: v })}
                        disabled={!me?.canWriteHq || locked}
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
                          <Button
                            size="sm"
                            disabled={!pending || locked}
                            onClick={() => save(u.id)}
                          >
                            {t("Save")}
                          </Button>
                          {u.role && u.id !== me.id && (
                            <Button
                              size="sm"
                              variant="ghost"
                              className="text-destructive"
                              disabled={locked}
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
    </HqOnly>
  );
}
