const DATE_KEY_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Monterrey",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export const normalizeEmail = (value?: string | null): string =>
  (value ?? "").trim().toLowerCase();

export const normalizePhoneToLocal10 = (value?: string | null): string => {
  const digits = (value ?? "").replace(/\D/g, "");
  if (!digits) return "";
  return digits.length > 10 ? digits.slice(-10) : digits;
};

export const buildAgreementLookupPhones = (
  values: Array<string | null | undefined>,
): string[] => {
  const set = new Set<string>();
  values.forEach((value) => {
    const normalized = normalizePhoneToLocal10(value);
    if (normalized.length === 10) {
      set.add(normalized);
    }
  });
  return Array.from(set);
};

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

