import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { BranchPicker, PageHeader } from "@/components/BranchPicker";
import { taka, useBranches } from "@/lib/erp";
import { downloadCsv } from "@/lib/csv";
import { useT } from "@/lib/i18n";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { fetchAllPages } from "@/lib/paginated-query";

export const Route = createFileRoute("/_authenticated/employees")({
  head: () => ({
    meta: [
      { title: "Employees & attendance — Dealer ERP" },
      { name: "description", content: "Staff list and daily attendance per showroom." },
    ],
  }),
  component: Employees,
});

const STATUSES = ["present", "late", "absent", "leave"] as const;
const today = () => new Date().toISOString().slice(0, 10);
const nowTime = () => new Date().toTimeString().slice(0, 5);

function Employees() {
  const { t } = useT();
  const { data: me } = useMe();
  const [branch, setBranch] = useState("");
  const { data: branches = [] } = useBranches();
  const { data: emps = [] } = useQuery({
    queryKey: ["employees", branch],
    enabled: !!branch,
    queryFn: async () => {
      let q = supabase.from("employees").select("*").order("name");
      if (branch !== "all") q = q.eq("branch_id", branch);
      return fetchAllPages(q);
    },
  });
  const bname = (id: string) => branches.find((b) => b.id === id)?.name ?? "";
  return (
    <div>
      <PageHeader title={t("Employees")}>
        <BranchPicker value={branch} onChange={setBranch} allowAll />
      </PageHeader>
      <Tabs defaultValue="attendance">
        <TabsList>
          <TabsTrigger value="attendance">Attendance</TabsTrigger>
          <TabsTrigger value="staff">Staff</TabsTrigger>
          <TabsTrigger value="monthly">Monthly summary</TabsTrigger>
        </TabsList>
        <TabsContent value="attendance">
          <Daily emps={emps.filter((e) => e.active)} branch={branch} />
        </TabsContent>
        <TabsContent value="staff">
          <Staff
            emps={emps}
            branch={branch}
            bname={bname}
            canManage={!!me && (me.canWriteHq || me.roles.includes("branch_manager"))}
          />
        </TabsContent>
        <TabsContent value="monthly">
          <Monthly emps={emps} branch={branch} bname={bname} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

type Emp = {
  id: string;
  name: string;
  branch_id: string;
  designation: string | null;
  phone: string | null;
  salary: number;
  active: boolean;
};

function Daily({ emps, branch }: { emps: Emp[]; branch: string }) {
  const qc = useQueryClient();
  const { data: me } = useMe();
  const [day, setDay] = useState(today());
  const canMark = (branchId: string) =>
    !!me &&
    (me.canWriteHq ||
      (me.branch_id === branchId &&
        me.roles.some((r) => ["branch_manager", "sales", "accountant"].includes(r))));
  const { data: rows = [] } = useQuery({
    queryKey: ["attendance", branch, day],
    enabled: !!branch,
    queryFn: async () => {
      let q = supabase.from("attendance").select("*").eq("day", day);
      if (branch !== "all") q = q.eq("branch_id", branch);
      return fetchAllPages(q);
    },
  });
  async function mark(e: Emp, patch: { status?: string; check_in?: string; check_out?: string }) {
    const cur = rows.find((r) => r.employee_id === e.id);
    const { error } = await supabase
      .from("attendance")
      .upsert(
        {
          employee_id: e.id,
          branch_id: e.branch_id,
          day,
          status: cur?.status ?? "present",
          check_in: cur?.check_in ?? null,
          check_out: cur?.check_out ?? null,
          ...patch,
        },
        { onConflict: "employee_id,day" },
      );
    if (error) toast.error(error.message);
    qc.invalidateQueries({ queryKey: ["attendance"] });
  }
  return (
    <>
      <div className="mb-3 flex items-center gap-2">
        <Input
          type="date"
          className="w-44 bg-card"
          value={day}
          onChange={(e) => setDay(e.target.value)}
        />
        <span className="text-sm text-muted-foreground">
          {rows.filter((r) => r.status === "present" || r.status === "late").length}/{emps.length}{" "}
          present
        </span>
      </div>
      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>In</TableHead>
              <TableHead>Out</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {emps.map((e) => {
              const r = rows.find((x) => x.employee_id === e.id);
              return (
                <TableRow key={e.id}>
                  <TableCell>
                    {e.name}
                    <div className="text-xs text-muted-foreground">{e.designation}</div>
                  </TableCell>
                  <TableCell>
                    {canMark(e.branch_id) ? (
                      <div className="flex gap-1">
                        {STATUSES.map((s) => (
                          <Button
                            key={s}
                            size="sm"
                            variant={r?.status === s ? "default" : "outline"}
                            className="capitalize"
                            onClick={() => mark(e, { status: s })}
                          >
                            {s}
                          </Button>
                        ))}
                      </div>
                    ) : (
                      <span className="capitalize text-muted-foreground">
                        {r?.status ?? "Not marked"}
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    {r?.check_in?.slice(0, 5) ??
                      (canMark(e.branch_id) ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => mark(e, { check_in: nowTime() })}
                        >
                          Check in
                        </Button>
                      ) : (
                        "—"
                      ))}
                  </TableCell>
                  <TableCell>
                    {r?.check_out?.slice(0, 5) ??
                      (canMark(e.branch_id) ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={!r?.check_in}
                          onClick={() => mark(e, { check_out: nowTime() })}
                        >
                          Check out
                        </Button>
                      ) : (
                        "—"
                      ))}
                  </TableCell>
                </TableRow>
              );
            })}
            {!emps.length && (
              <TableRow>
                <TableCell colSpan={4} className="py-8 text-center text-muted-foreground">
                  Add staff in the Staff tab.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Card>
    </>
  );
}

function Staff({
  emps,
  branch,
  bname,
  canManage,
}: {
  emps: Emp[];
  branch: string;
  bname: (id: string) => string;
  canManage: boolean;
}) {
  const qc = useQueryClient();
  const [f, setF] = useState({ name: "", phone: "", designation: "", salary: "" });
  const [editing, setEditing] = useState<{
    id: string;
    name: string;
    phone: string;
    designation: string;
    salary: string;
  } | null>(null);
  async function add() {
    if (branch === "all") {
      toast.error("Pick a branch first");
      return;
    }
    const { error } = await supabase
      .from("employees")
      .insert({ ...f, salary: Number(f.salary || 0), branch_id: branch, joined_on: today() });
    if (error) {
      toast.error(
        error.message.includes("row-level") ? "Only managers can add staff" : error.message,
      );
      return;
    }
    setF({ name: "", phone: "", designation: "", salary: "" });
    qc.invalidateQueries({ queryKey: ["employees"] });
  }
  async function toggle(e: Emp) {
    const { error } = await supabase.from("employees").update({ active: !e.active }).eq("id", e.id);
    if (error) toast.error(error.message);
    qc.invalidateQueries({ queryKey: ["employees"] });
  }
  async function saveEmployee() {
    if (!editing) return;
    const { error } = await supabase
      .from("employees")
      .update({
        name: editing.name.trim(),
        phone: editing.phone || null,
        designation: editing.designation || null,
        salary: Number(editing.salary || 0),
      })
      .eq("id", editing.id);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Employee updated");
    setEditing(null);
    qc.invalidateQueries({ queryKey: ["employees"] });
  }
  return (
    <div className="space-y-3">
      {canManage && branch !== "all" && (
        <Card className="flex flex-wrap items-end gap-2 p-4">
          {(["name", "phone", "designation", "salary"] as const).map((k) => (
            <div key={k}>
              <Label className="text-xs capitalize">{k}</Label>
              <Input
                type={k === "salary" ? "number" : "text"}
                value={f[k]}
                onChange={(e) => setF({ ...f, [k]: e.target.value })}
              />
            </div>
          ))}
          <Button disabled={!f.name} onClick={add}>
            Add employee
          </Button>
        </Card>
      )}
      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Branch</TableHead>
              <TableHead>Phone</TableHead>
              <TableHead>Designation</TableHead>
              <TableHead className="text-right">Salary</TableHead>
              {canManage && <TableHead />}
            </TableRow>
          </TableHeader>
          <TableBody>
            {emps.map((e) => (
              <TableRow key={e.id} className={e.active ? "" : "opacity-50"}>
                <TableCell>{e.name}</TableCell>
                <TableCell>{bname(e.branch_id)}</TableCell>
                <TableCell>{e.phone}</TableCell>
                <TableCell>{e.designation}</TableCell>
                <TableCell className="text-right tabular">{taka(e.salary)}</TableCell>
                {canManage && (
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          setEditing({
                            id: e.id,
                            name: e.name,
                            phone: e.phone ?? "",
                            designation: e.designation ?? "",
                            salary: String(e.salary),
                          })
                        }
                      >
                        Edit
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => toggle(e)}>
                        {e.active ? "Deactivate" : "Activate"}
                      </Button>
                    </div>
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
      <Dialog
        open={!!editing}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit employee</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            {(["name", "phone", "designation", "salary"] as const).map((field) => (
              <div key={field} className="space-y-1">
                <Label className="capitalize">{field}</Label>
                <Input
                  type={field === "salary" ? "number" : "text"}
                  min={field === "salary" ? 0 : undefined}
                  value={editing?.[field] ?? ""}
                  onChange={(e) =>
                    setEditing((current) =>
                      current ? { ...current, [field]: e.target.value } : current,
                    )
                  }
                />
              </div>
            ))}
            <Button
              className="w-full"
              disabled={!editing?.name.trim() || Number(editing.salary) < 0}
              onClick={saveEmployee}
            >
              Save changes
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Monthly({
  emps,
  branch,
  bname,
}: {
  emps: Emp[];
  branch: string;
  bname: (id: string) => string;
}) {
  const [month, setMonth] = useState(today().slice(0, 7));
  const { data: rows = [] } = useQuery({
    queryKey: ["attendance-month", branch, month],
    enabled: !!branch,
    queryFn: async () => {
      const [y, m] = month.split("-").map(Number);
      const end = new Date(y!, m!, 0).getDate();
      let q = supabase
        .from("attendance")
        .select("employee_id,status")
        .gte("day", `${month}-01`)
        .lte("day", `${month}-${end}`);
      if (branch !== "all") q = q.eq("branch_id", branch);
      return fetchAllPages(q);
    },
  });
  const table = emps.map((e) => {
    const mine = rows.filter((r) => r.employee_id === e.id);
    const c = (s: string) => mine.filter((r) => r.status === s).length;
    return {
      Name: e.name,
      Branch: bname(e.branch_id),
      Present: c("present"),
      Late: c("late"),
      Absent: c("absent"),
      Leave: c("leave"),
      Salary: Number(e.salary),
    };
  });
  return (
    <>
      <div className="mb-3 flex gap-2">
        <Input
          type="month"
          className="w-44 bg-card"
          value={month}
          onChange={(e) => setMonth(e.target.value)}
        />
        <Button
          variant="outline"
          disabled={!table.length}
          onClick={() => downloadCsv(table, `attendance_${month}.csv`)}
        >
          CSV
        </Button>
      </div>
      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              {["Name", "Branch", "Present", "Late", "Absent", "Leave", "Salary"].map((h) => (
                <TableHead key={h}>{h}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {table.map((r) => (
              <TableRow key={r.Name + r.Branch}>
                <TableCell>{r.Name}</TableCell>
                <TableCell>{r.Branch}</TableCell>
                <TableCell>{r.Present}</TableCell>
                <TableCell>{r.Late}</TableCell>
                <TableCell>{r.Absent}</TableCell>
                <TableCell>{r.Leave}</TableCell>
                <TableCell className="tabular">{taka(r.Salary)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    </>
  );
}
