export type KardexSection = "academic" | "certifications";

export type KardexClassification = {
  groupName: string;
  isCertification?: boolean;
  equivalencyId?: string;
};

export function isCertificationGroup(groupName: unknown): boolean {
  return typeof groupName === "string" && /^CERT\./i.test(groupName.trim());
}

export function getKardexSection(row: KardexClassification): KardexSection {
  if (row.equivalencyId) return "academic";
  return row.isCertification === true || isCertificationGroup(row.groupName) ? "certifications" : "academic";
}

export function filterKardexRows<Row extends KardexClassification>(rows: Row[], section: KardexSection): Row[] {
  return rows.filter((row) => getKardexSection(row) === section);
}

export function kardexSemesterNumber(value: unknown): string {
  const text = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
  const number = text.match(/\d+/)?.[0];
  if (number) return String(Number(number));
  return "—";
}

export function formatKardexDate(value: Date | null | undefined): string {
  if (!value || !Number.isFinite(value.getTime())) return "—";
  return new Intl.DateTimeFormat("es-MX", {
    day: "2-digit", month: "2-digit", year: "2-digit", timeZone: "America/Monterrey",
  }).format(value);
}

export function formatKardexIdentification(row: {
  groupName: string;
  semester?: unknown;
  updatedAt?: Date | null;
  closedAt?: Date | null;
  equivalencyId?: string;
}): string {
  const date = formatKardexDate(row.updatedAt ?? row.closedAt);
  if (row.equivalencyId) return `Procedencia: ${row.groupName || "—"} | A. ${date}`;
  return `G. ${row.groupName || "—"} | C. ${kardexSemesterNumber(row.semester)} | A. ${date}`;
}
