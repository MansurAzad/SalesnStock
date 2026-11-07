/**
 * Every money path has to agree on the same list of payment methods, otherwise
 * a method the POS offers is rejected by the database CHECK constraint. Keep
 * this file and `transactions_method_check` in the migrations in step.
 */
export const PAYMENT_METHODS = [
  "cash",
  "bank",
  "bkash",
  "nagad",
  "rocket",
  "card",
  "cheque",
  "online",
] as const;

export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/** The methods a showroom till actually takes from a customer. */
export const SALE_METHODS: readonly PaymentMethod[] = [
  "cash",
  "bkash",
  "nagad",
  "rocket",
  "card",
  "bank",
];

/** The methods a shop pays its suppliers and bills with. */
export const EXPENSE_METHODS: readonly PaymentMethod[] = [
  "cash",
  "bank",
  "bkash",
  "nagad",
  "rocket",
  "cheque",
  "online",
];

/** The methods a kisti collection arrives in — a card swipe is not a thing here. */
export const COLLECTION_METHODS: readonly PaymentMethod[] = [
  "cash",
  "bkash",
  "nagad",
  "rocket",
  "bank",
];

const LABELS: Record<string, string> = {
  cash: "Cash",
  bank: "Bank",
  bkash: "bKash",
  nagad: "Nagad",
  rocket: "Rocket",
  card: "Card",
  cheque: "Cheque",
  online: "Online",
};

export function methodLabel(m: string): string {
  return LABELS[m] ?? m;
}

/** Mobile financial services — the wallets whose balance sits outside the till. */
export const MFS_METHODS: readonly string[] = ["bkash", "nagad", "rocket"];

export function isMfs(m: string): boolean {
  return MFS_METHODS.includes(m);
}
