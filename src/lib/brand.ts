import { safeUrl } from "@/lib/url";

export const DEFAULT_LOGO = "/logo.png";
export const logoSrc = (url?: string | null) => safeUrl(url) ?? DEFAULT_LOGO;
