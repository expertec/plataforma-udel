import * as XLSX from "xlsx";
import { equivalencyNameKey } from "./equivalencies";
import { sameAcademicAttempt, validateAcademicHistoryInput, type AcademicHistoryInput } from "./academic-history";

type Catalog = {
  courses: Array<{ id: string; title: string; program?: string; category?: string }>;
  groups: Array<{ id: string; groupName: string; semester?: string }>;
};

const columns = [
  ["courseName", "Materia"], ["groupName", "Grupo"], ["cycle", "Ciclo escolar"],
  ["semester", "Cuatrimestre"], ["section", "Apartado"], ["accreditationType", "Tipo de acreditación"],
  ["grade", "Calificación"], ["gradeScale", "Escala"], ["registeredAt", "Fecha de registro"],
  ["notes", "Observaciones"], ["courseId", "ID materia"], ["groupId", "ID grupo"],
] as const;
type Column = typeof columns[number][0];
const optionalColumns: Column[] = ["notes", "courseId", "groupId"];
export const ACADEMIC_HISTORY_EXCEL_FILENAME = "plantilla-historial-academico.xlsx";
export const ACADEMIC_HISTORY_EXCEL_MAX_BYTES = 5 * 1024 * 1024;

export function buildAcademicHistoryWorkbook(catalog: Catalog = { courses: [], groups: [] }): XLSX.WorkBook {
  const workbook = XLSX.utils.book_new();
  const headers = columns.map(([, label]) => label);
  const data = XLSX.utils.aoa_to_sheet([headers]);
  data["!cols"] = [28, 20, 18, 15, 20, 24, 15, 12, 22, 40, 30, 30].map((wch) => ({ wch }));
  data["!autofilter"] = { ref: "A1:L1" };
  XLSX.utils.book_append_sheet(workbook, data, "Materias");
  const instructions = [
    ["Plantilla de historial académico UDEL"],
    ["Uso", "Carga únicamente materias del alumno cuyo historial tienes abierto. No incluyas otros alumnos."],
    ["1", "Completa la hoja Materias desde la fila 2, sin cambiar sus encabezados. Las demás hojas no se importan."],
    ["2", "Una fila por materia, grupo y ciclo. Máximo 40 materias por lote, incluyendo las que ya estén en la lista por guardar."],
    ["3", "Importa el archivo, revisa la lista y pulsa Guardar registros académicos en el kardex. Importar no guarda cambios por sí solo."],
    ["Obligatorios", "Materia, Grupo, Ciclo escolar, Cuatrimestre, Apartado, Tipo de acreditación, Calificación, Escala y Fecha de registro."],
    ["Opcionales", "Observaciones, ID materia e ID grupo."],
    ["Apartado", "Licenciatura o Certificaciones."],
    ["Tipo de acreditación", "Ordinario, Extraordinario o Global."],
    ["Calificación y escala", "Escala 10: nota de 0 a 10. Escala 100: nota de 0 a 100. Se aceptan decimales, cero y reprobatorias."],
    ["Cuatrimestre", "Número entero de 1 a 99. Es independiente del ciclo escolar."],
    ["Fecha de registro", "Fecha de Excel, DD/MM/AAAA o AAAA-MM-DD. El prefijo M- se agrega automáticamente al kárdex."],
    ["Catálogo", "Un nombre que coincide con una única materia del catálogo se vincula automáticamente. Si hay nombres repetidos, copia su ID de la hoja Catálogo."],
    ["Materia histórica", "Si el nombre no existe en el catálogo y dejas ID materia vacío, se registra como materia histórica. Participa en el promedio, pero no acredita una asignatura del catálogo."],
    ["Grupo", "Si coincide con un grupo único se vincula; de lo contrario, puedes escribir un grupo histórico. Para nombres repetidos, copia el ID de la hoja Grupos."],
    ["Referencia", "Las hojas Catálogo y Grupos incluyen las opciones disponibles al descargar desde la plataforma. La plantilla genérica puede tener estas hojas vacías."],
    ["Errores", "Si una fila es inválida o duplicada, ninguna fila del archivo se agrega. Corrige el Excel y vuelve a importarlo."],
    ["Ejemplo", "La hoja Ejemplo es solo una guía y nunca se importa automáticamente."],
  ];
  const help = XLSX.utils.aoa_to_sheet(instructions);
  help["!cols"] = [{ wch: 25 }, { wch: 120 }];
  XLSX.utils.book_append_sheet(workbook, help, "Instrucciones");
  const example = XLSX.utils.aoa_to_sheet([headers, [
    "Materia histórica de ejemplo", "LPI2023", "2024-2", 4, "Licenciatura", "Extraordinario", 8.5, 10, "17/10/2026", "Referencia al expediente físico", "", "",
  ]]);
  example["!cols"] = data["!cols"];
  XLSX.utils.book_append_sheet(workbook, example, "Ejemplo");
  const courses = XLSX.utils.aoa_to_sheet([
    ["ID materia", "Materia", "Programa"],
    ...catalog.courses.map((course) => [course.id, course.title, course.program || course.category || ""]),
  ]);
  courses["!cols"] = [{ wch: 30 }, { wch: 50 }, { wch: 35 }];
  XLSX.utils.book_append_sheet(workbook, courses, "Catálogo");
  const groups = XLSX.utils.aoa_to_sheet([
    ["ID grupo", "Grupo", "Cuatrimestre"], ...catalog.groups.map((group) => [group.id, group.groupName, group.semester || ""]),
  ]);
  groups["!cols"] = [{ wch: 30 }, { wch: 35 }, { wch: 15 }];
  XLSX.utils.book_append_sheet(workbook, groups, "Grupos");
  return workbook;
}

