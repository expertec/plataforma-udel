"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  collection,
  collectionGroup,
  doc,
  documentId,
  getDocs,
  limit,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  where,
} from "firebase/firestore";
import toast from "react-hot-toast";
import * as XLSX from "xlsx";
import { db } from "@/lib/firebase/firestore";

const ACTIVITY_DAYS_THRESHOLD = 7;
const SUBMISSION_DAYS_THRESHOLD = 14;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const QUERY_BATCH_SIZE = 20;
const FIRESTORE_IN_QUERY_LIMIT = 30;

type DropoutRiskLevel = "none" | "medium" | "high";

type StudentEnrollmentSummary = {
  studentId: string;
  studentName: string;
  studentEmail: string;
  enrollmentIds: string[];
  groupIds: string[];
  groupNames: string[];
  firstEnrollmentAt: Date | null;
};

type RiskRow = {
  studentId: string;
  studentName: string;
  studentEmail: string;
  studentWhatsapp: string;
  groupNames: string[];
  riskLevel: DropoutRiskLevel;
  reasons: string[];
  lastActivityAt: Date | null;
  lastSubmissionAt: Date | null;
  daysWithoutActivity: number | null;
  daysWithoutSubmission: number | null;
  isTaggedAsBaja: boolean;
};

function toDate(value: unknown): Date | null {
  if (!value) return null;

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  if (typeof value === "object") {
    if ("toDate" in value && typeof (value as { toDate?: unknown }).toDate === "function") {
      try {
        const maybe = (value as { toDate: () => Date }).toDate();
        return Number.isNaN(maybe.getTime()) ? null : maybe;
      } catch {
        return null;
      }
    }

    const seconds = (value as { seconds?: unknown }).seconds;
    const nanoseconds = (value as { nanoseconds?: unknown }).nanoseconds;
    if (typeof seconds === "number" && Number.isFinite(seconds)) {
      const nanos = typeof nanoseconds === "number" && Number.isFinite(nanoseconds) ? nanoseconds : 0;
      const date = new Date(Math.trunc(seconds * 1000 + nanos / 1_000_000));
      return Number.isNaN(date.getTime()) ? null : date;
    }
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  if (typeof value === "string") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  return null;
}

function maxDate(a: Date | null, b: Date | null): Date | null {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

function minDate(a: Date | null, b: Date | null): Date | null {
  if (!a) return b;
  if (!b) return a;
  return a < b ? a : b;
}

function daysSince(date: Date | null, now: Date): number | null {
  if (!date) return null;
  const delta = now.getTime() - date.getTime();
  if (delta <= 0) return 0;
  return Math.floor(delta / MS_PER_DAY);
}

function formatDateTime(date: Date | null): string {
  if (!date) return "Sin registro";
  return new Intl.DateTimeFormat("es-MX", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

async function runInBatches<T>(tasks: Array<() => Promise<T>>, batchSize: number): Promise<T[]> {
  const results: T[] = [];
  for (let idx = 0; idx < tasks.length; idx += batchSize) {
    const chunk = tasks.slice(idx, idx + batchSize);
    const chunkResults = await Promise.all(chunk.map((task) => task()));
    results.push(...chunkResults);
  }
  return results;
}

function chunkArray<T>(items: T[], chunkSize: number): T[][] {
  if (chunkSize <= 0) return [items];
  const chunks: T[][] = [];
  for (let idx = 0; idx < items.length; idx += chunkSize) {
    chunks.push(items.slice(idx, idx + chunkSize));
  }
  return chunks;
}

function resolveStudentWhatsApp(data: Record<string, unknown>): string {
  const candidates = [
    data.whatsapp,
    data.whatsApp,
    data.whatsappPhone,
    data.whatsappNumber,
    data.phone,
    data.telefono,
    data.tel,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return "";
}

function hasBajaTag(value: unknown): boolean {
  return typeof value === "string" && value.trim().toLowerCase() === "baja";
}

export function StudentDropoutRiskTab() {
  const [rows, setRows] = useState<RiskRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [taggingStudents, setTaggingStudents] = useState<Record<string, boolean>>({});
  const [exporting, setExporting] = useState(false);

  const loadRiskReport = useCallback(async () => {
    setLoading(true);
    setErrorMessage(null);

    try {
      const enrollmentsSnap = await getDocs(collection(db, "studentEnrollments"));

      const byStudent = new Map<string, StudentEnrollmentSummary>();
      enrollmentsSnap.docs.forEach((docSnap) => {
        const data = docSnap.data() as {
          studentId?: unknown;
          studentName?: unknown;
          studentEmail?: unknown;
          groupId?: unknown;
          groupName?: unknown;
          enrolledAt?: unknown;
          createdAt?: unknown;
        };
        const studentId =
          typeof data.studentId === "string" && data.studentId.trim().length > 0
            ? data.studentId.trim()
            : docSnap.id.includes("_")
            ? docSnap.id.split("_").slice(1).join("_").trim()
            : "";
        if (!studentId) return;

        const studentName =
          typeof data.studentName === "string" && data.studentName.trim().length > 0
            ? data.studentName.trim()
            : "Alumno";
        const studentEmail =
          typeof data.studentEmail === "string" && data.studentEmail.trim().length > 0
            ? data.studentEmail.trim()
            : "";
        const groupId =
          typeof data.groupId === "string" && data.groupId.trim().length > 0
            ? data.groupId.trim()
            : "";
        const groupName =
          typeof data.groupName === "string" && data.groupName.trim().length > 0
            ? data.groupName.trim()
            : groupId;

        const enrolledAt = toDate(data.enrolledAt) ?? toDate(data.createdAt);

        const current = byStudent.get(studentId);
        if (!current) {
          byStudent.set(studentId, {
            studentId,
            studentName,
            studentEmail,
            enrollmentIds: [docSnap.id],
            groupIds: groupId ? [groupId] : [],
            groupNames: groupName ? [groupName] : [],
            firstEnrollmentAt: enrolledAt,
          });
          return;
        }

        const enrollmentSet = new Set(current.enrollmentIds);
        enrollmentSet.add(docSnap.id);
        const groupSet = new Set(current.groupIds);
        if (groupId) groupSet.add(groupId);
        const groupNameSet = new Set(current.groupNames);
        if (groupName) groupNameSet.add(groupName);

        byStudent.set(studentId, {
          studentId,
          studentName: current.studentName || studentName,
          studentEmail: current.studentEmail || studentEmail,
          enrollmentIds: Array.from(enrollmentSet),
          groupIds: Array.from(groupSet),
          groupNames: Array.from(groupNameSet),
          firstEnrollmentAt: minDate(current.firstEnrollmentAt, enrolledAt),
        });
      });

      const students = Array.from(byStudent.values());
      if (students.length === 0) {
        setRows([]);
        return;
      }

      const profileByStudent = new Map<string, { whatsapp: string; isTaggedAsBaja: boolean }>();
      const profileTasks = chunkArray(
        students.map((student) => student.studentId),
        FIRESTORE_IN_QUERY_LIMIT,
      ).map((studentIds) => async () => {
        if (studentIds.length === 0) return;
        const usersSnap = await getDocs(
          query(collection(db, "users"), where(documentId(), "in", studentIds)),
        );
        usersSnap.docs.forEach((userDoc) => {
          const data = userDoc.data() as Record<string, unknown>;
          profileByStudent.set(userDoc.id, {
            whatsapp: resolveStudentWhatsApp(data),
            isTaggedAsBaja: hasBajaTag(data.dropoutRiskTag),
          });
        });
      });
      await runInBatches(profileTasks, QUERY_BATCH_SIZE);

      const lastProgressByStudent = new Map<string, Date>();
      const progressTasks = students.flatMap((student) =>
        student.enrollmentIds.map((enrollmentId) => async () => {
          const progressSnap = await getDocs(
            query(
              collection(db, "studentEnrollments", enrollmentId, "classProgress"),
              orderBy("lastUpdated", "desc"),
              limit(1),
            ),
          );
          if (progressSnap.empty) return;

          const progressData = progressSnap.docs[0].data() as {
            lastUpdated?: unknown;
            completedAt?: unknown;
            updatedAt?: unknown;
          };
          const latest =
            toDate(progressData.lastUpdated) ??
            toDate(progressData.completedAt) ??
            toDate(progressData.updatedAt);
          if (!latest) return;
          const current = lastProgressByStudent.get(student.studentId);
          if (!current || latest > current) {
            lastProgressByStudent.set(student.studentId, latest);
          }
        }),
      );
      await runInBatches(progressTasks, QUERY_BATCH_SIZE);

      const lastSubmissionByStudent = new Map<string, Date>();
      const submissionTasks = students.map((student) => async () => {
        const submissionsSnap = await getDocs(
          query(
            collectionGroup(db, "submissions"),
            where("studentId", "==", student.studentId),
            orderBy("submittedAt", "desc"),
            limit(1),
          ),
        );
        if (submissionsSnap.empty) return;
        const submissionData = submissionsSnap.docs[0].data() as { submittedAt?: unknown };
        const latest = toDate(submissionData.submittedAt);
        if (!latest) return;
        lastSubmissionByStudent.set(student.studentId, latest);
      });
      await runInBatches(submissionTasks, QUERY_BATCH_SIZE);

      const now = new Date();
      const computed = students.map((student) => {
        const lastProgress = lastProgressByStudent.get(student.studentId) ?? null;
        const lastSubmission = lastSubmissionByStudent.get(student.studentId) ?? null;
        const lastActivity = maxDate(lastProgress, lastSubmission);
        const enrollmentAgeDays = daysSince(student.firstEnrollmentAt, now);
        const daysNoActivity = daysSince(lastActivity, now);
        const daysNoSubmission = daysSince(lastSubmission, now);

        const inactivityRisk =
          daysNoActivity === null
            ? (enrollmentAgeDays ?? 0) >= ACTIVITY_DAYS_THRESHOLD
            : daysNoActivity >= ACTIVITY_DAYS_THRESHOLD;
        const submissionRisk =
          daysNoSubmission === null
            ? (enrollmentAgeDays ?? 0) >= SUBMISSION_DAYS_THRESHOLD
            : daysNoSubmission >= SUBMISSION_DAYS_THRESHOLD;

        const reasons: string[] = [];
        if (inactivityRisk) {
          reasons.push(
            daysNoActivity === null
              ? "Sin actividad registrada en plataforma"
              : `Sin actividad ${daysNoActivity} día${daysNoActivity === 1 ? "" : "s"}`,
          );
        }
        if (submissionRisk) {
          reasons.push(
            daysNoSubmission === null
              ? "Sin tareas enviadas"
              : `Sin enviar tareas ${daysNoSubmission} día${daysNoSubmission === 1 ? "" : "s"}`,
          );
        }

        const riskLevel: DropoutRiskLevel =
          reasons.length === 0 ? "none" : reasons.length >= 2 ? "high" : "medium";

        return {
          studentId: student.studentId,
          studentName: student.studentName,
          studentEmail: student.studentEmail,
          studentWhatsapp: profileByStudent.get(student.studentId)?.whatsapp ?? "",
          groupNames: student.groupNames,
          riskLevel,
          reasons,
          lastActivityAt: lastActivity,
          lastSubmissionAt: lastSubmission,
          daysWithoutActivity: daysNoActivity,
          daysWithoutSubmission: daysNoSubmission,
          isTaggedAsBaja: profileByStudent.get(student.studentId)?.isTaggedAsBaja ?? false,
        } satisfies RiskRow;
      });

      const riskWeight: Record<DropoutRiskLevel, number> = {
        none: 0,
        medium: 1,
        high: 2,
      };

      const atRiskRows = computed
        .filter((row) => row.riskLevel !== "none" && !row.isTaggedAsBaja)
        .sort((a, b) => {
          const bySeverity = riskWeight[b.riskLevel] - riskWeight[a.riskLevel];
          if (bySeverity !== 0) return bySeverity;
          return (b.daysWithoutActivity ?? 0) - (a.daysWithoutActivity ?? 0);
        });

      setRows(atRiskRows);
    } catch (error) {
      console.error("Error cargando reporte de riesgo de deserción:", error);
      setRows([]);
      setErrorMessage("No se pudo cargar el reporte de riesgo.");
      toast.error("No se pudo cargar el reporte de riesgo de deserción");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadRiskReport();
  }, [loadRiskReport]);

  const handleTagAsBaja = useCallback(async (row: RiskRow) => {
    setTaggingStudents((prev) => ({ ...prev, [row.studentId]: true }));

    try {
      await setDoc(
        doc(db, "users", row.studentId),
        {
          dropoutRiskTag: "Baja",
          dropoutRiskTaggedAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        },
        { merge: true },
      );
      setRows((prev) => prev.filter((current) => current.studentId !== row.studentId));
      toast.success(`${row.studentName} etiquetado como Baja.`);
    } catch (error) {
      console.error("Error etiquetando alumno como baja:", error);
      toast.error("No se pudo etiquetar al alumno como Baja.");
    } finally {
      setTaggingStudents((prev) => {
        const next = { ...prev };
        delete next[row.studentId];
        return next;
      });
    }
  }, []);

  const handleExportToExcel = useCallback(() => {
    if (rows.length === 0) {
      toast.error("No hay datos para exportar.");
      return;
    }

    setExporting(true);
    try {
      const exportRows = rows.map((row) => ({
        Alumno: row.studentName,
        Correo: row.studentEmail || "Sin correo",
        WhatsApp: row.studentWhatsapp || "Sin registro",
        Grupo: row.groupNames.length > 0 ? row.groupNames.join(" | ") : "Sin grupo",
        Riesgo: row.riskLevel === "high" ? "Alto" : "Medio",
        "Ultima actividad": formatDateTime(row.lastActivityAt),
        "Ultima tarea": formatDateTime(row.lastSubmissionAt),
        Motivos: row.reasons.join(" | "),
      }));

      const sheet = XLSX.utils.json_to_sheet(exportRows);
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, sheet, "Riesgo");
      XLSX.writeFile(workbook, `reporte-riesgo-desercion-${new Date().toISOString().slice(0, 10)}.xlsx`);
      toast.success("Reporte exportado.");
    } catch (error) {
      console.error("Error exportando reporte de riesgo:", error);
      toast.error("No se pudo exportar el reporte.");
    } finally {
      setExporting(false);
    }
  }, [rows]);

  const summary = useMemo(() => {
    const high = rows.filter((row) => row.riskLevel === "high").length;
    const medium = rows.filter((row) => row.riskLevel === "medium").length;
    return {
      total: rows.length,
      high,
      medium,
    };
  }, [rows]);

  return (
    <div className="space-y-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Riesgo de deserción</p>
          <h2 className="text-lg font-semibold text-slate-900">Reporte global de alumnos en riesgo</h2>
          <p className="text-sm text-slate-600">
            Reglas: actividad &gt;= {ACTIVITY_DAYS_THRESHOLD} días sin registrar o tareas sin envío por{" "}
            {SUBMISSION_DAYS_THRESHOLD}+ días. Los alumnos etiquetados como Baja se excluyen del reporte.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={handleExportToExcel}
            disabled={loading || rows.length === 0 || exporting}
            className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-700 hover:bg-emerald-100 disabled:opacity-60"
          >
            {exporting ? "Exportando..." : "Exportar a Excel"}
          </button>
          <button
            type="button"
            onClick={() => void loadRiskReport()}
            disabled={loading}
            className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60"
          >
            {loading ? "Calculando..." : "Recalcular reporte"}
          </button>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-lg border border-red-100 bg-red-50 p-3">
          <p className="text-xs uppercase tracking-wide text-red-700">Riesgo alto</p>
          <p className="text-lg font-semibold text-red-800">{summary.high}</p>
        </div>
        <div className="rounded-lg border border-amber-100 bg-amber-50 p-3">
          <p className="text-xs uppercase tracking-wide text-amber-700">Riesgo medio</p>
          <p className="text-lg font-semibold text-amber-800">{summary.medium}</p>
        </div>
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
          <p className="text-xs uppercase tracking-wide text-slate-600">Total en riesgo</p>
          <p className="text-lg font-semibold text-slate-900">{summary.total}</p>
        </div>
      </div>

      {loading ? (
        <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50 p-5 text-sm text-slate-600">
          Calculando reporte de riesgo...
        </div>
      ) : errorMessage ? (
        <div className="rounded-lg border border-rose-200 bg-rose-50 p-5 text-sm text-rose-700">
          {errorMessage}
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-emerald-200 bg-emerald-50 p-5 text-sm text-emerald-700">
          No se detectaron alumnos en riesgo con las reglas actuales.
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-slate-200">
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm text-slate-800">
              <thead className="bg-slate-50 text-xs font-semibold text-slate-600">
                <tr>
                  <th className="px-4 py-2 text-left">Alumno</th>
                  <th className="px-4 py-2 text-left">WhatsApp</th>
                  <th className="px-4 py-2 text-left">Riesgo</th>
                  <th className="px-4 py-2 text-left">Grupo</th>
                  <th className="px-4 py-2 text-left">Última actividad</th>
                  <th className="px-4 py-2 text-left">Última tarea</th>
                  <th className="px-4 py-2 text-left">Motivo</th>
                  <th className="px-4 py-2 text-left">Etiqueta</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 bg-white">
                {rows.map((row) => (
                  <tr key={row.studentId}>
                    <td className="px-4 py-3">
                      <p className="font-medium text-slate-900">{row.studentName}</p>
                      <p className="text-xs text-slate-500">{row.studentEmail || "Sin correo"}</p>
                    </td>
                    <td className="px-4 py-3 text-slate-700">{row.studentWhatsapp || "Sin registro"}</td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ${
                          row.riskLevel === "high"
                            ? "bg-red-100 text-red-700"
                            : "bg-amber-100 text-amber-700"
                        }`}
                      >
                        {row.riskLevel === "high" ? "Alto" : "Medio"}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-slate-700">
                      {row.groupNames.length > 0 ? (
                        row.groupNames.map((groupName) => (
                          <p key={`${row.studentId}-${groupName}`} className="text-xs">
                            {groupName}
                          </p>
                        ))
                      ) : (
                        <p className="text-xs">Sin grupo</p>
                      )}
                    </td>
                    <td className="px-4 py-3 text-slate-700">{formatDateTime(row.lastActivityAt)}</td>
                    <td className="px-4 py-3 text-slate-700">{formatDateTime(row.lastSubmissionAt)}</td>
                    <td className="px-4 py-3 text-slate-700">
                      {row.reasons.map((reason, idx) => (
                        <p key={`${row.studentId}-${idx}`} className="text-xs">
                          {reason}
                        </p>
                      ))}
                    </td>
                    <td className="px-4 py-3 text-slate-700">
                      <select
                        value=""
                        onChange={(event) => {
                          if (event.target.value === "Baja") {
                            void handleTagAsBaja(row);
                          }
                        }}
                        disabled={Boolean(taggingStudents[row.studentId])}
                        className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-700 disabled:opacity-60"
                      >
                        <option value="">Seleccionar</option>
                        <option value="Baja">Baja</option>
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
