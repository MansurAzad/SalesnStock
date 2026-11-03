import type { ReactNode } from "react";
import { useMe } from "@/lib/erp";
import { Card } from "@/components/ui/card";

/**
 * Head-office pages are hidden from branch staff in the sidebar, but the URL
 * can still be typed. RLS blocks the data; this keeps the page itself honest.
 */
export function HqOnly({ children }: { children: ReactNode }) {
  const { data: me, isLoading } = useMe();
  if (isLoading) return null;
  if (!me?.isHq)
    return (
      <Card className="p-6 text-sm text-muted-foreground">
        This page is only available to head office staff.
      </Card>
    );
  return <>{children}</>;
}