export function downloadAcademicHistoryTemplate(catalog: Catalog): void {
  XLSX.writeFile(buildAcademicHistoryWorkbook(catalog), ACADEMIC_HISTORY_EXCEL_FILENAME);
}

const cellText = (value: unknown): string => typeof value === "string" ? value.trim() : typeof value === "number" && Number.isFinite(value) ? String(value) : "";

function numericCell(value: unknown, label: string): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const text = cellText(value);
  if (!/^\d+(?:[.,]\d+)?$/.test(text)) throw new Error(`${label}: captura un número válido.`);
  return Number(text.replace(",", "."));
}

function registrationDate(value: unknown, date1904: boolean): string {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    const date = XLSX.SSF.parse_date_code(value, { date1904 });
    if (date) return `${String(date.y).padStart(4, "0")}-${String(date.m).padStart(2, "0")}-${String(date.d).padStart(2, "0")}`;
  }
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString().slice(0, 10);
  const text = cellText(value).replace(/^M-/i, "");
  const match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  return match ? `${match[3]}-${match[2].padStart(2, "0")}-${match[1].padStart(2, "0")}` : text;
}

function resolveReference<Item extends { id: string }>(id: string, name: string, items: Item[], label: string, getName: (item: Item) => string): Item | undefined {
  if (id) {
    const item = items.find((entry) => entry.id === id);
    if (!item) throw new Error(`El ID de ${label} no existe en la lista disponible.`);
    if (name && equivalencyNameKey(name) !== equivalencyNameKey(getName(item))) throw new Error(`El nombre de ${label} no corresponde al ID indicado (${getName(item)}).`);
    return item;
  }
  if (!name) return undefined;
  const matching = items.filter((entry) => equivalencyNameKey(getName(entry)) === equivalencyNameKey(name));
  if (matching.length > 1) throw new Error(`Hay varias opciones de ${label} con ese nombre. Especifica su ID desde la hoja de referencia.`);
  return matching[0];
}

