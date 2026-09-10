"use client";

import { onAuthStateChanged, type User } from "firebase/auth";
import { CalendarDays, CheckCircle2, DollarSign, FileDown, RefreshCw, Search, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import toast from "react-hot-toast";
import { RoleGate } from "@/components/auth/RoleGate";
import { auth } from "@/lib/firebase/client";

type ClosureReviewItem = {
  groupId: string;
  groupName: string;
  courseId: string;
  courseName: string;
  teacherId: string;
  teacherName: string;
  courseMentorIds?: string[];
  courseMentorNames?: string[];
  enabledAt: string;
  estimatedCloseAt: string;
  daysSinceEnabled: number;
  weeksSinceEnabled: number;
  daysUntilDue: number;
  due: boolean;
  reviewReady: boolean;
  closedCount: number;
  openCount: number;
  totalCount: number;
};

type OpenCourseWithoutDateItem = {
  groupId: string;
  groupName: string;
  courseId: string;
  courseName: string;
  teacherId: string;
  teacherName: string;
  courseMentorIds?: string[];
  courseMentorNames?: string[];
  groupEndDate: string | null;
  openedEstimateFrom: string | null;
  openedEstimateSource: "groupStartDate" | "groupCreatedAt" | "unknown";
  daysOpenEstimate: number | null;
  weeksOpenEstimate: number | null;
  closedCount: number;
  openCount: number;
  totalCount: number;
};

type ClosedCourseHistoryItem = {
  groupId: string;
  groupName: string;
  groupStatus: string;
  courseId: string;
  courseName: string;
  teacherId: string;
  teacherName: string;
  courseMentorIds?: string[];
  courseMentorNames?: string[];
  closedAt: string;
  closedByType: "teacher" | "system" | null;
  closureTrigger: "manual" | "automatic" | null;
  closedByName: string;
  closedCount: number;
  totalClosedCount: number;
  averageFinalGrade: number | null;
};

type PayrollLevel = "preparatoria" | "licenciatura" | "otros" | "sinPrograma";

type ClosurePayrollItem = {
  sourceKey: string;
  status: "payable" | "pending" | "review" | "paid";
  reasons: string[];
  groupId: string;
  groupName: string;
  groupStatus: string;
  plantelId: string;
  plantelName: string;
  courseId: string;
  courseName: string;
  program: string;
  level: PayrollLevel;
  payeeId: string;
  payeeName: string;
  payeeEmail: string;
  payeeRole: "primaryTeacher" | "mentor" | "multipleMentors" | "missing";
  payrollDeposit: {
    bank: string;
    clabe: string;
    depositDetails: string;
  };
  closedInPeriodCount: number;
  totalClosedCount: number;
  openCount: number;
  totalStudents: number;
  firstClosedAt: string;
  lastClosedAt: string;
  closedByNames: string[];
  closureTriggers: string[];
};

type ActiveTab = "scheduled" | "openWithoutDate" | "closedHistory" | "closurePayroll";

type PayrollRates = Record<PayrollLevel, number>;

const DEFAULT_PAYROLL_RATES: PayrollRates = {
  licenciatura: 1900,
  preparatoria: 0,
  otros: 0,
  sinPrograma: 0,
};

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Sin fecha";
  return new Intl.DateTimeFormat("es-MX", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(date);
}

function formatGrade(value: number | null): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "Sin promedio";
  return value.toLocaleString("es-MX", {
    minimumFractionDigits: value % 1 === 0 ? 0 : 1,
    maximumFractionDigits: 1,
  });
}

const moneyFormatter = new Intl.NumberFormat("es-MX", {
  style: "currency",
  currency: "MXN",
  maximumFractionDigits: 2,
});

function formatCurrency(value: number): string {
  return moneyFormatter.format(Number.isFinite(value) ? value : 0);
}

function dateInputValue(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function currentWeekRange(): { from: string; to: string } {
  const now = new Date();
  const day = now.getDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  const monday = new Date(now);
  monday.setDate(now.getDate() + mondayOffset);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  return { from: dateInputValue(monday), to: dateInputValue(sunday) };
}

function closedOriginLabel(item: ClosedCourseHistoryItem): string {
  if (item.closureTrigger === "automatic" || item.closedByType === "system") return "Automatico";
  if (item.closureTrigger === "manual" || item.closedByType === "teacher") return "Manual";
  return "Sin origen";
}

function safeFileToken(value: string): string {
  const token = value
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return token || "historial";
}

function dateInputBoundary(value: string, endOfDay: boolean): number | null {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  return new Date(
    year,
    month - 1,
    day,
    endOfDay ? 23 : 0,
    endOfDay ? 59 : 0,
    endOfDay ? 59 : 0,
    endOfDay ? 999 : 0,
  ).getTime();
}

function toClosedHistoryExportRow(item: ClosedCourseHistoryItem) {
  return {
    "Fecha cierre": formatDate(item.closedAt),
    Grupo: item.groupName,
    Materia: item.courseName,
    "Cerrado por": item.closedByName || "Sin registrar",
    Origen: closedOriginLabel(item),
    "Alumnos en este cierre": item.closedCount,
    "Alumnos cerrados total": item.totalClosedCount,
    Promedio: typeof item.averageFinalGrade === "number" ? item.averageFinalGrade : "Sin promedio",
  };
}

function dueLabel(item: ClosureReviewItem): string {
  if (item.daysUntilDue <= 0) {
    const overdueDays = Math.abs(item.daysUntilDue);
    return overdueDays === 0
      ? "7 semanas cumplidas"
      : `7+ semanas, vencida hace ${overdueDays} dia${overdueDays === 1 ? "" : "s"}`;
  }
  if (!item.reviewReady) {
    return `Cierre estimado en ${item.daysUntilDue} dia${item.daysUntilDue === 1 ? "" : "s"}`;
  }
  return `6 semanas, faltan ${item.daysUntilDue} dia${item.daysUntilDue === 1 ? "" : "s"} para 7`;
}

function openEstimateSourceLabel(source: OpenCourseWithoutDateItem["openedEstimateSource"]): string {
  if (source === "groupStartDate") return "desde inicio del grupo";
  if (source === "groupCreatedAt") return "desde creación del grupo";
  return "sin fecha base";
}

function daysOpenLabel(item: OpenCourseWithoutDateItem): string {
  if (typeof item.daysOpenEstimate !== "number") return "Sin estimado";
  const days = item.daysOpenEstimate;
  const weeks = item.weeksOpenEstimate ?? Math.floor(days / 7);
  return `${days} dia${days === 1 ? "" : "s"} (${weeks} sem.)`;
}

function payrollStatusLabel(status: ClosurePayrollItem["status"]): string {
  if (status === "payable") return "Pagar";
  if (status === "pending") return "No pagar aun";
  if (status === "review") return "Revisar";
  return "Pagado";
}

function payrollStatusClass(status: ClosurePayrollItem["status"]): string {
  if (status === "payable") return "bg-emerald-100 text-emerald-700";
  if (status === "pending") return "bg-amber-100 text-amber-700";
  if (status === "review") return "bg-red-100 text-red-700";
  return "bg-slate-100 text-slate-700";
}

function payrollRoleLabel(role: ClosurePayrollItem["payeeRole"]): string {
  if (role === "mentor") return "Mentor de materia";
  if (role === "multipleMentors") return "Varios mentores";
  if (role === "missing") return "Sin responsable";
  return "Titular del grupo";
}

function payrollLevelLabel(level: PayrollLevel): string {
  if (level === "licenciatura") return "Licenciatura";
  if (level === "preparatoria") return "Preparatoria";
  if (level === "otros") return "Otros";
  return "Sin programa";
}

function toCsvField(value: string | number): string {
  const raw = String(value ?? "");
  return `"${raw.replace(/"/g, "\"\"")}"`;
}

async function readApiError(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { error?: unknown };
    if (typeof payload.error === "string" && payload.error.trim()) return payload.error.trim();
  } catch {
    // ignore and use fallback
  }
  return "No se pudo completar la operacion";
}

