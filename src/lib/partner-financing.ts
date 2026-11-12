export type PartnerFinancingAmounts = {
  saleSubtotal: number;
  downPaymentBeforeDiscount: number;
  downPaymentDiscount: number;
  customerDownPayment: number;
  partnerReceivable: number;
  netSaleTotal: number;
};

/**
 * Calculate a dealer sale financed by a third party.
 * The discount reduces only the customer's down payment; the partner's
 * receivable remains subtotal minus the original (pre-discount) down payment.
 */
export function calculatePartnerFinancing(
  saleSubtotal: number,
  downPaymentBeforeDiscount: number,
  downPaymentDiscount: number,
): PartnerFinancingAmounts {
  if (
    !Number.isFinite(saleSubtotal) ||
    !Number.isFinite(downPaymentBeforeDiscount) ||
    !Number.isFinite(downPaymentDiscount) ||
    saleSubtotal <= 0 ||
    downPaymentBeforeDiscount <= 0 ||
    downPaymentBeforeDiscount >= saleSubtotal ||
    downPaymentDiscount < 0 ||
    downPaymentDiscount > downPaymentBeforeDiscount
  ) {
    throw new RangeError("Invalid partner-financing amounts");
  }

  return {
    saleSubtotal,
    downPaymentBeforeDiscount,
    downPaymentDiscount,
    customerDownPayment: downPaymentBeforeDiscount - downPaymentDiscount,
    partnerReceivable: saleSubtotal - downPaymentBeforeDiscount,
    netSaleTotal: saleSubtotal - downPaymentDiscount,
  };
}
