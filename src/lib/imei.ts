/** Luhn checksum used by every valid 15-digit IMEI. */
export function isValidImei(code: string): boolean {
  if (!/^\d{15}$/.test(code)) return false;
  let sum = 0;
  for (let i = 0; i < 15; i++) {
    let d = Number(code[i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

/** Pulls a 15-digit IMEI out of raw scanner text (e.g. "IMEI1:356938035643809"). */
export function extractImei(raw: string): string | null {
  const m = raw.replace(/\s/g, "").match(/\d{15,17}/g);
  if (!m) return null;
  for (const s of m) {
    const c = s.slice(0, 15);
    if (isValidImei(c)) return c;
  }
  return null;
}