export default function CourseClosureReviewPage() {
  const defaultPayrollRange = useMemo(() => currentWeekRange(), []);
  const [currentUser, setCurrentUser] = useState<User | null>(auth.currentUser);
  const [authReady, setAuthReady] = useState(Boolean(auth.currentUser));
  const [items, setItems] = useState<ClosureReviewItem[]>([]);
  const [openWithoutDateItems, setOpenWithoutDateItems] = useState<OpenCourseWithoutDateItem[]>([]);
  const [closedHistoryItems, setClosedHistoryItems] = useState<ClosedCourseHistoryItem[]>([]);
  const [closurePayrollItems, setClosurePayrollItems] = useState<ClosurePayrollItem[]>([]);
  const [closurePayrollLoadedRange, setClosurePayrollLoadedRange] = useState("");
  const [reviewStartDays, setReviewStartDays] = useState(42);
  const [dueDays, setDueDays] = useState(49);
  const [loading, setLoading] = useState(true);
  const [payrollLoading, setPayrollLoading] = useState(false);
  const [closingKey, setClosingKey] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [payrollError, setPayrollError] = useState<string | null>(null);
  const [canCloseCourse, setCanCloseCourse] = useState(false);
  const [activeTab, setActiveTab] = useState<ActiveTab>("scheduled");
  const [closedFrom, setClosedFrom] = useState("");
  const [closedTo, setClosedTo] = useState("");
  const [payrollFrom, setPayrollFrom] = useState(defaultPayrollRange.from);
  const [payrollTo, setPayrollTo] = useState(defaultPayrollRange.to);
  const [payrollRates, setPayrollRates] = useState<PayrollRates>(DEFAULT_PAYROLL_RATES);
  const [generatingClosedPdf, setGeneratingClosedPdf] = useState(false);
  const [generatingClosedExcel, setGeneratingClosedExcel] = useState(false);
  const payrollRangeKey = `${payrollFrom}:${payrollTo}`;

  const loadItems = useCallback(async (user: User) => {
    setLoading(true);
    setError(null);
    try {
      const token = await user.getIdToken();
      const params = new URLSearchParams({ review: "true" });
      if (closedFrom) params.set("closedFrom", closedFrom);
      if (closedTo) params.set("closedTo", closedTo);
      const response = await fetch(`/api/admin/course-auto-closures?${params.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      if (!response.ok) throw new Error(await readApiError(response));
      const payload = (await response.json()) as {
        data?: {
          reviewStartDays?: number;
          dueDays?: number;
          canClose?: boolean;
          items?: ClosureReviewItem[];
          openWithoutDateItems?: OpenCourseWithoutDateItem[];
          closedHistoryItems?: ClosedCourseHistoryItem[];
        };
      };
      setReviewStartDays(payload.data?.reviewStartDays ?? 42);
      setDueDays(payload.data?.dueDays ?? 49);
      setCanCloseCourse(payload.data?.canClose === true);
      setItems(payload.data?.items ?? []);
      setOpenWithoutDateItems(payload.data?.openWithoutDateItems ?? []);
      setClosedHistoryItems(payload.data?.closedHistoryItems ?? []);
    } catch (loadError) {
      const message = loadError instanceof Error ? loadError.message : "No se pudo cargar la revision";
      setError(message);
      setCanCloseCourse(false);
      setItems([]);
      setOpenWithoutDateItems([]);
      setClosedHistoryItems([]);
    } finally {
      setLoading(false);
    }
  }, [closedFrom, closedTo]);

  const loadClosurePayrollItems = useCallback(async (user: User) => {
    setPayrollLoading(true);
    setPayrollError(null);
    try {
      const token = await user.getIdToken();
      const params = new URLSearchParams({ from: payrollFrom, to: payrollTo });
      const response = await fetch(`/api/admin/teacher-closure-payroll?${params.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      if (!response.ok) throw new Error(await readApiError(response));
      const payload = (await response.json()) as {
        data?: {
          items?: ClosurePayrollItem[];
        };
      };
      setClosurePayrollItems(payload.data?.items ?? []);
      setClosurePayrollLoadedRange(payrollRangeKey);
    } catch (loadError) {
      const message =
        loadError instanceof Error ? loadError.message : "No se pudo cargar la nomina por cierres";
      setPayrollError(message);
      setClosurePayrollItems([]);
      setClosurePayrollLoadedRange(payrollRangeKey);
    } finally {
      setPayrollLoading(false);
    }
  }, [payrollFrom, payrollRangeKey, payrollTo]);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (user) => {
      setCurrentUser(user);
      setAuthReady(true);
      if (user) {
        void loadItems(user);
      } else {
        setLoading(false);
      }
    });
    return unsub;
  }, [loadItems]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const raw = window.localStorage.getItem("teacherClosurePayrollRates");
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as Partial<PayrollRates>;
      setPayrollRates({
        licenciatura: Number.isFinite(parsed.licenciatura) ? Number(parsed.licenciatura) : DEFAULT_PAYROLL_RATES.licenciatura,
        preparatoria: Number.isFinite(parsed.preparatoria) ? Number(parsed.preparatoria) : DEFAULT_PAYROLL_RATES.preparatoria,
        otros: Number.isFinite(parsed.otros) ? Number(parsed.otros) : DEFAULT_PAYROLL_RATES.otros,
        sinPrograma: Number.isFinite(parsed.sinPrograma) ? Number(parsed.sinPrograma) : DEFAULT_PAYROLL_RATES.sinPrograma,
      });
    } catch {
      // Ignorar configuración local inválida.
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem("teacherClosurePayrollRates", JSON.stringify(payrollRates));
  }, [payrollRates]);

  useEffect(() => {
    if (
      activeTab !== "closurePayroll" ||
      !currentUser ||
      payrollLoading ||
      closurePayrollLoadedRange === payrollRangeKey
    ) {
      return;
    }
    void loadClosurePayrollItems(currentUser);
  }, [
    activeTab,
    closurePayrollLoadedRange,
    currentUser,
    loadClosurePayrollItems,
    payrollLoading,
    payrollRangeKey,
  ]);

  const filteredItems = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return items;
    return items.filter((item) =>
      [item.groupName, item.courseName, item.teacherName, ...(item.courseMentorNames ?? [])]
        .join(" ")
        .toLowerCase()
        .includes(term),
    );
  }, [items, search]);

  const filteredOpenWithoutDateItems = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return openWithoutDateItems;
    return openWithoutDateItems.filter((item) =>
      [item.groupName, item.courseName, item.teacherName, ...(item.courseMentorNames ?? [])]
        .join(" ")
        .toLowerCase()
        .includes(term),
    );
  }, [openWithoutDateItems, search]);

  const filteredClosedHistoryItems = useMemo(() => {
    const term = search.trim().toLowerCase();
    const fromMs = dateInputBoundary(closedFrom, false);
    const toMs = dateInputBoundary(closedTo, true);
    return closedHistoryItems.filter((item) => {
      const closedAtMs = new Date(item.closedAt).getTime();
      if (fromMs !== null && closedAtMs < fromMs) return false;
      if (toMs !== null && closedAtMs > toMs) return false;
      if (!term) return true;
      return [
        item.groupName,
        item.courseName,
        item.teacherName,
        item.closedByName,
        item.groupStatus,
        ...(item.courseMentorNames ?? []),
      ]
        .join(" ")
        .toLowerCase()
        .includes(term);
    });
  }, [closedHistoryItems, closedFrom, closedTo, search]);

  const filteredClosurePayrollItems = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return closurePayrollItems;
    return closurePayrollItems.filter((item) =>
      [
        item.payeeName,
        item.payeeEmail,
        item.groupName,
        item.courseName,
        item.program,
        item.plantelName,
        payrollStatusLabel(item.status),
        ...item.reasons,
      ]
        .join(" ")
        .toLowerCase()
        .includes(term),
    );
  }, [closurePayrollItems, search]);

  const dueCount = useMemo(() => items.filter((item) => item.due).length, [items]);
  const reviewReadyCount = useMemo(
    () => items.filter((item) => item.reviewReady && !item.due).length,
    [items],
  );
  const estimatedCount = Math.max(items.length - dueCount - reviewReadyCount, 0);
  const openWithoutDateCount = openWithoutDateItems.length;
  const closedHistoryCount = closedHistoryItems.length;

  const payrollItemsWithAmount = useMemo(
    () =>
      filteredClosurePayrollItems.map((item) => ({
        ...item,
        rate: payrollRates[item.level] ?? 0,
        amount: item.status === "payable" ? payrollRates[item.level] ?? 0 : 0,
      })),
    [filteredClosurePayrollItems, payrollRates],
  );

  const payrollTotals = useMemo(
    () =>
      payrollItemsWithAmount.reduce(
        (acc, item) => {
          acc.total += 1;
          acc[item.status] += 1;
          acc.amount += item.amount;
          return acc;
        },
        { total: 0, payable: 0, pending: 0, review: 0, paid: 0, amount: 0 },
      ),
    [payrollItemsWithAmount],
  );

  const clearClosedDateFilters = () => {
    setClosedFrom("");
    setClosedTo("");
  };

  const updatePayrollRate = (level: PayrollLevel, value: string) => {
    const parsed = Number(value);
    setPayrollRates((prev) => ({
      ...prev,
      [level]: Number.isFinite(parsed) && parsed >= 0 ? parsed : 0,
    }));
  };

  const exportClosedHistoryPdf = async () => {
    if (filteredClosedHistoryItems.length === 0) {
      toast.error("No hay registros cerrados para exportar");
      return;
    }

    setGeneratingClosedPdf(true);
    try {
      const { jsPDF } = await import("jspdf");
      const pdf = new jsPDF({ unit: "pt", format: "a4", orientation: "landscape" });
      const pageWidth = pdf.internal.pageSize.getWidth();
      const pageHeight = pdf.internal.pageSize.getHeight();
      const margin = 36;
      const lineHeight = 11;
      const columns = [
        { label: "Fecha cierre", width: 78, maxLines: 1 },
        { label: "Grupo", width: 210, maxLines: 2 },
        { label: "Materia", width: 190, maxLines: 2 },
        { label: "Cerrado por", width: 125, maxLines: 2 },
        { label: "Origen", width: 62, maxLines: 1 },
        { label: "Alumnos", width: 52, maxLines: 1 },
        { label: "Prom.", width: 52, maxLines: 1 },
      ];

      const dateRangeLabel =
        closedFrom || closedTo
          ? `Rango: ${closedFrom || "inicio"} a ${closedTo || "hoy"}`
          : "Rango: todos los cierres";
      const generatedAt = new Intl.DateTimeFormat("es-MX", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }).format(new Date());

      let y = margin;
      const drawHeader = () => {
        pdf.setTextColor(85, 27, 34);
        pdf.setFont("helvetica", "bold");
        pdf.setFontSize(16);
        pdf.text("Historial de materias cerradas", margin, y);
        y += 18;
        pdf.setFont("helvetica", "normal");
        pdf.setFontSize(9);
        pdf.setTextColor(117, 72, 72);
        pdf.text(`${dateRangeLabel} · Generado: ${generatedAt}`, margin, y);
        y += 18;

        pdf.setFillColor(243, 227, 219);
        pdf.rect(margin, y, pageWidth - margin * 2, 24, "F");
        pdf.setFont("helvetica", "bold");
        pdf.setFontSize(8);
        pdf.setTextColor(85, 27, 34);
        let x = margin + 6;
        columns.forEach((column) => {
          pdf.text(column.label, x, y + 15);
          x += column.width;
        });
        y += 24;
      };

      const ensurePageSpace = (rowHeight: number) => {
        if (y + rowHeight <= pageHeight - margin) return;
        pdf.addPage();
        y = margin;
        drawHeader();
      };

      const truncateLineToWidth = (line: string, maxWidth: number): string => {
        const normalized = line.replace(/\s+/g, " ").trim();
        if (pdf.getTextWidth(normalized) <= maxWidth) return normalized;
        const ellipsis = "...";
        let low = 0;
        let high = normalized.length;
        let best = ellipsis;
        while (low <= high) {
          const mid = Math.floor((low + high) / 2);
          const candidate = `${normalized.slice(0, mid).trimEnd()}${ellipsis}`;
          if (pdf.getTextWidth(candidate) <= maxWidth) {
            best = candidate;
            low = mid + 1;
          } else {
            high = mid - 1;
          }
        }
        return best;
      };

      const wrapCellText = (text: string, columnIndex: number): string[] => {
        const column = columns[columnIndex];
        const availableWidth = column.width - 10;
        const maxLines = column.maxLines;
        const normalized = text.replace(/\s+/g, " ").trim() || " ";
        const lines = (pdf.splitTextToSize(normalized, availableWidth) as string[])
          .map((line) => line.replace(/\s+/g, " ").trim())
          .filter(Boolean);
        const visibleLines = lines.length > 0 ? lines.slice(0, maxLines) : [" "];
        if (lines.length > maxLines && visibleLines.length > 0) {
          visibleLines[visibleLines.length - 1] = `${visibleLines[visibleLines.length - 1].replace(/\.+$/, "")}...`;
        }
        return visibleLines.map((line) => truncateLineToWidth(line, availableWidth));
      };

      drawHeader();
      pdf.setFont("helvetica", "normal");
      pdf.setFontSize(8);

      filteredClosedHistoryItems.forEach((item, index) => {
        const row = [
          formatDate(item.closedAt),
          item.groupName,
          item.courseName,
          item.closedByName || "Sin registrar",
          closedOriginLabel(item),
          `${item.closedCount} / ${item.totalClosedCount}`,
          formatGrade(item.averageFinalGrade),
        ];
        const wrappedCells = row.map((text, columnIndex) => wrapCellText(text, columnIndex));
        const rowHeight = Math.max(...wrappedCells.map((lines) => lines.length * lineHeight + 12), 24);
        ensurePageSpace(rowHeight);

        if (index % 2 === 0) {
          pdf.setFillColor(255, 250, 247);
          pdf.rect(margin, y, pageWidth - margin * 2, rowHeight, "F");
        }

        pdf.setTextColor(40, 40, 40);
        let x = margin + 6;
        wrappedCells.forEach((lines, columnIndex) => {
          lines.forEach((line, lineIndex) => {
            pdf.text(line, x, y + 14 + lineIndex * lineHeight);
          });
          x += columns[columnIndex].width;
        });
        y += rowHeight;
      });

      const pageCount = pdf.getNumberOfPages();
      for (let page = 1; page <= pageCount; page += 1) {
        pdf.setPage(page);
        pdf.setFont("helvetica", "normal");
        pdf.setFontSize(8);
        pdf.setTextColor(120, 120, 120);
        pdf.text(`Pagina ${page} de ${pageCount}`, pageWidth - margin - 70, pageHeight - 18);
      }

      const stamp = new Date().toISOString().slice(0, 10);
      const rangeToken = safeFileToken(`${closedFrom || "inicio"}-${closedTo || "hoy"}`);
      pdf.save(`historial-cerradas-${rangeToken}-${stamp}.pdf`);
    } catch (pdfError) {
      console.error(pdfError);
      toast.error("No se pudo generar el PDF");
    } finally {
      setGeneratingClosedPdf(false);
    }
  };

  const exportClosedHistoryExcel = async () => {
    if (filteredClosedHistoryItems.length === 0) {
      toast.error("No hay registros cerrados para exportar");
      return;
    }

    setGeneratingClosedExcel(true);
    try {
      const XLSX = await import("xlsx");
      const rows = filteredClosedHistoryItems.map(toClosedHistoryExportRow);
      const worksheet = XLSX.utils.json_to_sheet(rows);
      worksheet["!cols"] = [
        { wch: 16 },
        { wch: 32 },
        { wch: 36 },
        { wch: 28 },
        { wch: 14 },
        { wch: 20 },
        { wch: 22 },
        { wch: 14 },
      ];
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, worksheet, "Historial cerradas");

      const stamp = new Date().toISOString().slice(0, 10);
      const rangeToken = safeFileToken(`${closedFrom || "inicio"}-${closedTo || "hoy"}`);
      XLSX.writeFile(workbook, `historial-cerradas-${rangeToken}-${stamp}.xlsx`);
    } catch (excelError) {
      console.error(excelError);
      toast.error("No se pudo generar el Excel");
    } finally {
      setGeneratingClosedExcel(false);
    }
  };

  const exportClosurePayrollCsv = () => {
    if (payrollItemsWithAmount.length === 0) {
      toast.error("No hay registros de nomina para exportar");
      return;
    }
    const header = [
      "Estado",
      "Profesor",
      "Email",
      "Rol pago",
      "Banco",
      "CLABE",
      "Plantel",
      "Grupo",
      "Materia",
      "Programa",
      "Nivel",
      "Primer cierre",
      "Ultimo cierre",
      "Cerrados en semana",
      "Cerrados total",
      "Pendientes",
      "Alumnos total",
      "Tarifa MXN",
      "Monto pagable MXN",
      "Motivos",
      "Cerrado por",
      "Origen cierre",
    ];
    const body = payrollItemsWithAmount.map((item) =>
      [
        payrollStatusLabel(item.status),
        item.payeeName,
        item.payeeEmail,
        payrollRoleLabel(item.payeeRole),
        item.payrollDeposit.bank,
        item.payrollDeposit.clabe,
        item.plantelName || item.plantelId || "Sin plantel",
        item.groupName,
        item.courseName,
        item.program,
        payrollLevelLabel(item.level),
        item.firstClosedAt ? formatDate(item.firstClosedAt) : "Sin fecha",
        item.lastClosedAt ? formatDate(item.lastClosedAt) : "Sin fecha",
        item.closedInPeriodCount,
        item.totalClosedCount,
        item.openCount,
        item.totalStudents,
        item.rate.toFixed(2),
        item.amount.toFixed(2),
        item.reasons.join(" | ") || "Listo para pago",
        item.closedByNames.join(" | ") || "Sin registrar",
        item.closureTriggers.join(" | ") || "Sin origen",
      ]
        .map((value) => toCsvField(value))
        .join(","),
    );
    const csv = [header.map((value) => toCsvField(value)).join(","), ...body].join("\n");
    const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `nomina-cierres-${safeFileToken(`${payrollFrom}-${payrollTo}`)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const closeCourse = async (item: ClosureReviewItem) => {
    if (!currentUser) return;
    const confirmed = window.confirm(
      `Cerrar "${item.courseName}" en "${item.groupName}" para ${item.openCount} alumno(s)?`,
    );
    if (!confirmed) return;

    const key = `${item.groupId}:${item.courseId}`;
    setClosingKey(key);
    setError(null);
    try {
      const token = await currentUser.getIdToken();
      const response = await fetch("/api/admin/course-auto-closures", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          action: "closeCourse",
          groupId: item.groupId,
          courseId: item.courseId,
        }),
      });
      if (!response.ok) throw new Error(await readApiError(response));
      const payload = (await response.json()) as {
        data?: {
          result?: {
            closedCount?: number;
            skippedInvalidGradeCount?: number;
          };
          closedByName?: string;
        };
      };
      const closedCount = payload.data?.result?.closedCount ?? 0;
      const skipped = payload.data?.result?.skippedInvalidGradeCount ?? 0;
      toast.success(
        skipped > 0
          ? `Cerradas ${closedCount}. ${skipped} quedaron pendientes por calificacion invalida.`
          : `Materia cerrada para ${closedCount} alumno(s).`,
      );
      await loadItems(currentUser);
    } catch (closeError) {
      const message = closeError instanceof Error ? closeError.message : "No se pudo cerrar la materia";
      setError(message);
      toast.error(message);
    } finally {
      setClosingKey(null);
    }
  };

  return (
    <RoleGate allowedRole={["adminTeacher", "superAdminTeacher", "coordinadorPlantel", "director"]}>
      <div className="space-y-6 text-slate-900">
        <header className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-xs uppercase tracking-[0.3em] text-[#9f6e61]">Cierres</p>
            <h1 className="mt-2 text-3xl font-semibold text-[#551b22]">Cierre de materias</h1>
              <p className="mt-1 text-sm text-[#754848]">
                Materias abiertas con fecha estimada de cierre y reporte separado de materias abiertas sin fecha definida.
                Las de {Math.floor(dueDays / 7)} semanas o mas aparecen primero,
                seguidas por las de {Math.floor(reviewStartDays / 7)} semanas.
                {!canCloseCourse ? " Vista filtrada a tus grupos relacionados." : ""}
              </p>
          </div>
          <button
            type="button"
            onClick={() => currentUser && loadItems(currentUser)}
            disabled={!authReady || loading}
            className="inline-flex items-center justify-center gap-2 rounded-full border border-[#b67a68]/40 bg-[#fffaf7] px-4 py-2 text-sm font-medium text-[#6e2d2d] shadow-sm transition hover:-translate-y-0.5 hover:border-[#8a1f28] disabled:cursor-not-allowed disabled:opacity-60"
          >
            <RefreshCw size={16} />
            Actualizar
          </button>
        </header>

        {error ? (
          <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        ) : null}

        <div className="grid gap-4 md:grid-cols-5">
          <SummaryCard label="7 semanas o mas" value={dueCount.toString()} tone="danger" />
          <SummaryCard label="6 semanas" value={reviewReadyCount.toString()} tone="warning" />
          <SummaryCard label="Cierre futuro" value={estimatedCount.toString()} tone="neutral" />
          <SummaryCard label="Abiertas sin fecha" value={openWithoutDateCount.toString()} tone="neutral" />
          <SummaryCard label="Historial cerrado" value={closedHistoryCount.toString()} tone="success" />
        </div>

        <section className="creator-card overflow-hidden rounded-2xl border">
          <div className="flex flex-col gap-3 border-b border-[#d9b1a1]/60 px-5 py-4 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <p className="text-xs uppercase tracking-[0.2em] text-[#9f6e61]">Revision manual</p>
              <h2 className="text-lg font-semibold text-[#551b22]">Materias abiertas por grupo</h2>
            </div>
            <label className="relative w-full lg:w-96">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#9f6e61]" />
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Buscar grupo, materia o profesor"
                className="w-full rounded-lg border border-[#d9b1a1]/70 bg-white px-9 py-2 text-sm text-[#551b22] outline-none transition focus:border-[#8a1f28] focus:ring-2 focus:ring-[#6e2d2d]/10"
              />
            </label>
          </div>

          <div className="flex flex-wrap gap-2 border-b border-[#d9b1a1]/60 bg-[#fffaf7] px-5 py-3">
            <button
              type="button"
              onClick={() => setActiveTab("scheduled")}
              className={`rounded-full px-4 py-2 text-sm font-semibold transition ${
                activeTab === "scheduled"
                  ? "bg-[#6e2d2d] text-white"
                  : "border border-[#d9b1a1]/70 bg-white text-[#6e2d2d] hover:bg-[#f3e3db]/60"
              }`}
            >
              Con fecha de cierre ({items.length})
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("openWithoutDate")}
              className={`rounded-full px-4 py-2 text-sm font-semibold transition ${
                activeTab === "openWithoutDate"
                  ? "bg-[#6e2d2d] text-white"
                  : "border border-[#d9b1a1]/70 bg-white text-[#6e2d2d] hover:bg-[#f3e3db]/60"
              }`}
            >
              Abiertas sin fecha ({openWithoutDateItems.length})
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("closedHistory")}
              className={`rounded-full px-4 py-2 text-sm font-semibold transition ${
                activeTab === "closedHistory"
                  ? "bg-[#6e2d2d] text-white"
                  : "border border-[#d9b1a1]/70 bg-white text-[#6e2d2d] hover:bg-[#f3e3db]/60"
              }`}
            >
              Historial cerradas ({closedHistoryItems.length})
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("closurePayroll")}
              className={`rounded-full px-4 py-2 text-sm font-semibold transition ${
                activeTab === "closurePayroll"
                  ? "bg-[#6e2d2d] text-white"
                  : "border border-[#d9b1a1]/70 bg-white text-[#6e2d2d] hover:bg-[#f3e3db]/60"
              }`}
            >
              Nómina por cierres ({closurePayrollItems.length})
            </button>
          </div>

          {activeTab === "closedHistory" ? (
            <div className="flex flex-col gap-3 border-b border-[#d9b1a1]/60 bg-white/70 px-5 py-4 lg:flex-row lg:items-end lg:justify-between">
              <div>
                <p className="text-xs uppercase tracking-[0.18em] text-[#9f6e61]">Filtro por fecha</p>
                <p className="mt-1 text-sm text-[#754848]">
                  Usa la fecha de cierre para consultar un rango del historial.
                </p>
              </div>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                <label className="text-xs font-semibold uppercase tracking-[0.12em] text-[#754848]">
                  Desde
                  <input
                    type="date"
                    value={closedFrom}
                    onChange={(event) => setClosedFrom(event.target.value)}
                    className="mt-1 block rounded-lg border border-[#d9b1a1]/70 bg-white px-3 py-2 text-sm font-normal normal-case tracking-normal text-[#551b22] outline-none focus:border-[#8a1f28] focus:ring-2 focus:ring-[#6e2d2d]/10"
                  />
                </label>
                <label className="text-xs font-semibold uppercase tracking-[0.12em] text-[#754848]">
                  Hasta
                  <input
                    type="date"
                    value={closedTo}
                    onChange={(event) => setClosedTo(event.target.value)}
                    className="mt-1 block rounded-lg border border-[#d9b1a1]/70 bg-white px-3 py-2 text-sm font-normal normal-case tracking-normal text-[#551b22] outline-none focus:border-[#8a1f28] focus:ring-2 focus:ring-[#6e2d2d]/10"
                  />
                </label>
                <button
                  type="button"
                  onClick={() => currentUser && loadItems(currentUser)}
                  disabled={!currentUser || loading}
                  className="inline-flex items-center justify-center gap-2 rounded-lg bg-[#6e2d2d] px-3 py-2 text-sm font-semibold text-white transition hover:bg-[#551b22] disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <CalendarDays size={16} />
                  Filtrar
                </button>
                <button
                  type="button"
                  onClick={clearClosedDateFilters}
                  disabled={loading || (!closedFrom && !closedTo)}
                  className="rounded-lg border border-[#d9b1a1]/70 bg-white px-3 py-2 text-sm font-semibold text-[#6e2d2d] transition hover:bg-[#f3e3db]/60 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  Limpiar
                </button>
                <button
                  type="button"
                  onClick={exportClosedHistoryPdf}
                  disabled={loading || generatingClosedPdf || filteredClosedHistoryItems.length === 0}
                  className="inline-flex items-center justify-center gap-2 rounded-lg border border-[#6e2d2d]/30 bg-white px-3 py-2 text-sm font-semibold text-[#6e2d2d] transition hover:bg-[#f3e3db]/60 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <FileDown size={16} />
                  {generatingClosedPdf ? "Generando..." : "PDF"}
                </button>
                <button
                  type="button"
                  onClick={exportClosedHistoryExcel}
                  disabled={loading || generatingClosedExcel || filteredClosedHistoryItems.length === 0}
                  className="inline-flex items-center justify-center gap-2 rounded-lg border border-emerald-700/30 bg-white px-3 py-2 text-sm font-semibold text-emerald-700 transition hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <FileDown size={16} />
                  {generatingClosedExcel ? "Generando..." : "Excel"}
                </button>
              </div>
            </div>
          ) : null}

          {activeTab === "closurePayroll" ? (
            <div className="space-y-4 border-b border-[#d9b1a1]/60 bg-white/70 px-5 py-4">
              <div className="flex flex-col gap-3 xl:flex-row xl:items-end xl:justify-between">
                <div>
                  <p className="text-xs uppercase tracking-[0.18em] text-[#9f6e61]">Semana de pago</p>
                  <p className="mt-1 text-sm text-[#754848]">
                    Candidatos de pago generados desde materias cerradas en el rango seleccionado.
                  </p>
                </div>
                <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                  <label className="text-xs font-semibold uppercase tracking-[0.12em] text-[#754848]">
                    Desde
                    <input
                      type="date"
                      value={payrollFrom}
                      onChange={(event) => setPayrollFrom(event.target.value)}
                      className="mt-1 block rounded-lg border border-[#d9b1a1]/70 bg-white px-3 py-2 text-sm font-normal normal-case tracking-normal text-[#551b22] outline-none focus:border-[#8a1f28] focus:ring-2 focus:ring-[#6e2d2d]/10"
                    />
                  </label>
                  <label className="text-xs font-semibold uppercase tracking-[0.12em] text-[#754848]">
                    Hasta
                    <input
                      type="date"
                      value={payrollTo}
                      onChange={(event) => setPayrollTo(event.target.value)}
                      className="mt-1 block rounded-lg border border-[#d9b1a1]/70 bg-white px-3 py-2 text-sm font-normal normal-case tracking-normal text-[#551b22] outline-none focus:border-[#8a1f28] focus:ring-2 focus:ring-[#6e2d2d]/10"
                    />
                  </label>
                  <button
                    type="button"
                    onClick={() => currentUser && loadClosurePayrollItems(currentUser)}
                    disabled={!currentUser || payrollLoading}
                    className="inline-flex items-center justify-center gap-2 rounded-lg bg-[#6e2d2d] px-3 py-2 text-sm font-semibold text-white transition hover:bg-[#551b22] disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    <CalendarDays size={16} />
                    {payrollLoading ? "Cargando..." : "Consultar"}
                  </button>
                  <button
                    type="button"
                    onClick={exportClosurePayrollCsv}
                    disabled={payrollLoading || payrollItemsWithAmount.length === 0}
                    className="inline-flex items-center justify-center gap-2 rounded-lg border border-emerald-700/30 bg-white px-3 py-2 text-sm font-semibold text-emerald-700 transition hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    <FileDown size={16} />
                    CSV
                  </button>
                </div>
              </div>

              {payrollError ? (
                <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                  {payrollError}
                </div>
              ) : null}

              <div className="grid gap-3 md:grid-cols-5">
                <PayrollMiniStat label="Listas para pagar" value={payrollTotals.payable.toString()} tone="success" />
                <PayrollMiniStat label="Pendientes" value={payrollTotals.pending.toString()} tone="warning" />
                <PayrollMiniStat label="Revisar" value={payrollTotals.review.toString()} tone="danger" />
                <PayrollMiniStat label="Ya pagadas" value={payrollTotals.paid.toString()} tone="neutral" />
                <PayrollMiniStat label="Monto pagable" value={formatCurrency(payrollTotals.amount)} tone="success" />
              </div>

              <div className="grid gap-3 md:grid-cols-4">
                {(["licenciatura", "preparatoria", "otros", "sinPrograma"] as PayrollLevel[]).map((level) => (
                  <label key={level} className="text-xs font-semibold uppercase tracking-[0.12em] text-[#754848]">
                    Tarifa {payrollLevelLabel(level)}
                    <input
                      type="number"
                      min={0}
                      step="0.01"
                      value={payrollRates[level]}
                      onChange={(event) => updatePayrollRate(level, event.target.value)}
                      className="mt-1 block w-full rounded-lg border border-[#d9b1a1]/70 bg-white px-3 py-2 text-sm font-normal normal-case tracking-normal text-[#551b22] outline-none focus:border-[#8a1f28] focus:ring-2 focus:ring-[#6e2d2d]/10"
                    />
                  </label>
                ))}
              </div>
            </div>
          ) : null}

          {activeTab === "closurePayroll" && payrollLoading ? (
            <div className="px-5 py-6 text-sm text-[#754848]">Generando nomina por cierres...</div>
          ) : activeTab === "closurePayroll" && payrollItemsWithAmount.length === 0 ? (
            <div className="px-5 py-6 text-sm text-[#754848]">
              No hay materias cerradas en el rango seleccionado que coincidan con la busqueda.
            </div>
          ) : loading ? (
            <div className="px-5 py-6 text-sm text-[#754848]">Cargando materias...</div>
          ) : activeTab === "scheduled" && filteredItems.length === 0 ? (
            <div className="px-5 py-6 text-sm text-[#754848]">
              No hay materias abiertas con fecha estimada de cierre que coincidan con la busqueda.
            </div>
          ) : activeTab === "openWithoutDate" && filteredOpenWithoutDateItems.length === 0 ? (
            <div className="px-5 py-6 text-sm text-[#754848]">
              No hay materias abiertas sin fecha definida que coincidan con la busqueda.
            </div>
          ) : activeTab === "closedHistory" && filteredClosedHistoryItems.length === 0 ? (
            <div className="px-5 py-6 text-sm text-[#754848]">
              No hay materias cerradas que coincidan con la busqueda o el rango de fecha.
            </div>
          ) : activeTab === "closurePayroll" ? (
            <div className="overflow-x-auto">
              <table className="min-w-[1500px] divide-y divide-[#d9b1a1]/60 text-left text-sm">
                <thead className="bg-[#f3e3db]/60 text-xs uppercase tracking-[0.14em] text-[#754848]">
                  <tr>
                    <th className="px-5 py-3 font-semibold">Estado</th>
                    <th className="px-5 py-3 font-semibold">Profesor a pagar</th>
                    <th className="px-5 py-3 font-semibold">Grupo / materia</th>
                    <th className="px-5 py-3 font-semibold">Cierre</th>
                    <th className="px-5 py-3 font-semibold">Evidencia</th>
                    <th className="px-5 py-3 font-semibold">Pago</th>
                    <th className="px-5 py-3 font-semibold">Nomina</th>
                    <th className="px-5 py-3 font-semibold">Motivo</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#d9b1a1]/50 bg-white/60">
                  {payrollItemsWithAmount.map((item) => (
                    <tr key={item.sourceKey} className="align-top">
                      <td className="px-5 py-4">
                        <span
                          className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-semibold ${payrollStatusClass(item.status)}`}
                        >
                          <DollarSign size={14} />
                          {payrollStatusLabel(item.status)}
                        </span>
                      </td>
                      <td className="min-w-64 px-5 py-4">
                        <p className="font-semibold text-[#551b22]">{item.payeeName}</p>
                        <p className="text-xs text-[#754848]">{item.payeeEmail || "Sin correo"}</p>
                        <p className="text-xs text-[#9f6e61]">{payrollRoleLabel(item.payeeRole)}</p>
                      </td>
                      <td className="min-w-72 px-5 py-4">
                        <p className="font-semibold text-[#551b22]">{item.groupName}</p>
                        <p className="text-sm font-medium text-[#754848]">{item.courseName}</p>
                        <p className="text-xs text-[#9f6e61]">
                          {item.plantelName || "Sin plantel"} · {item.program || "Sin programa"}
                        </p>
                      </td>
                      <td className="px-5 py-4 text-[#754848]">
                        <p className="font-medium text-[#551b22]">{formatDate(item.lastClosedAt)}</p>
                        <p className="text-xs">
                          Primer cierre: {item.firstClosedAt ? formatDate(item.firstClosedAt) : "Sin fecha"}
                        </p>
                      </td>
                      <td className="px-5 py-4 text-[#754848]">
                        <p className="font-medium text-[#551b22]">
                          {item.totalClosedCount}/{item.totalStudents} alumnos cerrados
                        </p>
                        <p className="text-xs">{item.closedInPeriodCount} cierre(s) en semana</p>
                        <p className="text-xs">{item.openCount} pendiente(s)</p>
                      </td>
                      <td className="px-5 py-4 text-[#754848]">
                        <p className="font-semibold text-[#551b22]">{formatCurrency(item.amount)}</p>
                        <p className="text-xs">
                          {payrollLevelLabel(item.level)} · tarifa {formatCurrency(item.rate)}
                        </p>
                      </td>
                      <td className="min-w-56 px-5 py-4 text-[#754848]">
                        <p className="font-medium text-[#551b22]">
                          {item.payrollDeposit.bank || "Sin banco"}
                        </p>
                        <p className="text-xs">
                          {item.payrollDeposit.clabe ? `CLABE ${item.payrollDeposit.clabe}` : "Sin CLABE"}
                        </p>
                      </td>
                      <td className="min-w-64 px-5 py-4 text-xs text-[#754848]">
                        {item.reasons.length > 0 ? item.reasons.join(" · ") : "Materia completa y lista para pago"}
                        {item.closedByNames.length > 0 ? (
                          <p className="mt-1 text-[#9f6e61]">
                            Cerrado por: {item.closedByNames.join(", ")}
                          </p>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : activeTab === "scheduled" ? (
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-[#d9b1a1]/60 text-left text-sm">
                <thead className="bg-[#f3e3db]/60 text-xs uppercase tracking-[0.14em] text-[#754848]">
                  <tr>
                    <th className="px-5 py-3 font-semibold">Estado</th>
                    <th className="px-5 py-3 font-semibold">Grupo</th>
                    <th className="px-5 py-3 font-semibold">Materia</th>
                    <th className="px-5 py-3 font-semibold">Responsable / titular</th>
                    <th className="px-5 py-3 font-semibold">Cierre estimado</th>
                    <th className="px-5 py-3 font-semibold">Avance</th>
                    {canCloseCourse ? <th className="px-5 py-3 font-semibold">Accion</th> : null}
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#d9b1a1]/50 bg-white/60">
                  {filteredItems.map((item) => {
                    const key = `${item.groupId}:${item.courseId}`;
                    return (
                      <tr key={key} className="align-top">
                        <td className="px-5 py-4">
                          <span
                            className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-semibold ${
                              item.due
                                ? "bg-red-100 text-red-700"
                                : item.reviewReady
                                  ? "bg-amber-100 text-amber-700"
                                  : "bg-slate-100 text-slate-700"
                            }`}
                          >
                            <ShieldCheck size={14} />
                            {dueLabel(item)}
                          </span>
                        </td>
                        <td className="min-w-56 px-5 py-4">
                          <p className="font-semibold text-[#551b22]">{item.groupName}</p>
                          <p className="text-xs text-[#754848]">
                            {item.weeksSinceEnabled} semana(s), {item.daysSinceEnabled} dias activa
                          </p>
                        </td>
                        <td className="min-w-56 px-5 py-4 font-medium text-[#551b22]">
                          {item.courseName}
                        </td>
                        <TeacherMentorsCell
                          teacherName={item.teacherName}
                          mentorNames={item.courseMentorNames}
                        />
                        <td className="px-5 py-4 text-[#754848]">
                          <p className="font-medium text-[#551b22]">{formatDate(item.estimatedCloseAt)}</p>
                          <p className="text-xs">Habilitada: {formatDate(item.enabledAt)}</p>
                        </td>
                        <td className="px-5 py-4 text-[#754848]">
                          <p className="font-medium text-[#551b22]">
                            {item.closedCount}/{item.totalCount} cerrados
                          </p>
                          <p className="text-xs">{item.openCount} pendientes</p>
                        </td>
                        {canCloseCourse ? (
                          <td className="px-5 py-4">
                            <button
                              type="button"
                              onClick={() => closeCourse(item)}
                              disabled={closingKey === key}
                              className="inline-flex whitespace-nowrap items-center gap-2 rounded-lg bg-[#6e2d2d] px-3 py-2 text-sm font-semibold text-white transition hover:bg-[#551b22] disabled:cursor-not-allowed disabled:opacity-60"
                            >
                              <CheckCircle2 size={16} />
                              {closingKey === key ? "Cerrando..." : "Cerrar materia"}
                            </button>
                          </td>
                        ) : null}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : activeTab === "openWithoutDate" ? (
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-[#d9b1a1]/60 text-left text-sm">
                <thead className="bg-[#f3e3db]/60 text-xs uppercase tracking-[0.14em] text-[#754848]">
                  <tr>
                    <th className="px-5 py-3 font-semibold">Estado</th>
                    <th className="px-5 py-3 font-semibold">Grupo</th>
                    <th className="px-5 py-3 font-semibold">Materia</th>
                    <th className="px-5 py-3 font-semibold">Responsable / titular</th>
                    <th className="px-5 py-3 font-semibold">Tiempo abierta</th>
                    <th className="px-5 py-3 font-semibold">Fecha definida</th>
                    <th className="px-5 py-3 font-semibold">Avance</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#d9b1a1]/50 bg-white/60">
                  {filteredOpenWithoutDateItems.map((item) => {
                    const key = `${item.groupId}:${item.courseId}`;
                    return (
                      <tr key={key} className="align-top">
                        <td className="px-5 py-4">
                          <span className="inline-flex items-center gap-2 rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700">
                            <ShieldCheck size={14} />
                            Abierta sin fecha
                          </span>
                        </td>
                        <td className="min-w-56 px-5 py-4">
                          <p className="font-semibold text-[#551b22]">{item.groupName}</p>
                          <p className="text-xs text-[#754848]">Grupo activo</p>
                        </td>
                        <td className="min-w-56 px-5 py-4 font-medium text-[#551b22]">
                          {item.courseName}
                        </td>
                        <TeacherMentorsCell
                          teacherName={item.teacherName}
                          mentorNames={item.courseMentorNames}
                        />
                        <td className="px-5 py-4 text-[#754848]">
                          <p className="font-medium text-[#551b22]">{daysOpenLabel(item)}</p>
                          <p className="text-xs">
                            {item.openedEstimateFrom ? formatDate(item.openedEstimateFrom) : "Sin fecha"} ·{" "}
                            {openEstimateSourceLabel(item.openedEstimateSource)}
                          </p>
                        </td>
                        <td className="px-5 py-4 text-[#754848]">
                          <p className="font-medium text-[#551b22]">
                            {item.groupEndDate ? formatDate(item.groupEndDate) : "Sin fecha"}
                          </p>
                          <p className="text-xs">Sin cierre estimado de materia</p>
                        </td>
                        <td className="px-5 py-4 text-[#754848]">
                          <p className="font-medium text-[#551b22]">
                            {item.closedCount}/{item.totalCount} cerrados
                          </p>
                          <p className="text-xs">{item.openCount} pendientes</p>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-[#d9b1a1]/60 text-left text-sm">
                <thead className="bg-[#f3e3db]/60 text-xs uppercase tracking-[0.14em] text-[#754848]">
                  <tr>
                    <th className="px-5 py-3 font-semibold">Fecha cierre</th>
                    <th className="px-5 py-3 font-semibold">Grupo</th>
                    <th className="px-5 py-3 font-semibold">Materia</th>
                    <th className="px-5 py-3 font-semibold">Cerrado por</th>
                    <th className="px-5 py-3 font-semibold">Alumnos</th>
                    <th className="px-5 py-3 font-semibold">Promedio</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#d9b1a1]/50 bg-white/60">
                  {filteredClosedHistoryItems.map((item) => {
                    const key = [
                      item.groupId,
                      item.courseId,
                      item.closedAt,
                      item.closedByName,
                      item.closureTrigger ?? "",
                    ].join(":");
                    return (
                      <tr key={key} className="align-top">
                        <td className="px-5 py-4 text-[#754848]">
                          <p className="font-medium text-[#551b22]">{formatDate(item.closedAt)}</p>
                          <span className="mt-2 inline-flex items-center gap-2 rounded-full bg-emerald-100 px-3 py-1 text-xs font-semibold text-emerald-700">
                            <ShieldCheck size={14} />
                            Cerrada
                          </span>
                        </td>
                        <td className="min-w-56 px-5 py-4">
                          <p className="font-semibold text-[#551b22]">{item.groupName}</p>
                          <p className="text-xs text-[#754848]">Estado grupo: {item.groupStatus}</p>
                        </td>
                        <td className="min-w-56 px-5 py-4 font-medium text-[#551b22]">
                          {item.courseName}
                        </td>
                        <td className="px-5 py-4 text-[#754848]">
                          <p className="font-medium text-[#551b22]">{item.closedByName || "Sin registrar"}</p>
                          <p className="text-xs">{closedOriginLabel(item)}</p>
                        </td>
                        <td className="px-5 py-4 text-[#754848]">
                          <p className="font-medium text-[#551b22]">
                            {item.closedCount} en este cierre
                          </p>
                          <p className="text-xs">{item.totalClosedCount} cerrados en total</p>
                        </td>
                        <td className="px-5 py-4 text-[#754848]">
                          <p className="font-medium text-[#551b22]">{formatGrade(item.averageFinalGrade)}</p>
                          <p className="text-xs">Calificacion final</p>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </RoleGate>
  );
}

function SummaryCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "danger" | "warning" | "neutral" | "success";
}) {
  const toneClass =
    tone === "danger"
      ? "bg-red-100 text-red-700"
      : tone === "warning"
        ? "bg-amber-100 text-amber-700"
        : tone === "success"
          ? "bg-emerald-100 text-emerald-700"
        : "bg-slate-100 text-slate-700";
  return (
    <div className="creator-card rounded-2xl border p-5">
      <p className="text-xs uppercase tracking-[0.2em] text-[#9f6e61]">{label}</p>
      <div className="mt-3 flex items-center gap-3">
        <span className={`rounded-full px-3 py-1 text-sm font-semibold ${toneClass}`}>{value}</span>
      </div>
    </div>
  );
}

function PayrollMiniStat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "danger" | "warning" | "neutral" | "success";
}) {
  const toneClass =
    tone === "danger"
      ? "bg-red-100 text-red-700"
      : tone === "warning"
        ? "bg-amber-100 text-amber-700"
        : tone === "success"
          ? "bg-emerald-100 text-emerald-700"
          : "bg-slate-100 text-slate-700";
  return (
    <div className="rounded-lg border border-[#d9b1a1]/70 bg-white px-4 py-3">
      <p className="text-xs uppercase tracking-[0.14em] text-[#9f6e61]">{label}</p>
      <p className={`mt-2 inline-flex rounded-full px-3 py-1 text-sm font-semibold ${toneClass}`}>{value}</p>
    </div>
  );
}

function TeacherMentorsCell({
  teacherName,
  mentorNames,
}: {
  teacherName: string;
  mentorNames?: string[];
}) {
  const mentors = Array.from(new Set((mentorNames ?? []).map((name) => name.trim()).filter(Boolean)));
  const hasSingleMentor = mentors.length === 1;
  const hasMultipleMentors = mentors.length > 1;
  return (
    <td className="min-w-56 px-5 py-4 text-[#754848]">
      {hasSingleMentor ? (
        <>
          <p className="text-xs uppercase tracking-[0.12em] text-emerald-700">Responsable de pago</p>
          <p className="font-semibold text-[#551b22]">{mentors[0]}</p>
          <p className="mt-1 text-xs text-[#9f6e61]">Titular del grupo: {teacherName || "Sin profesor"}</p>
        </>
      ) : hasMultipleMentors ? (
        <>
          <p className="text-xs uppercase tracking-[0.12em] text-red-700">Revisar responsable</p>
          <div className="mt-1 flex flex-wrap gap-1">
            {mentors.map((mentor) => (
              <span
                key={mentor}
                className="rounded-full border border-red-200 bg-red-50 px-2 py-0.5 text-[11px] font-semibold text-red-700"
              >
                {mentor}
              </span>
            ))}
          </div>
          <p className="mt-1 text-xs text-[#9f6e61]">Titular del grupo: {teacherName || "Sin profesor"}</p>
        </>
      ) : (
        <>
          <p className="text-xs uppercase tracking-[0.12em] text-[#9f6e61]">Responsable de pago</p>
          <p className="font-semibold text-[#551b22]">{teacherName || "Sin profesor"}</p>
          <p className="mt-1 text-xs text-[#9f6e61]">Sin mentor asignado a la materia</p>
        </>
      )}
    </td>
  );
}
