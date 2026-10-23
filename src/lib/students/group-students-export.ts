import type { GroupStudent } from "@/lib/firebase/groups-service";
import { isStudentStatusActive } from "@/lib/students/status";

const DATE_OPTIONS: Intl.DateTimeFormatOptions = { timeZone: "America/Monterrey" };

function formatDate(date?: Date, withTime = false): string {
  if (!date || !Number.isFinite(date.getTime())) return "Sin registro";
  return withTime
    ? date.toLocaleString("es-MX", { ...DATE_OPTIONS, hour12: false })
    : date.toLocaleDateString("es-MX", DATE_OPTIONS);
}

const HEADERS = ["Nombre", "Correo", "Inscripción", "Estado de cuenta", "Última conexión registrada"];
const NOTE = "Horarios de Monterrey. El estado de cuenta no indica conexión en tiempo real.";

function studentRows(students: GroupStudent[]) {
  return students.map((student) => [
    student.studentName || "Sin nombre",
    student.studentEmail || "Sin registro",
    formatDate(student.enrolledAt),
    !student.accountStatus || student.accountStatus === "unknown"
      ? "Sin registro"
      : isStudentStatusActive(student.accountStatus) ? "Activa" : "Inactiva",
    formatDate(student.lastLoginAt, true),
  ]);
}

function createStudentsSheet(XLSX: typeof import("xlsx"), groupName: string, students: GroupStudent[]) {
  const sheet = XLSX.utils.aoa_to_sheet([
    ["Alumnos del grupo", groupName],
    ["Generado", formatDate(new Date(), true)],
    ["Total de alumnos", students.length],
    [NOTE],
    [],
    HEADERS,
    ...studentRows(students),
  ]);
  sheet["!cols"] = [{ wch: 36 }, { wch: 45 }, { wch: 16 }, { wch: 20 }, { wch: 30 }];
  sheet["!autofilter"] = { ref: `A6:E${6 + students.length}` };
  return sheet;
}

export async function exportAllGroupStudents(groups: Array<{ groupName: string; students: GroupStudent[] }>) {
  if (groups.length === 0) throw new Error("No hay grupos para descargar");
  const XLSX = await import("xlsx");
  const workbook = XLSX.utils.book_new();
  const usedNames = new Set<string>();
  groups.forEach(({ groupName, students }) => {
    const base = groupName.replace(/[\\/?*\[\]:]/g, "-").replace(/\p{Cc}/gu, "")
      .trim().replace(/^'+|'+$/g, "").trim() || "Grupo";
    let name = base.slice(0, 31).replace(/'+$/g, "") || "Grupo";
    let counter = 2;
    while (usedNames.has(name.toLowerCase())) {
      const suffix = ` (${counter++})`;
      name = `${base.slice(0, 31 - suffix.length)}${suffix}`;
    }
    usedNames.add(name.toLowerCase());
    XLSX.utils.book_append_sheet(workbook, createStudentsSheet(XLSX, groupName, students), name);
  });
  XLSX.writeFile(workbook, `alumnos-todos-los-grupos-${new Date().toISOString().slice(0, 10)}.xlsx`);
}

export async function exportGroupStudents(
  format: "pdf" | "xlsx",
  groupName: string,
  students: GroupStudent[],
) {
  const generatedAt = formatDate(new Date(), true);
  const token = groupName.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 80) || "grupo";
  const filename = `alumnos-${token}-${new Date().toISOString().slice(0, 10)}`;

  if (format === "xlsx") {
    const XLSX = await import("xlsx");
    const sheet = createStudentsSheet(XLSX, groupName, students);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, "Alumnos");
    XLSX.writeFile(workbook, `${filename}.xlsx`);
    return;
  }

  const { jsPDF } = await import("jspdf");
  const pdf = new jsPDF({ orientation: "landscape", unit: "pt", format: "a4" });
  const margin = 32;
  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();
  const widths = [170, 220, 95, 95, pageWidth - margin * 2 - 580];
  let y = margin;
  const drawHeader = () => {
    y = margin;
    pdf.setFont("helvetica", "bold");
    pdf.setFontSize(14);
    const title = pdf.splitTextToSize(`Alumnos: ${groupName}`, pageWidth - margin * 2) as string[];
    pdf.text(title, margin, y);
    y += title.length * 17 + 4;
    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(9);
    pdf.text(`Total: ${students.length} | Generado: ${generatedAt}`, margin, y);
    y += 15;
    pdf.setFontSize(8);
    pdf.text(NOTE, margin, y);
    y += 14;
    pdf.setFillColor(241, 245, 249);
    pdf.rect(margin, y, pageWidth - margin * 2, 25, "F");
    pdf.setFont("helvetica", "bold");
    let x = margin;
    HEADERS.forEach((header, index) => {
      pdf.text(header, x + 4, y + 16);
      x += widths[index];
    });
    y += 25;
    pdf.setFont("helvetica", "normal");
  };
  drawHeader();
  studentRows(students).forEach((row) => {
    const cells = row.map((value, index) => pdf.splitTextToSize(value, widths[index] - 8) as string[]);
    const height = Math.max(...cells.map((lines) => lines.length)) * 11 + 12;
    if (y + height > pageHeight - 35) {
      pdf.addPage();
      drawHeader();
    }
    let x = margin;
    cells.forEach((lines, index) => {
      pdf.text(lines, x + 4, y + 13);
      x += widths[index];
    });
    y += height;
    pdf.setDrawColor(226, 232, 240);
    pdf.line(margin, y, pageWidth - margin, y);
  });
  const pages = pdf.getNumberOfPages();
  for (let page = 1; page <= pages; page++) {
    pdf.setPage(page);
    pdf.text(`Página ${page} de ${pages}`, pageWidth - margin, pageHeight - 17, { align: "right" });
  }
  pdf.save(`${filename}.pdf`);
}
