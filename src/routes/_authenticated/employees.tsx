import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { BranchPicker, PageHeader } from "@/components/BranchPicker";
import { taka, useBranches, useMe } from "@/lib/erp";
import { localDate } from "@/lib/date";
import { downloadCsv } from "@/lib/csv";
import { useT } from "@/lib/i18n";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
/** Showroom shift starts at 09:00 — a later check-in counts as late. */
const SHIFT_START = "09:00";
const today = () => localDate();
const nowTime = () => new Date().toTimeString().slice(0, 5);

type TimeRow = {
  status: string | null;
  check_in: string | null;
  check_out: string | null;
};

/** Minutes since midnight for a Postgres time value ("HH:MM:SS"). */
function timeMinutes(value: string | null | undefined): number | null {
  if (!value) return null;
  const parts = value.slice(0, 5).split(":");
  const h = Number(parts[0]);
  const m = Number(parts[1]);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return h * 60 + m;
}

/** Hours worked on one attendance row — null when they cannot be computed. */
function rowHours(row: TimeRow): number | null {
  if (row.status === "absent" || row.status === "leave") return null;
  const start = timeMinutes(row.check_in);
  const end = timeMinutes(row.check_out);
  if (start === null || end === null) return null;
  // Clock-out before clock-in is a data error — do not report negative hours.
  if (end < start) return null;
  return Math.round(((end - start) / 60) * 10) / 10;
}

/** "8.5" or "—" when the hours are unknown. */
const hoursLabel = (row: TimeRow | null | undefined) => {
  const h = row ? rowHours(row) : null;
  return h === null ? "—" : h.toFixed(1);
};

/** A day marked absent/leave by hand is never overridden automatically. */
const isManualAbsence = (status: string | null | undefined) =>
  status === "absent" || status === "leave";

