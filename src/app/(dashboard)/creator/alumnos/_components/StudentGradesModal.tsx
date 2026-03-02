"use client";

import { useEffect, useMemo, useState } from "react";
import { collection, getDocs, query, where } from "firebase/firestore";
import toast from "react-hot-toast";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { db } from "@/lib/firebase/firestore";

type Props = {
  studentId: string;
  studentName: string;
  studentEmail: string;
  isOpen: boolean;
  onClose: () => void;
};

type CourseClosure = {
  status?: "open" | "closed";
  finalGrade?: number;
  autoGrade?: number | null;
  pendingUngradedCount?: number;
  closedAt?: unknown;
  updatedAt?: unknown;
};

type GradeRow = {
  id: string;
  groupId: string;
  courseId: string;
  groupName: string;
  courseName: string;
  status: "open" | "closed";
  finalGrade: number | null;
  autoGrade: number | null;
  pendingUngradedCount: number | null;
  closedAt: Date | null;
  updatedAt: Date | null;
};

const toDateOrNull = (value: unknown): Date | null => {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value === "object" && value !== null && "toDate" in value) {
    const fn = (value as { toDate?: () => Date }).toDate;
    if (typeof fn === "function") {
      try {
        return fn();
      } catch {
        return null;
      }
    }
  }
  return null;
};

const toNumberOrNull = (value: unknown): number | null => {
  if (typeof value !== "number") return null;
  return Number.isFinite(value) ? value : null;
};

