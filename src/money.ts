import { minorDigits } from "./normalize.js";

/** Format an amount held in minor units (cents, pence, whole yen) for a locale. */
export function fmtMoney(minor: number, currency: string, locale = "en"): string {
  const d = minorDigits(currency);
  try { return new Intl.NumberFormat(locale, { style: "currency", currency }).format(minor / 10 ** d); }
  catch { return `${(minor / 10 ** d).toFixed(d)} ${currency}`; }
}
