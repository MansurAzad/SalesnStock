import { describe, expect, it } from "vitest";
import { fetchAllPages } from "@/lib/paginated-query";

describe("fetchAllPages", () => {
  it("loads every row in bounded pages", async () => {
    const rows = [1, 2, 3, 4, 5];
    const query = {
      range: async (from: number, to: number) => ({ data: rows.slice(from, to + 1), error: null }),
    };

    await expect(fetchAllPages(query, 2)).resolves.toEqual(rows);
  });

  it("throws query errors", async () => {
    const query = { range: async () => ({ data: null, error: { message: "query failed" } }) };

    await expect(fetchAllPages(query)).rejects.toMatchObject({ message: "query failed" });
  });
});