export function parseAcademicHistoryWorkbook(workbook: XLSX.WorkBook, catalog: Catalog, existing: AcademicHistoryInput[] = []): { entries: AcademicHistoryInput[]; errors: string[] } {
  const sheetName = workbook.SheetNames.find((name) => equivalencyNameKey(name) === "materias");
  const sheet = sheetName ? workbook.Sheets[sheetName] : undefined;
  if (!sheet?.["!ref"]) return { entries: [], errors: ["No se encontró la hoja Materias. Usa la plantilla descargable."] };
  const range = XLSX.utils.decode_range(sheet["!ref"]);
  if (range.e.r > 1000 || range.e.c >= columns.length) return { entries: [], errors: ["La hoja Materias excede el formato de la plantilla. Elimina columnas adicionales y filas vacías fuera del área de captura."] };
  const columnByHeader = new Map<string, Column>(columns.map(([key, label]) => [equivalencyNameKey(label), key]));
  const indexes = new Map<Column, number>();
  const errors: string[] = [];
  for (let c = 0; c <= range.e.c; c++) {
    const cell = sheet[XLSX.utils.encode_cell({ r: 0, c })] as XLSX.CellObject | undefined;
    const label = cellText(cell?.v);
    const key = columnByHeader.get(equivalencyNameKey(label));
    if (cell?.f || cell?.t === "e" || (label && !key)) errors.push(`Columna ${c + 1}: encabezado inválido. Usa los encabezados de la plantilla.`);
    if (!key) continue;
    if (indexes.has(key)) errors.push(`El encabezado ${label} está repetido.`);
    indexes.set(key, c);
  }
  columns.forEach(([key, label]) => { if (!optionalColumns.includes(key) && !indexes.has(key)) errors.push(`Falta la columna ${label}.`); });
  if (errors.length) return { entries: [], errors };
  const entries: AcademicHistoryInput[] = [];
  let rowCount = 0;
  for (let r = 1; r <= range.e.r; r++) {
    const cells = columns.map(([key]) => {
      const c = indexes.get(key);
      return c === undefined ? undefined : sheet[XLSX.utils.encode_cell({ r, c })] as XLSX.CellObject | undefined;
    });
    if (!cells.some((cell) => cell?.f || cell?.t === "e" || cellText(cell?.v) || cell?.v instanceof Date)) continue;
    rowCount++;
    if (rowCount > 40) return { entries: [], errors: ["El archivo contiene más de 40 materias. Divide la captura en varios archivos o lotes."] };
    try {
      const row: Partial<Record<Column, unknown>> = {};
      columns.forEach(([key, label], index) => {
        const cell = cells[index];
        if (cell?.f || cell?.t === "e") throw new Error(`${label}: reemplaza las fórmulas o errores de Excel por valores.`);
        row[key] = cell?.v;
      });
      const course = resolveReference(cellText(row.courseId), cellText(row.courseName), catalog.courses, "materia", (entry) => entry.title);
      const group = resolveReference(cellText(row.groupId), cellText(row.groupName), catalog.groups, "grupo", (entry) => entry.groupName);
      const section = { licenciatura: "academic", certificaciones: "certifications" }[equivalencyNameKey(cellText(row.section))];
      const accreditationType = { ordinario: "ordinary", extraordinario: "extraordinary", global: "global" }[equivalencyNameKey(cellText(row.accreditationType))];
      const entry = validateAcademicHistoryInput({
        courseId: course?.id || null, courseName: course?.title || cellText(row.courseName),
        groupId: group?.id || null, groupName: group?.groupName || cellText(row.groupName),
        cycle: cellText(row.cycle), semester: cellText(row.semester), section, accreditationType,
        grade: numericCell(row.grade, "Calificación"), gradeScale: numericCell(row.gradeScale, "Escala"),
        registeredAt: registrationDate(row.registeredAt, workbook.Workbook?.WBProps?.date1904 === true), notes: cellText(row.notes),
      });
      if ([...existing, ...entries].some((previous) => sameAcademicAttempt(entry, previous))) throw new Error(`${entry.courseName} está duplicada para ese grupo, ciclo y apartado.`);
      entries.push(entry);
    } catch (error) { errors.push(`Fila ${r + 1}: ${error instanceof Error ? error.message : "Revisa los datos de esta materia."}`); }
  }
  if (!rowCount) errors.push("La hoja Materias está vacía. Captura las materias a partir de la fila 2; la hoja Ejemplo no se importa.");
  return { entries: errors.length ? [] : entries, errors };
}

export function readAcademicHistoryExcel(buffer: ArrayBuffer, catalog: Catalog, existing: AcademicHistoryInput[] = []) {
  const workbook = XLSX.read(buffer, { type: "array", cellDates: false });
  return parseAcademicHistoryWorkbook(workbook, catalog, existing);
}
