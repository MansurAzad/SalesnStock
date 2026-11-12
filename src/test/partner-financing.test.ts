import { describe, expect, it } from "vitest";
import { calculatePartnerFinancing } from "@/lib/partner-financing";

describe("third-party partner financing", () => {
  it("applies the discount only to the down payment", () => {
    const result = calculatePartnerFinancing(50000, 10000, 1000);

    expect(result.netSaleTotal).toBe(49000);
    expect(result.customerDownPayment).toBe(9000);
    expect(result.partnerReceivable).toBe(40000);
    expect(result.customerDownPayment + result.partnerReceivable).toBe(result.netSaleTotal);
  });

  it("leaves the partner receivable unchanged when the down-payment discount changes", () => {
    const withoutDiscount = calculatePartnerFinancing(50000, 10000, 0);
    const withDiscount = calculatePartnerFinancing(50000, 10000, 2500);

    expect(withoutDiscount.partnerReceivable).toBe(40000);
    expect(withDiscount.partnerReceivable).toBe(40000);
  });

  it("rejects a discount larger than the original down payment", () => {
    expect(() => calculatePartnerFinancing(50000, 10000, 10001)).toThrow(RangeError);
  });
});
