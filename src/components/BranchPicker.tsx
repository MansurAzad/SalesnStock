import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useBranches, useMe } from "@/lib/erp";
import { useT } from "@/lib/i18n";
import { useEffect, useRef, type ReactNode } from "react";

/** Branch selector. HQ users can choose any branch (or all); branch users are locked to theirs. */
export function BranchPicker({
  value,
  onChange,
  allowAll = false,
}: {
  value: string;
  onChange: (v: string) => void;
  allowAll?: boolean;
}) {
  const { data: me } = useMe();
  const { data: branches = [] } = useBranches();
  const { t } = useT();

  // Keep the latest callback in a ref: callers often pass an inline arrow, and putting it in
  // the effect deps would re-run the effect on every render (wiping page-level state).
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  });

  useEffect(() => {
    if (!me) return;
    if (me.isHq) {
      if (!value) onChangeRef.current(allowAll ? "all" : (branches[0]?.id ?? ""));
      return;
    }
    if (me.branch_id && value !== me.branch_id) onChangeRef.current(me.branch_id);
  }, [me, branches, value, allowAll]);

  const noBranch = !!me && !me.isHq && !me.branch_id;
  const disabled = !!me && !me.isHq;
  return (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger className="w-64 bg-card">
        <SelectValue placeholder={noBranch ? t("No branch assigned") : t("Branch")} />
      </SelectTrigger>
      <SelectContent>
        {allowAll && !noBranch && <SelectItem value="all">{t("All branches")}</SelectItem>}
        {branches.map((b) => (
          <SelectItem key={b.id} value={b.id}>
            {b.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function PageHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-col gap-3 sm:mb-6 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between print:flex-row">
      <h1 className="min-w-0 truncate text-xl font-semibold sm:text-2xl">{title}</h1>
      <div className="flex flex-wrap items-center gap-2 [&>*]:max-sm:min-w-[9rem] [&>*]:max-sm:flex-1">
        {children}
      </div>
    </div>
  );
}
