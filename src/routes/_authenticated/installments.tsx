import { createFileRoute, Link } from "@tanstack/react-router";
import { PageHeader } from "@/components/BranchPicker";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/_authenticated/installments")({
  head: () => ({ meta: [{ title: "Partner financing — Dealer ERP" }] }),
  component: PartnerFinancingNotice,
});

function PartnerFinancingNotice() {
  return (
    <div>
      <PageHeader title="Partner financing" />
      <Card className="max-w-2xl space-y-3 p-6">
        <h2 className="text-lg font-semibold">Customer installment collection is handled by the financial partner</h2>
        <p className="text-sm text-muted-foreground">
          This business uses third-party financing. Customers pay the down payment at the showroom;
          the financial partner pays the remaining sale balance to the dealer and collects the
          customer’s monthly installments directly. Showroom users must not create monthly
          installment schedules or collect those installments.
        </p>
        <p className="text-sm text-muted-foreground">
          To review partner receivables, record bank settlements, and reconcile payments, use the
          Finance page. Historical installment records remain in the database for audit purposes
          but are no longer presented as active customer collections.
        </p>
        <div>
          <Button asChild>
            <Link to="/finance">Open Finance Partner Settlements</Link>
          </Button>
        </div>
      </Card>
    </div>
  );
}
