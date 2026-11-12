import { describe, expect, it } from "vitest";
import { partnerBalance } from "@/components/PartnerAccounts";

describe("partner balance", () => {
  it("pending case amount is owed by the partner", () => {
    expect(partnerBalance([{ amount: 50000, commission: 0, status: "pending" }], [])).toBe(50000);
  });
  it("settled historical case with recorded receipt leaves nothing owed", () => {
    expect(
      partnerBalance(
        [{ amount: 50000, commission: 2000, status: "settled" }],
        [{ kind: "received", amount: 48000 }],
      ),
    ).toBe(0);
  });
  it("outgoing partner payments do not increase or reduce this business receivable", () => {
    expect(partnerBalance([], [{ kind: "paid", amount: 1500 }])).toBe(0);
  });
});
