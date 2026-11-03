const pad = (n: number) => String(n).padStart(2, "0");

/** Local calendar date as YYYY-MM-DD (never UTC — showroom staff are UTC+6). */
export const localDate = (d: Date = new Date()) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export const localToday = () => localDate();

/** Bangladesh Standard Time (UTC+6) calendar date — the server runs in UTC. */
export const dhakaDate = (d: Date = new Date()) => {
  const b = new Date(d.getTime() + 6 * 3600 * 1000);
  return `${b.getUTCFullYear()}-${pad(b.getUTCMonth() + 1)}-${pad(b.getUTCDate())}`;
};

/** Split a YYYY-MM-DD string; a broken date must never throw. */
const parts = (day: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day ?? "");
  if (!m) return { y: 1970, mo: 0, d: 1 };
  return { y: Number(m[1]), mo: Number(m[2]) - 1, d: Number(m[3]) };
};

/** Local midnight as an ISO instant, for timestamptz range filters. */
export const localDayStartIso = (day: string) => {
  const { y, mo, d } = parts(day);
  return new Date(y, mo, d, 0, 0, 0, 0).toISOString();
};

export const localDayEndIso = (day: string) => {
  const { y, mo, d } = parts(day);
  return new Date(y, mo, d, 23, 59, 59, 999).toISOString();
};
