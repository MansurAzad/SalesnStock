import { createFileRoute, Link } from "@tanstack/react-router";
import { PageHeader } from "@/components/BranchPicker";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/_authenticated/kisti-receipt/$installmentId")({
  head: () => ({ meta: [{ title: "Partner financing — Dealer ERP" }] }),
  component: PartnerSettlementNotice,
});

function PartnerSettlementNotice() {
  return (
    <div>
      <PageHeader title="Partner financing" />
      <Card className="max-w-xl space-y-3 p-6">
        <h2 className="text-lg font-semibold">
          Customer installment receipts are not issued by the showroom
        </h2>
        <p className="text-sm text-muted-foreground">
          The financial partner collects monthly installments directly from the customer. The
          showroom records only the customer down payment and the partner’s settlement of the
          remaining sale balance.
        </p>
        <Button asChild>
          <Link to="/finance">Open Finance Partner Settlements</Link>
        </Button>
      </Card>
    </div>
  );
}
