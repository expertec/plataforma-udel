import { accreditationLabels, formatManualRegistrationDate, type ManualKardexFields } from "./academic-history";

export type KardexSection = "academic" | "certifications";

export function academicKardexLabel(program?: string): string {
  const name = program?.trim() || "";
  const normalized = name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  if (/prepa|bachillerato|media superior/.test(normalized)) return "Preparatoria";
  if (/licenciatura|\blic\b|ingenier|universitari|\btsu\b/.test(normalized)) return "Licenciatura";
  return name || "Académico";
}

export type KardexClassification = {
  groupName: string;
  isCertification?: boolean;
  equivalencyId?: string;
  academicHistoryId?: string;
  section?: KardexSection;
};

export function isCertificationGroup(groupName: unknown): boolean {
  return typeof groupName === "string" && /^CERT\./i.test(groupName.trim());
}

export function getKardexSection(row: KardexClassification): KardexSection {
  if (row.academicHistoryId && row.section) return row.section;
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

export function formatKardexIdentification(row: ManualKardexFields & {
  groupName: string;
  semester?: unknown;
  updatedAt?: Date | null;
  closedAt?: Date | null;
  equivalencyId?: string;
}): string {
  if (row.academicHistoryId) {
    const accreditation = row.accreditationType ? accreditationLabels[row.accreditationType] : "—";
    return `G. ${row.groupName || "—"} | Ciclo: ${row.cycle || "—"} | C. ${kardexSemesterNumber(row.semester)} | ${accreditation} | ${formatManualRegistrationDate(row.registeredAt)}`;
  }
  const date = formatKardexDate(row.updatedAt ?? row.closedAt);
  if (row.equivalencyId) return `Procedencia: ${row.groupName || "—"} | A. ${date}`;
  return `G. ${row.groupName || "—"} | C. ${kardexSemesterNumber(row.semester)} | A. ${date}`;
}

/** Recursamientos stay in the history and average, but only accredit one subject. */
export function countProgramApproved(rows: Array<KardexClassification & {
  status: "open" | "closed";
  finalGrade: number | null;
  courseId: string;
  countsTowardProgram?: boolean;
}>): number {
  return new Set(rows.filter((row) => getKardexSection(row) === "academic" && row.status === "closed" && row.finalGrade !== null && row.finalGrade >= 70 && row.countsTowardProgram !== false && row.courseId).map((row) => row.courseId)).size;
}

export function kardexOrdinaryGrade(row: ManualKardexFields & { finalGrade: number | null }): number | null {
  return row.academicHistoryId && row.accreditationType !== "ordinary" ? null : row.finalGrade;
}