const formatDate = (value: Date | null): string => {
  if (!value) return "—";
  return new Intl.DateTimeFormat("es-MX", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(value);
};

const buildRowKey = (groupId: string, groupName: string, courseId: string, courseName: string) => {
  const g = groupId.trim() || groupName.trim() || "sin-grupo";
  const c = courseId.trim() || courseName.trim() || "sin-materia";
  return `${g}::${c}`;
};

const getRowTs = (row: GradeRow): number =>
  Math.max(row.closedAt?.getTime() ?? 0, row.updatedAt?.getTime() ?? 0);

export function StudentGradesModal({
  studentId,
  studentName,
  studentEmail,
  isOpen,
  onClose,
}: Props) {
  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState<GradeRow[]>([]);

  useEffect(() => {
    if (!isOpen || !studentId) return;
    let active = true;

    const loadGrades = async () => {
      setLoading(true);
      try {
        const enrollmentsSnap = await getDocs(
          query(collection(db, "studentEnrollments"), where("studentId", "==", studentId)),
        );

        const closureRows = new Map<string, GradeRow>();
        const enrollmentGroupNames = new Map<string, string>();
        const enrollmentCourseFallbackByGroup = new Map<string, string>();
        const groupIds = new Set<string>();

        const upsertClosureRow = (row: GradeRow) => {
          const previous = closureRows.get(row.id);
          if (!previous || getRowTs(row) >= getRowTs(previous)) {
            closureRows.set(row.id, row);
          }
        };

        enrollmentsSnap.docs.forEach((docSnap) => {
          const data = docSnap.data() as {
            groupId?: string;
            groupName?: string;
            courseName?: string;
            courseClosures?: Record<string, unknown>;
          };
          const groupId = (data.groupId ?? "").trim();
          const groupName = (data.groupName ?? "").trim() || "Sin grupo";
          const fallbackCourseName = (data.courseName ?? "").trim();
          if (groupId) {
            groupIds.add(groupId);
            enrollmentGroupNames.set(groupId, groupName);
            if (fallbackCourseName) {
              enrollmentCourseFallbackByGroup.set(groupId, fallbackCourseName);
            }
          }

          const closures = (data.courseClosures ?? {}) as Record<string, unknown>;
          Object.entries(closures).forEach(([courseIdRaw, closureRaw]) => {
            const closure = closureRaw as CourseClosure;
            if (!closure || typeof closure !== "object") return;

            const courseId = courseIdRaw.trim();
            const closureCourseNameRaw = (closure as { courseName?: unknown }).courseName;
            const closureCourseName =
              typeof closureCourseNameRaw === "string" ? closureCourseNameRaw.trim() : "";
            const courseName =
              closureCourseName ||
              fallbackCourseName ||
              courseId ||
              "Sin materia";
            const finalGrade = toNumberOrNull(closure.finalGrade);
            const autoGrade = toNumberOrNull(closure.autoGrade);
            const closedAt = toDateOrNull(closure.closedAt);
            const updatedAt = toDateOrNull(closure.updatedAt);
            const key = buildRowKey(groupId, groupName, courseId, courseName);

            upsertClosureRow({
              id: key,
              groupId,
              courseId,
              groupName,
              courseName,
              status: closure.status === "closed" ? "closed" : "open",
              finalGrade,
              autoGrade,
              pendingUngradedCount:
                typeof closure.pendingUngradedCount === "number"
                  ? closure.pendingUngradedCount
                  : null,
              closedAt,
              updatedAt,
            });
          });
        });

        type SubmissionAgg = {
          id: string;
          groupId: string;
          groupName: string;
          courseId: string;
          courseName: string;
          total: number;
          graded: number;
          numericCount: number;
          numericSum: number;
          latestAt: Date | null;
        };

        const submissionAggByKey = new Map<string, SubmissionAgg>();
        await Promise.all(
          Array.from(groupIds).map(async (groupId) => {
            const groupName = enrollmentGroupNames.get(groupId) ?? "Sin grupo";
            const fallbackCourseName =
              enrollmentCourseFallbackByGroup.get(groupId) ?? "Sin materia";
            const submissionsSnap = await getDocs(
              query(
                collection(db, "groups", groupId, "submissions"),
                where("studentId", "==", studentId),
              ),
            );

            submissionsSnap.docs.forEach((submissionDoc) => {
              const data = submissionDoc.data() as {
                courseId?: string;
                courseTitle?: string;
                status?: string;
                grade?: number;
                submittedAt?: unknown;
                gradedAt?: unknown;
              };
              const courseId = (data.courseId ?? "").trim();
              const courseTitle = (data.courseTitle ?? "").trim();
              const courseName =
                courseTitle ||
                (courseId ? courseId : fallbackCourseName) ||
                "Sin materia";
              const key = buildRowKey(groupId, groupName, courseId, courseName);

              const current =
                submissionAggByKey.get(key) ??
                {
                  id: key,
                  groupId,
                  groupName,
                  courseId,
                  courseName,
                  total: 0,
                  graded: 0,
                  numericCount: 0,
                  numericSum: 0,
                  latestAt: null,
                };

              current.total += 1;
              const isGraded = data.status === "graded" || typeof data.grade === "number";
              if (isGraded) current.graded += 1;
              if (typeof data.grade === "number" && Number.isFinite(data.grade)) {
                current.numericCount += 1;
                current.numericSum += data.grade;
              }
              const candidateDate =
                toDateOrNull(data.gradedAt) ?? toDateOrNull(data.submittedAt);
              if (candidateDate && (!current.latestAt || candidateDate > current.latestAt)) {
                current.latestAt = candidateDate;
              }

              submissionAggByKey.set(key, current);
            });
          }),
        );

        const mergedRows = new Map<string, GradeRow>();

        submissionAggByKey.forEach((agg) => {
          mergedRows.set(agg.id, {
            id: agg.id,
            groupId: agg.groupId,
            courseId: agg.courseId,
            groupName: agg.groupName,
            courseName: agg.courseName,
            status: "open",
            finalGrade: null,
            autoGrade: agg.numericCount > 0 ? agg.numericSum / agg.numericCount : null,
            pendingUngradedCount: Math.max(agg.total - agg.graded, 0),
            closedAt: null,
            updatedAt: agg.latestAt,
          });
        });

        closureRows.forEach((closureRow, key) => {
          const current = mergedRows.get(key);
          if (!current) {
            mergedRows.set(key, closureRow);
            return;
          }

          mergedRows.set(key, {
            ...current,
            status: closureRow.status,
            finalGrade: closureRow.finalGrade ?? current.finalGrade,
            autoGrade: closureRow.autoGrade ?? current.autoGrade,
            pendingUngradedCount:
              closureRow.pendingUngradedCount ?? current.pendingUngradedCount,
            closedAt: closureRow.closedAt ?? current.closedAt,
            updatedAt: closureRow.updatedAt ?? current.updatedAt,
          });
        });

        const nextRows = Array.from(mergedRows.values()).sort(
          (a, b) => getRowTs(b) - getRowTs(a),
        );

        if (!active) return;
        setRows(nextRows);
      } catch (err) {
        console.error("Error cargando kardex:", err);
        if (active) {
          setRows([]);
          toast.error("No se pudo cargar el kardex de calificaciones");
        }
      } finally {
        if (active) setLoading(false);
      }
    };

    loadGrades();
    return () => {
      active = false;
    };
  }, [isOpen, studentId]);

  const summary = useMemo(() => {
    const closed = rows.filter((row) => row.status === "closed");
    const graded = closed.filter((row) => typeof row.finalGrade === "number");
    const avg =
      graded.length > 0
        ? graded.reduce((acc, row) => acc + (row.finalGrade ?? 0), 0) / graded.length
        : null;
    return {
      total: rows.length,
      closed: closed.length,
      avg,
    };
  }, [rows]);

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="w-full max-w-5xl p-0">
        <div className="border-b border-slate-200 px-6 py-4">
          <DialogHeader className="mb-1">
            <DialogTitle>Kardex de calificaciones</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-slate-600">
            {studentName} · {studentEmail}
          </p>
        </div>

        <div className="space-y-4 p-6">
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
              <p className="text-xs uppercase tracking-wide text-slate-500">Materias</p>
              <p className="text-lg font-semibold text-slate-900">{summary.total}</p>
            </div>
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
              <p className="text-xs uppercase tracking-wide text-slate-500">Cerradas</p>
              <p className="text-lg font-semibold text-emerald-700">{summary.closed}</p>
            </div>
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
              <p className="text-xs uppercase tracking-wide text-slate-500">Promedio final</p>
              <p className="text-lg font-semibold text-blue-700">
                {summary.avg === null ? "—" : summary.avg.toFixed(1)}
              </p>
            </div>
          </div>

          {loading ? (
            <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-6 text-sm text-slate-600">
              Cargando calificaciones...
            </div>
          ) : rows.length === 0 ? (
            <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-6 text-sm text-slate-600">
              No hay calificaciones registradas para este alumno.
            </div>
          ) : (
            <div className="max-h-[52vh] overflow-auto rounded-lg border border-slate-200">
              <table className="min-w-full text-sm text-slate-800">
                <thead className="bg-slate-50 text-xs font-semibold text-slate-600">
                  <tr className="border-b border-slate-200">
                    <th className="px-4 py-2 text-left">Grupo</th>
                    <th className="px-4 py-2 text-left">Materia</th>
                    <th className="px-4 py-2 text-left">Estado</th>
                    <th className="px-4 py-2 text-left">Final</th>
                    <th className="px-4 py-2 text-left">Auto</th>
                    <th className="px-4 py-2 text-left">Pendientes</th>
                    <th className="px-4 py-2 text-left">Actualizado</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {rows.map((row) => (
                    <tr key={row.id}>
                      <td className="px-4 py-3">{row.groupName}</td>
                      <td className="px-4 py-3">{row.courseName}</td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ${
                            row.status === "closed"
                              ? "bg-emerald-100 text-emerald-700"
                              : "bg-amber-100 text-amber-700"
                          }`}
                        >
                          {row.status === "closed" ? "Cerrada" : "Abierta"}
                        </span>
                      </td>
                      <td className="px-4 py-3 font-semibold text-slate-900">
                        {row.finalGrade === null ? "—" : row.finalGrade.toFixed(1)}
                      </td>
                      <td className="px-4 py-3 text-slate-700">
                        {row.autoGrade === null ? "—" : row.autoGrade.toFixed(1)}
                      </td>
                      <td className="px-4 py-3 text-slate-700">
                        {row.pendingUngradedCount === null ? "—" : row.pendingUngradedCount}
                      </td>
                      <td className="px-4 py-3 text-slate-600">
                        {formatDate(row.closedAt ?? row.updatedAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