/** A check-in after the shift start is late. */
const isLateCheckIn = (time: string) => {
  const t = timeMinutes(time);
  const s = timeMinutes(SHIFT_START);
  return t !== null && s !== null && t > s;
};

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
            canManage={(bid) =>
              !!me &&
              (me.canWriteHq || (me.roles.includes("branch_manager") && me.branch_id === bid))
            }
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
  async function mark(
    e: Emp,
    patch: { status?: string; check_in?: string | null; check_out?: string | null },
  ) {
    const cur = rows.find((r) => r.employee_id === e.id);
    const curStatus = cur?.status ?? "present";
    let status = patch.status ?? curStatus;
    let checkIn = cur?.check_in ?? null;
    let checkOut = cur?.check_out ?? null;
    if (patch.check_in !== undefined) checkIn = patch.check_in;
    if (patch.check_out !== undefined) checkOut = patch.check_out;

    // Checking in after the shift start makes the day late — but never
    // override an absent/leave that was set by hand.
    const autoLate =
      patch.status === undefined &&
      !!patch.check_in &&
      !isManualAbsence(curStatus) &&
      isLateCheckIn(patch.check_in);
    if (autoLate) status = "late";

    // Absent / leave means the person was not on the floor — no times at all.
    if (isManualAbsence(status)) {
      checkIn = null;
      checkOut = null;
    }

    const { error } = await supabase.from("attendance").upsert(
      {
        employee_id: e.id,
        branch_id: e.branch_id,
        day,
        status,
        check_in: checkIn,
        check_out: checkOut,
      },
      { onConflict: "employee_id,day" },
    );
    if (error) {
      toast.error(error.message);
      return;
    }
    if (autoLate) toast.success(`${e.name} checked in late (shift starts ${SHIFT_START})`);
    qc.invalidateQueries({ queryKey: ["attendance"] });
  }
  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor="att-day" className="text-xs">
            Day
          </Label>
          <Input
            id="att-day"
            type="date"
            className="w-44 bg-card"
            value={day}
            onChange={(e) => setDay(e.target.value)}
          />
        </div>
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
              <TableHead className="text-right">Hours</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {emps.map((e) => {
              const r = rows.find((x) => x.employee_id === e.id);
              const away = isManualAbsence(r?.status);
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
                            aria-label={`Mark ${e.name} as ${s}`}
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
                          disabled={away}
                          title={away ? "Mark the day present before checking in" : undefined}
                          aria-label={`Check in ${e.name}`}
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
                          disabled={!r?.check_in || away}
                          aria-label={`Check out ${e.name}`}
                          onClick={() => mark(e, { check_out: nowTime() })}
                        >
                          Check out
                        </Button>
                      ) : (
                        "—"
                      ))}
                  </TableCell>
                  <TableCell className="text-right tabular">{hoursLabel(r)}</TableCell>
                </TableRow>
              );
            })}
            {!emps.length && (
              <TableRow>
                <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
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
  canManage: (branchId: string) => boolean;
}) {
  const qc = useQueryClient();
  const [f, setF] = useState({ name: "", phone: "", designation: "", salary: "" });
  const canManageSome = emps.some((e) => canManage(e.branch_id));
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
    if (!f.name.trim()) {
      toast.error("Staff name is required");
      return;
    }
    const salary = Number(f.salary || 0);
    if (!Number.isFinite(salary) || salary < 0) {
      toast.error("Enter a valid salary");
      return;
    }
    const { error } = await supabase.from("employees").insert({
      ...f,
      name: f.name.trim(),
      phone: f.phone.trim() || null,
      designation: f.designation.trim() || null,
      salary,
      branch_id: branch,
      joined_on: today(),
    });
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
    const salary = Number(editing.salary || 0);
    if (!editing.name.trim()) {
      toast.error("Staff name is required");
      return;
    }
    if (!Number.isFinite(salary) || salary < 0) {
      toast.error("Enter a valid salary");
      return;
    }
    const { error } = await supabase
      .from("employees")
      .update({
        name: editing.name.trim(),
        phone: editing.phone.trim() || null,
        designation: editing.designation.trim() || null,
        salary,
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
      {canManage(branch) && branch !== "all" && (
        <Card className="flex flex-wrap items-end gap-2 p-4">
          {(["name", "phone", "designation", "salary"] as const).map((k) => (
            <div key={k}>
              <Label className="text-xs capitalize" htmlFor={`emp-${k}`}>
                {k}
              </Label>
              <Input
                id={`emp-${k}`}
                type={k === "salary" ? "number" : "text"}
                aria-label={`Employee ${k}`}
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
              {canManageSome && <TableHead />}
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
                {canManage(e.branch_id) && (
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
            <DialogDescription>Update this staff member's details and salary.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {(["name", "phone", "designation", "salary"] as const).map((field) => (
              <div key={field} className="space-y-1">
                <Label className="capitalize" htmlFor={`edit-${field}`}>
                  {field}
                </Label>
                <Input
                  id={`edit-${field}`}
                  type={field === "salary" ? "number" : "text"}
                  min={field === "salary" ? 0 : undefined}
                  aria-label={`Employee ${field}`}
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
              disabled={
                !editing?.name.trim() ||
                !Number.isFinite(Number(editing.salary)) ||
                Number(editing.salary) < 0
              }
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
  const { data: me } = useMe();
  const [month, setMonth] = useState(today().slice(0, 7));
  const [payrollOpen, setPayrollOpen] = useState(false);
  const { data: rows = [] } = useQuery({
    queryKey: ["attendance-month", branch, month],
    enabled: !!branch,
    queryFn: async () => {
      const [y, m] = month.split("-").map(Number);
      const end = new Date(y!, m!, 0).getDate();
      let q = supabase
        .from("attendance")
        .select("employee_id,status,check_in,check_out")
        .gte("day", `${month}-01`)
        .lte("day", `${month}-${end}`);
      if (branch !== "all") q = q.eq("branch_id", branch);
      return fetchAllPages(q);
    },
  });
  const { data: payrollRows = [] } = useQuery({
    queryKey: ["employee-payroll", branch, month],
    enabled: !!branch && !!month,
    queryFn: async () => {
      let q = supabase
        .from("employee_payroll")
        .select("employee_id,branch_id,period,amount")
        .eq("period", month);
      if (branch !== "all") q = q.eq("branch_id", branch);
      return fetchAllPages(q);
    },
  });
  const paidIds = new Set(payrollRows.map((p) => p.employee_id));

  // Day counts come from the attendance rows themselves, never from a guess
  // of how many working days the month had.
  const summary = emps.map((e) => {
    const mine = rows.filter((r) => r.employee_id === e.id);
    const days = (s: string) => mine.filter((r) => r.status === s).length;
    const hours = mine.reduce((sum, r) => sum + (rowHours(r) ?? 0), 0);
    return {
      id: e.id,
      name: e.name,
      branch: bname(e.branch_id),
      present: days("present"),
      late: days("late"),
      absent: days("absent"),
      leave: days("leave"),
      hours: Math.round(hours * 10) / 10,
      salary: Number(e.salary),
      paid: paidIds.has(e.id),
    };
  });
  const csvRows = summary.map((s) => ({
    Name: s.name,
    Branch: s.branch,
    Present: s.present,
    Late: s.late,
    Absent: s.absent,
    Leave: s.leave,
    Hours: s.hours,
    Salary: s.salary,
    Paid: s.paid ? "Yes" : "No",
  }));

  const payrollAllowed = !!me && (me.canWriteHq || me.roles.includes("branch_manager"));
  const canRunPayroll =
    !!me &&
    branch !== "all" &&
    (me.canWriteHq || (me.roles.includes("branch_manager") && me.branch_id === branch));

  return (
    <>
      <div className="mb-3 flex flex-wrap items-end gap-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor="att-month" className="text-xs">
            Month
          </Label>
          <Input
            id="att-month"
            type="month"
            className="w-44 bg-card"
            value={month}
            onChange={(e) => setMonth(e.target.value)}
          />
        </div>
        <Button
          variant="outline"
          disabled={!summary.length}
          onClick={() => downloadCsv(csvRows, `attendance_${month}.csv`)}
        >
          CSV
        </Button>
        {payrollAllowed && (
          <Button disabled={!canRunPayroll} onClick={() => setPayrollOpen(true)}>
            Run payroll
          </Button>
        )}
        {payrollAllowed && !canRunPayroll && (
          <span className="text-xs text-muted-foreground">
            Pick a single branch to run payroll.
          </span>
        )}
      </div>
      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              {[
                "Name",
                "Branch",
                "Present",
                "Late",
                "Absent",
                "Leave",
                "Hours",
                "Salary",
                "Paid",
              ].map((h) => (
                <TableHead key={h}>{h}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {summary.map((r) => (
              <TableRow key={r.id}>
                <TableCell>{r.name}</TableCell>
                <TableCell>{r.branch}</TableCell>
                <TableCell>{r.present}</TableCell>
                <TableCell>{r.late}</TableCell>
                <TableCell>{r.absent}</TableCell>
                <TableCell>{r.leave}</TableCell>
                <TableCell className="tabular">{r.hours.toFixed(1)}</TableCell>
                <TableCell className="tabular">{taka(r.salary)}</TableCell>
                <TableCell>
                  {r.paid ? (
                    <Badge variant="secondary">Paid</Badge>
                  ) : (
                    <span className="text-xs text-muted-foreground">Unpaid</span>
                  )}
                </TableCell>
              </TableRow>
            ))}
            {!summary.length && (
              <TableRow>
                <TableCell colSpan={9} className="py-8 text-center text-muted-foreground">
                  No staff found for this branch.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Card>
      {payrollOpen && canRunPayroll && (
        <RunPayrollDialog
          onOpenChange={setPayrollOpen}
          branchId={branch}
          month={month}
          emps={emps}
          paidIds={paidIds}
        />
      )}
    </>
  );
}

function RunPayrollDialog({
  onOpenChange,
  branchId,
  month,
  emps,
  paidIds,
}: {
  onOpenChange: (open: boolean) => void;
  branchId: string;
  month: string;
  emps: Emp[];
  paidIds: Set<string>;
}) {
  const qc = useQueryClient();
  const [picked, setPicked] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const staff = emps.filter((e) => e.active && e.branch_id === branchId);
  const total = staff.reduce((sum, e) => (picked.includes(e.id) ? sum + Number(e.salary) : sum), 0);

  async function run() {
    if (!picked.length) return;
    setBusy(true);
    const { data, error } = await supabase.rpc("run_payroll", {
      _branch: branchId,
      _period: month,
      _employee_ids: picked,
      _note: note.trim(),
    });
    setBusy(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success(`Payroll paid — ${taka(Number(data ?? 0))}`);
    onOpenChange(false);
    qc.invalidateQueries({ queryKey: ["employee-payroll"] });
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Run payroll — {month}</DialogTitle>
          <DialogDescription>
            Pick the staff to pay for this month. One “Staff salary” expense is written to the cash
            book for the whole run.
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[50vh] overflow-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Pay</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Designation</TableHead>
                <TableHead className="text-right">Salary</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {staff.map((e) => {
                const already = paidIds.has(e.id);
                return (
                  <TableRow key={e.id}>
                    <TableCell>
                      <Checkbox
                        id={`payroll-${e.id}`}
                        aria-label={`Include ${e.name} in payroll`}
                        checked={picked.includes(e.id)}
                        disabled={already || busy}
                        onCheckedChange={(v) =>
                          setPicked((cur) =>
                            v === true ? [...cur, e.id] : cur.filter((x) => x !== e.id),
                          )
                        }
                      />
                    </TableCell>
                    <TableCell>{e.name}</TableCell>
                    <TableCell>{e.designation ?? "—"}</TableCell>
                    <TableCell className="text-right tabular">{taka(e.salary)}</TableCell>
                    <TableCell>
                      {already ? (
                        <Badge variant="secondary">Paid</Badge>
                      ) : (
                        <span className="text-xs text-muted-foreground">Unpaid</span>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
              {!staff.length && (
                <TableRow>
                  <TableCell colSpan={5} className="py-6 text-center text-muted-foreground">
                    No active staff in this branch.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
        <div className="space-y-1">
          <Label htmlFor="payroll-note">Note</Label>
          <Input
            id="payroll-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={`Salary for ${month}`}
          />
        </div>
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">{picked.length} staff selected</span>
          <span className="tabular font-semibold">{taka(total)}</span>
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={busy || !picked.length} onClick={run}>
            {busy ? "Paying…" : `Pay ${taka(total)}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
