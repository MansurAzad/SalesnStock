/**
 * Only http(s) (and site-relative) links are safe to put in an href or src.
 * A "javascript:" URL from a free-text field would run in the app's origin.
 */
export function safeUrl(url?: string | null): string | null {
  const u = (url ?? "").trim();
  if (!u) return null;
  if (/^https?:\/\//i.test(u)) return u;
  if (u.startsWith("/") && !u.startsWith("//")) return u;
  return null;
}
