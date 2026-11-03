/** Luhn checksum used by every valid 15-digit IMEI. */
export function isValidImei(code: string): boolean {
  if (!/^\d{15,16}$/.test(code)) return false;
  // A 16-digit IMEI carries a spare bit as the last digit; the Luhn check
  // digit is still the 15th, so the trailing digit is ignored.
  const base = code.slice(0, 15);
  let sum = 0;
  for (let i = 0; i < 15; i++) {
    let d = Number(base[i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

/**
 * Pulls an IMEI out of raw scanner text (e.g. "IMEI1:356938035643809").
 * Prefers a Luhn-valid candidate; falls back to the first 15-digit run so a
 * scanned code is never silently dropped at the counter.
 */
export function extractImei(raw: string): string | null {
  const m = raw.replace(/\s/g, "").match(/\d{15,17}/g);
  if (!m) return null;
  for (const s of m) {
    const c = s.slice(0, 15);
    if (isValidImei(c)) return c;
  }
  const fallback = m[0]?.slice(0, 15);
  return fallback && /^\d{15}$/.test(fallback) ? fallback : null;
}

/**
 * Does a scanned code belong to a stored IMEI? Both may be 15 or 16 digits, and
 * a scanner sometimes adds a check digit, so the first 15 digits are compared
 * as well.
 */
export function matchesImei(stored: string | null | undefined, scanned: string): boolean {
  if (!stored) return false;
  const a = stored.replace(/\s/g, "");
  const b = scanned.replace(/\s/g, "");
  if (!a || !b) return false;
  if (a === b) return true;
  const c = extractImei(b);
  return !!c && (a === c || a.slice(0, 15) === c);
}
