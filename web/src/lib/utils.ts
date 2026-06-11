/** classnames helper. Falsy values are dropped. */
export function cn(...xs: (string | false | null | undefined)[]): string {
  return xs.filter(Boolean).join(" ");
}

/** Pretty bytes: 1234 → "1.2 KiB". */
export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MiB`;
  return `${(n / 1024 ** 3).toFixed(2)} GiB`;
}

/** Truncate to ~`max` characters, appending "…" if cut. */
export function truncate(s: string, max = 240): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}
