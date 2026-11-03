import { describe, expect, it } from "vitest";
import { extractImei, isValidImei } from "@/lib/imei";

describe("IMEI", () => {
  it("accepts a Luhn-valid 15-digit IMEI", () => expect(isValidImei("356938035643809")).toBe(true));
  it("rejects a wrong check digit", () => expect(isValidImei("356938035643808")).toBe(false));
  it("rejects 14 digits", () => expect(isValidImei("35693803564380")).toBe(false));
  it("extracts IMEI from labelled scan text", () =>
    expect(extractImei("IMEI1: 356938035643809")).toBe("356938035643809"));
  it("returns null when no valid IMEI", () => expect(extractImei("ABC123")).toBeNull());
});
