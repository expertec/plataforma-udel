"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { collection, getDocs, limit, orderBy, query, where } from "firebase/firestore";
import toast from "react-hot-toast";
import { db } from "@/lib/firebase/firestore";
import { getAllSubmissions } from "@/lib/firebase/submissions-service";

const INACTIVITY_DAYS_THRESHOLD = 7;
const PENDING_DELIVERIES_THRESHOLD = 2;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

type GroupStudentSummary = {
  id: string;
  studentName: string;
  studentEmail: string;
  enrolledAt?: Date;
};

type DropoutRiskLevel = "none" | "medium" | "high";

type RiskRow = {
  studentId: string;
  studentName: string;
  studentEmail: string;
  riskLevel: DropoutRiskLevel;
  reasons: string[];
  pendingDeliveries: number;
  totalEvaluableActivities: number;
  lastActivityAt: Date | null;
  lastSubmissionAt: Date | null;
  daysWithoutActivity: number | null;
  daysWithoutSubmission: number | null;
};

type Props = {
  groupId: string;
  courseIds: string[];
  students: GroupStudentSummary[];
};

function toDate(value: unknown): Date | null {
  if (!value) return null;

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  if (typeof value === "object") {
    if ("toDate" in value && typeof (value as { toDate?: unknown }).toDate === "function") {
      try {
        const date = (value as { toDate: () => Date }).toDate();
        return Number.isNaN(date.getTime()) ? null : date;
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

function formatDateTime(value: Date | null): string {
  if (!value) return "Sin registro";
  return new Intl.DateTimeFormat("es-MX", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(value);
}

function daysSince(value: Date | null, now: Date): number | null {
  if (!value) return null;
  const delta = now.getTime() - value.getTime();
  if (delta <= 0) return 0;
  return Math.floor(delta / MS_PER_DAY);
}

function chooseLatestDate(a: Date | null, b: Date | null): Date | null {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

export function DropoutRiskTab({ groupId, courseIds, students }: Props) {
  const [rows, setRows] = useState<RiskRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const normalizedCourseIds = useMemo(
    () => Array.from(new Set(courseIds.map((id) => id.trim()).filter(Boolean))),
    [courseIds],
  );

  const loadRiskRows = useCallback(async () => {
    setLoading(true);
    setErrorMessage(null);
    try {
      const studentList = students.filter((student) => student.id.trim().length > 0);
      if (studentList.length === 0) {
        setRows([]);
        return;
      }

      const studentIds = new Set(studentList.map((student) => student.id));

      const [allSubmissions, enrollmentsSnap] = await Promise.all([
        getAllSubmissions(groupId),
        getDocs(query(collection(db, "studentEnrollments"), where("groupId", "==", groupId))),
      ]);

      const evaluableClassIds = new Set<string>();
      await Promise.all(
        normalizedCourseIds.map(async (courseId) => {
          const lessonsSnap = await getDocs(collection(db, "courses", courseId, "lessons"));
          await Promise.all(
            lessonsSnap.docs.map(async (lessonDoc) => {
              const classesSnap = await getDocs(
                collection(db, "courses", courseId, "lessons", lessonDoc.id, "classes"),
              );
              classesSnap.docs.forEach((classDoc) => {
                const classData = classDoc.data() as { type?: string; hasAssignment?: boolean };
                const isEvaluable = classData.type === "quiz" || classData.hasAssignment === true;
                if (!isEvaluable) return;
                evaluableClassIds.add(classDoc.id);
              });
            }),
          );
        }),
      );

      const totalEvaluableActivities = evaluableClassIds.size;
      const lastSubmissionByStudent = new Map<string, Date>();
      const submittedEvaluableByStudent = new Map<string, Set<string>>();

      allSubmissions.forEach((submission) => {
        const studentId = (submission.studentId ?? "").trim();
        if (!studentId || !studentIds.has(studentId)) return;

        const submittedAt = submission.submittedAt ?? null;
        if (submittedAt instanceof Date && !Number.isNaN(submittedAt.getTime())) {
          const previous = lastSubmissionByStudent.get(studentId);
          if (!previous || submittedAt > previous) {
            lastSubmissionByStudent.set(studentId, submittedAt);
          }
        }

        const classId = (submission.classDocId ?? submission.classId ?? "").trim();
        if (!classId || !evaluableClassIds.has(classId)) return;
        const current = submittedEvaluableByStudent.get(studentId) ?? new Set<string>();
        current.add(classId);
        submittedEvaluableByStudent.set(studentId, current);
      });

      const enrollmentEntries: Array<{ studentId: string; enrollmentId: string }> = [];
      enrollmentsSnap.docs.forEach((docSnap) => {
        const data = docSnap.data() as { studentId?: unknown };
        const fromField = typeof data.studentId === "string" ? data.studentId.trim() : "";
        const fromId =
          docSnap.id.includes("_") && docSnap.id.split("_").length > 1
            ? docSnap.id.split("_").slice(1).join("_").trim()
            : "";
        const studentId = fromField || fromId;
        if (!studentId || !studentIds.has(studentId)) return;
        enrollmentEntries.push({ studentId, enrollmentId: docSnap.id });
      });

      const lastProgressByStudent = new Map<string, Date>();
      await Promise.all(
        enrollmentEntries.map(async ({ studentId, enrollmentId }) => {
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
          const latestProgressAt =
            toDate(progressData.lastUpdated) ??
            toDate(progressData.completedAt) ??
            toDate(progressData.updatedAt);
          if (!latestProgressAt) return;
          const previous = lastProgressByStudent.get(studentId);
          if (!previous || latestProgressAt > previous) {
            lastProgressByStudent.set(studentId, latestProgressAt);
          }
        }),
      );

      const now = new Date();
      const computedRows: RiskRow[] = studentList.map((student) => {
        const submittedSet = submittedEvaluableByStudent.get(student.id) ?? new Set<string>();
        const pendingDeliveries = Math.max(totalEvaluableActivities - submittedSet.size, 0);
        const lastSubmissionAt = lastSubmissionByStudent.get(student.id) ?? null;
        const lastProgressAt = lastProgressByStudent.get(student.id) ?? null;
        const lastActivityAt = chooseLatestDate(lastProgressAt, lastSubmissionAt);
        const daysWithoutActivity = daysSince(lastActivityAt, now);
        const daysWithoutSubmission = daysSince(lastSubmissionAt, now);
        const enrollmentAgeDays = daysSince(student.enrolledAt ?? null, now);
        const inGracePeriod =
          enrollmentAgeDays !== null && enrollmentAgeDays < INACTIVITY_DAYS_THRESHOLD;

        const inactivityRisk =
          totalEvaluableActivities > 0 &&
          !inGracePeriod &&
          (daysWithoutActivity === null || daysWithoutActivity >= INACTIVITY_DAYS_THRESHOLD);
        const pendingRisk =
          totalEvaluableActivities > 0 &&
          pendingDeliveries >= PENDING_DELIVERIES_THRESHOLD;

        const reasons: string[] = [];
        if (inactivityRisk) {
          reasons.push(
            daysWithoutActivity === null
              ? "Sin actividad registrada"
              : `Sin actividad ${daysWithoutActivity} día${daysWithoutActivity === 1 ? "" : "s"}`,
          );
        }
        if (pendingRisk) {
          reasons.push(
            `${pendingDeliveries} entrega${pendingDeliveries === 1 ? "" : "s"} pendiente${
              pendingDeliveries === 1 ? "" : "s"
            }`,
          );
        }

        const riskLevel: DropoutRiskLevel =
          reasons.length === 0 ? "none" : reasons.length >= 2 ? "high" : "medium";

        return {
          studentId: student.id,
          studentName: student.studentName || "Alumno",
          studentEmail: student.studentEmail || "",
          riskLevel,
          reasons,
          pendingDeliveries,
          totalEvaluableActivities,
          lastActivityAt,
          lastSubmissionAt,
          daysWithoutActivity,
          daysWithoutSubmission,
        };
      });

      const severityWeight: Record<DropoutRiskLevel, number> = {
        none: 0,
        medium: 1,
        high: 2,
      };

      const atRiskRows = computedRows
        .filter((row) => row.riskLevel !== "none")
        .sort((a, b) => {
          const severityDelta = severityWeight[b.riskLevel] - severityWeight[a.riskLevel];
          if (severityDelta !== 0) return severityDelta;
          if (b.pendingDeliveries !== a.pendingDeliveries) {
            return b.pendingDeliveries - a.pendingDeliveries;
          }
          return (b.daysWithoutActivity ?? 0) - (a.daysWithoutActivity ?? 0);
        });

      setRows(atRiskRows);
    } catch (error) {
      console.error("Error calculando riesgo de deserción:", error);
      setRows([]);
      setErrorMessage("No se pudo calcular el riesgo de deserción.");
      toast.error("No se pudo calcular el riesgo de deserción.");
    } finally {
      setLoading(false);
    }
  }, [groupId, normalizedCourseIds, students]);

  useEffect(() => {
    void loadRiskRows();
  }, [loadRiskRows]);

  const summary = useMemo(() => {
    const high = rows.filter((row) => row.riskLevel === "high").length;
    const medium = rows.filter((row) => row.riskLevel === "medium").length;
    return {
      totalRisk: rows.length,
      high,
      medium,
    };
  }, [rows]);

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Riesgo de deserción</p>
            <h3 className="text-lg font-semibold text-slate-900">Detección de alumnos en riesgo</h3>
            <p className="text-sm text-slate-600">
              Criterio actual: inactividad de {INACTIVITY_DAYS_THRESHOLD}+ días o{" "}
              {PENDING_DELIVERIES_THRESHOLD}+ entregas pendientes.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void loadRiskRows()}
            disabled={loading}
            className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60"
          >
            {loading ? "Calculando..." : "Recalcular"}
          </button>
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-3">
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
            <p className="text-lg font-semibold text-slate-900">{summary.totalRisk}</p>
          </div>
        </div>
      </div>

      {normalizedCourseIds.length === 0 ? (
        <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
          El grupo no tiene materias asignadas para calcular riesgo.
        </div>
      ) : loading ? (
        <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
          Calculando riesgo de deserción...
        </div>
      ) : errorMessage ? (
        <div className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
          {errorMessage}
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-700">
          No se detectaron alumnos en riesgo con los criterios actuales.
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm text-slate-800">
              <thead className="bg-slate-50 text-xs font-semibold text-slate-600">
                <tr>
                  <th className="px-4 py-2 text-left">Alumno</th>
                  <th className="px-4 py-2 text-left">Riesgo</th>
                  <th className="px-4 py-2 text-left">Pendientes</th>
                  <th className="px-4 py-2 text-left">Sin actividad</th>
                  <th className="px-4 py-2 text-left">Última actividad</th>
                  <th className="px-4 py-2 text-left">Última entrega</th>
                  <th className="px-4 py-2 text-left">Motivo</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((row) => (
                  <tr key={row.studentId}>
                    <td className="px-4 py-3">
                      <p className="font-medium text-slate-900">{row.studentName}</p>
                      <p className="text-xs text-slate-500">{row.studentEmail || "Sin correo"}</p>
                    </td>
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
                      {row.pendingDeliveries}/{row.totalEvaluableActivities}
                    </td>
                    <td className="px-4 py-3 text-slate-700">
                      {row.daysWithoutActivity === null
                        ? "Sin registro"
                        : `${row.daysWithoutActivity} día${row.daysWithoutActivity === 1 ? "" : "s"}`}
                    </td>
                    <td className="px-4 py-3 text-slate-700">{formatDateTime(row.lastActivityAt)}</td>
                    <td className="px-4 py-3 text-slate-700">
                      {row.lastSubmissionAt
                        ? `${formatDateTime(row.lastSubmissionAt)}${
                            row.daysWithoutSubmission === null
                              ? ""
                              : ` (${row.daysWithoutSubmission} día${
                                  row.daysWithoutSubmission === 1 ? "" : "s"
                                })`
                          }`
                        : "Sin entregas"}
                    </td>
                    <td className="px-4 py-3 text-slate-700">
                      {row.reasons.map((reason, idx) => (
                        <p key={`${row.studentId}-${idx}`} className="text-xs">
                          {reason}
                        </p>
                      ))}
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
