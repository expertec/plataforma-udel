const DEFAULT_PHONE_LOOKUP_FIELDS = [
  "phone",
  "Phone",
  "telefono",
  "tel",
  "mobile",
  "celular",
  "cellphone",
  "whatsapp",
  "WhatsApp",
  "whatsApp",
  "wa",
  "whatsappPhone",
  "whatsappNumber",
] as const;

function asTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export const normalizePhoneToLocal10 = (value?: string | null): string => {
  const digits = (value ?? "").replace(/\D/g, "");
  if (!digits) return "";
  return digits.length > 10 ? digits.slice(-10) : digits;
};

export const buildPhoneLookupValues = (
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

export const extractPhoneLookupValues = (
  source: Record<string, unknown> | null | undefined,
  fields: readonly string[] = DEFAULT_PHONE_LOOKUP_FIELDS,
): string[] => {
  if (!source) return [];
  return buildPhoneLookupValues(fields.map((field) => asTrimmedString(source[field])));
};
