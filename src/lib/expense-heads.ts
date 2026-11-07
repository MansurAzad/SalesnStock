/**
 * The ten heads a showroom keeps its expense book in. The same list is a CHECK
 * constraint on expenses.category (migration 0026), so a head filed on the
 * Expenses screen is the head that totals in the report — and vice versa.
 *
 * Keep these two in step: adding a head here without widening the constraint
 * makes the save fail with a database error the user cannot interpret.
 */
export const EXPENSE_HEADS = [
  "Shop rent",
  "Electricity bill",
  "Internet bill",
  "Staff salary",
  "Food",
  "Transport",
  "Cleaning",
  "Repair",
  "Marketing",
  "Other",
] as const;

export type ExpenseHead = (typeof EXPENSE_HEADS)[number];
