import { buildPhoneLookupValues, normalizePhoneToLocal10 } from "@/lib/utils/phone";

const DATE_KEY_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Monterrey",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export const normalizeEmail = (value?: string | null): string =>
  (value ?? "").trim().toLowerCase();

export { normalizePhoneToLocal10 };

export const buildAgreementLookupPhones = (
  values: Array<string | null | undefined>,
): string[] => buildPhoneLookupValues(values);

export const getTodayDateKeyMonterrey = (): string =>
  DATE_KEY_FORMATTER.format(new Date());

export const isDateKeyInRange = (
  dateKey: string,
  startDate: string,
  endDate: string,
): boolean => {
  const normalizedDate = (dateKey ?? "").trim();
  const normalizedStart = (startDate ?? "").trim();
  const normalizedEnd = (endDate ?? "").trim();
  if (!normalizedDate || !normalizedStart || !normalizedEnd) return false;
  return normalizedDate >= normalizedStart && normalizedDate <= normalizedEnd;
};
