"use client";

import { useEffect, useMemo, useState } from "react";
import {
  collection,
  doc,
  getDocs,
  orderBy,
  query,
  setDoc,
  writeBatch,
  where,
} from "firebase/firestore";
import toast from "react-hot-toast";
import { db } from "@/lib/firebase/firestore";
import { Submission, getAllSubmissions } from "@/lib/firebase/submissions-service";
import { UserRole, isAdminTeacherRole } from "@/lib/firebase/roles";

type CalificacionesTabProps = {
  groupId: string;
  courses: Array<{ courseId: string; courseName: string }>;
  groupTeacherId: string;
  currentUserId: string | null;
  userRole: UserRole | null;
};

type Student = { id: string; name: string };

type Task = {
  id: string;
  title: string;
};

type CourseClosureState = {
  status?: "open" | "closed";
  finalGrade?: number;
  autoGrade?: number | null;
  manualOverride?: boolean;
  pendingUngradedCount?: number;
  closedAt?: Date | null;
  closedById?: string;
  closedByName?: string;
  reopenedAt?: Date | null;
  reopenedById?: string;
  reopenedByName?: string;
  updatedAt?: Date | null;
};

type EnrollmentRecord = {
  id: string;
  courseClosures: Record<string, CourseClosureState>;
  studentName?: string;
};

type StudentCourseRow = {
  studentId: string;
  studentName: string;
  enrollmentId: string;
  autoGrade: number | null;
  pendingUngradedCount: number;
  gradedCount: number;
  totalEvaluable: number;
  closure: CourseClosureState | null;
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

const formatDate = (value?: Date | null) => {
  if (!value) return "";
  return new Intl.DateTimeFormat("es-MX", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(value);
};

export function CalificacionesTab({
  groupId,
  courses,
  groupTeacherId,
  currentUserId,
  userRole,
}: CalificacionesTabProps) {
  const [students, setStudents] = useState<Student[]>([]);
  const [tasksByCourse, setTasksByCourse] = useState<Record<string, Task[]>>({});
  const [allSubmissions, setAllSubmissions] = useState<Submission[]>([]);
  const [enrollmentByStudent, setEnrollmentByStudent] = useState<Record<string, EnrollmentRecord>>({});
  const [selectedCourseId, setSelectedCourseId] = useState<string>(courses[0]?.courseId ?? "");
  const [draftFinalGrades, setDraftFinalGrades] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [processingStudentId, setProcessingStudentId] = useState<string | null>(null);
  const [processingAll, setProcessingAll] = useState(false);

  const canManageClosures = useMemo(() => {
    if (!currentUserId) return false;
    return currentUserId === groupTeacherId || isAdminTeacherRole(userRole);
  }, [currentUserId, groupTeacherId, userRole]);

  useEffect(() => {
    if (!selectedCourseId && courses.length > 0) {
      setSelectedCourseId(courses[0].courseId);
    }
  }, [courses, selectedCourseId]);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      setLoading(true);
      try {
        const studentsSnap = await getDocs(collection(db, "groups", groupId, "students"));
        const nextStudents = studentsSnap.docs.map((d) => ({
          id: d.id,
          name: d.data().studentName ?? "",
        }));

        const submissions = await getAllSubmissions(groupId);

        const enrollmentsSnap = await getDocs(
          query(collection(db, "studentEnrollments"), where("groupId", "==", groupId)),
        );

        const enrollmentsMap: Record<string, EnrollmentRecord> = {};
        enrollmentsSnap.docs.forEach((enrollmentDoc) => {
          const data = enrollmentDoc.data() as {
            studentId?: string;
            studentName?: string;
            courseClosures?: Record<string, unknown>;
          };
          const studentId = (data.studentId ?? "").trim();
          if (!studentId) return;
          const canonicalId = `${groupId}_${studentId}`;
          const existing = enrollmentsMap[studentId];
          if (existing && existing.id === canonicalId) return;

          const rawClosures = (data.courseClosures ?? {}) as Record<string, unknown>;
          const normalizedClosures: Record<string, CourseClosureState> = {};
          Object.entries(rawClosures).forEach(([courseId, closureValue]) => {
            if (!closureValue || typeof closureValue !== "object") return;
            const closureObj = closureValue as Record<string, unknown>;
            normalizedClosures[courseId] = {
              status:
                closureObj.status === "closed" || closureObj.status === "open"
                  ? (closureObj.status as "closed" | "open")
                  : undefined,
              finalGrade:
                typeof closureObj.finalGrade === "number" && Number.isFinite(closureObj.finalGrade)
                  ? closureObj.finalGrade
                  : undefined,
              autoGrade:
                typeof closureObj.autoGrade === "number" && Number.isFinite(closureObj.autoGrade)
                  ? closureObj.autoGrade
                  : null,
              manualOverride: closureObj.manualOverride === true,
              pendingUngradedCount:
                typeof closureObj.pendingUngradedCount === "number"
                  ? closureObj.pendingUngradedCount
                  : undefined,
              closedAt: toDateOrNull(closureObj.closedAt),
              closedById: typeof closureObj.closedById === "string" ? closureObj.closedById : undefined,
              closedByName:
                typeof closureObj.closedByName === "string" ? closureObj.closedByName : undefined,
              reopenedAt: toDateOrNull(closureObj.reopenedAt),
              reopenedById:
                typeof closureObj.reopenedById === "string" ? closureObj.reopenedById : undefined,
              reopenedByName:
                typeof closureObj.reopenedByName === "string" ? closureObj.reopenedByName : undefined,
              updatedAt: toDateOrNull(closureObj.updatedAt),
            };
          });

          const record: EnrollmentRecord = {
            id: enrollmentDoc.id,
            courseClosures: normalizedClosures,
            studentName: data.studentName,
          };

          if (!existing || enrollmentDoc.id === canonicalId) {
            enrollmentsMap[studentId] = record;
          }
        });

        const courseTasksEntries = await Promise.all(
          courses.map(async (course) => {
            const lessonsSnap = await getDocs(
              query(collection(db, "courses", course.courseId, "lessons"), orderBy("order", "asc")),
            );
            const tasks: Task[] = [];
            for (const lesson of lessonsSnap.docs) {
              const classesSnap = await getDocs(
                query(
                  collection(db, "courses", course.courseId, "lessons", lesson.id, "classes"),
                  orderBy("order", "asc"),
                ),
              );
              classesSnap.forEach((cls) => {
                const data = cls.data() as { type?: string; hasAssignment?: boolean; title?: string };
                const evaluable = data.type === "quiz" || data.hasAssignment === true;
                if (!evaluable) return;
                tasks.push({
                  id: cls.id,
                  title: data.title ?? "Sin título",
                });
              });
            }
            return [course.courseId, tasks] as const;
          }),
        );

        if (cancelled) return;
        setStudents(nextStudents);
        setAllSubmissions(submissions);
        setEnrollmentByStudent(enrollmentsMap);
        setTasksByCourse(Object.fromEntries(courseTasksEntries));
      } catch (err) {
        console.error(err);
        toast.error("No se pudieron cargar las calificaciones");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    load();
    return () => {
      cancelled = true;
    };
  }, [courses, groupId]);

  const selectedCourseTasks = useMemo(() => {
    if (!selectedCourseId) return [];
    return tasksByCourse[selectedCourseId] ?? [];
  }, [selectedCourseId, tasksByCourse]);

  const rows = useMemo<StudentCourseRow[]>(() => {
    if (!selectedCourseId) return [];
    const classIdSet = new Set(selectedCourseTasks.map((t) => t.id));

    return students.map((student) => {
      const latestByClass = new Map<string, Submission>();
      allSubmissions.forEach((submission) => {
        if (submission.studentId !== student.id) return;
        if ((submission.courseId ?? "") !== selectedCourseId) return;
        const classId = (submission.classDocId ?? submission.classId ?? "").trim();
        if (!classId || !classIdSet.has(classId)) return;
        if (latestByClass.has(classId)) return;
        latestByClass.set(classId, submission);
      });

      const latestSubmissions = Array.from(latestByClass.values());
      const gradedSubmissions = latestSubmissions.filter(
        (sub) => sub.status === "graded" || typeof sub.grade === "number",
      );
      const gradedWithNumericGrade = gradedSubmissions.filter(
        (sub) => typeof sub.grade === "number",
      );
      const autoGrade =
        gradedWithNumericGrade.length > 0
          ? gradedWithNumericGrade.reduce((acc, item) => acc + (item.grade ?? 0), 0) / gradedWithNumericGrade.length
          : null;
      const pendingUngradedCount = Math.max(selectedCourseTasks.length - gradedSubmissions.length, 0);

      const enrollment = enrollmentByStudent[student.id];
      const closure = enrollment?.courseClosures?.[selectedCourseId] ?? null;

      return {
        studentId: student.id,
        studentName: student.name,
        enrollmentId: `${groupId}_${student.id}`,
        autoGrade,
        pendingUngradedCount,
        gradedCount: gradedSubmissions.length,
        totalEvaluable: selectedCourseTasks.length,
        closure,
      };
    });
  }, [allSubmissions, enrollmentByStudent, groupId, selectedCourseId, selectedCourseTasks, students]);

  const openRowsCount = useMemo(
    () => rows.filter((row) => row.closure?.status !== "closed").length,
    [rows],
  );

  const getDraftKey = (studentId: string) => `${selectedCourseId}::${studentId}`;

  const getFinalGradeInput = (row: StudentCourseRow) => {
    const key = getDraftKey(row.studentId);
    if (Object.prototype.hasOwnProperty.call(draftFinalGrades, key)) {
      return draftFinalGrades[key];
    }
    if (typeof row.closure?.finalGrade === "number") {
      return row.closure.finalGrade.toFixed(1);
    }
    if (typeof row.autoGrade === "number") {
      return row.autoGrade.toFixed(1);
    }
    return "";
  };

  const upsertLocalClosure = (
    studentId: string,
    courseId: string,
    closure: CourseClosureState,
    enrollmentId: string,
  ) => {
    setEnrollmentByStudent((prev) => {
      const current = prev[studentId] ?? { id: enrollmentId, courseClosures: {} };
      return {
        ...prev,
        [studentId]: {
          ...current,
          id: enrollmentId,
          courseClosures: {
            ...current.courseClosures,
            [courseId]: closure,
          },
        },
      };
    });
  };

  const handleCloseCourseForStudent = async (row: StudentCourseRow) => {
    if (!selectedCourseId) return;
    if (processingAll) return;
    if (!canManageClosures || !currentUserId) {
      toast.error("No tienes permisos para cerrar materias.");
      return;
    }

    const rawGrade = getFinalGradeInput(row).trim();
    const finalGrade = Number(rawGrade);
    if (!Number.isFinite(finalGrade) || finalGrade < 0 || finalGrade > 100) {
      toast.error("La calificación final debe estar entre 0 y 100.");
      return;
    }

    if (row.pendingUngradedCount > 0) {
      const confirmed = window.confirm(
        `Este alumno tiene ${row.pendingUngradedCount} actividades sin calificar. ¿Deseas cerrar de todas formas?`,
      );
      if (!confirmed) return;
    }

    setProcessingStudentId(row.studentId);
    try {
      const manualOverride =
        row.autoGrade === null ? true : Math.abs(finalGrade - row.autoGrade) > 0.01;
      const closurePayload: CourseClosureState = {
        status: "closed",
        finalGrade,
        autoGrade: row.autoGrade,
        manualOverride,
        pendingUngradedCount: row.pendingUngradedCount,
        closedAt: new Date(),
        closedById: currentUserId,
        closedByName: "Profesor",
        updatedAt: new Date(),
      };

      const closureFieldPath = `courseClosures.${selectedCourseId}`;
      const enrollmentRef = doc(db, "studentEnrollments", row.enrollmentId);
      await setDoc(
        enrollmentRef,
        {
          studentId: row.studentId,
          studentName: row.studentName,
          groupId,
          [closureFieldPath]: {
            status: closurePayload.status,
            finalGrade: closurePayload.finalGrade,
            autoGrade: closurePayload.autoGrade,
            manualOverride: closurePayload.manualOverride,
            pendingUngradedCount: closurePayload.pendingUngradedCount,
            closedAt: closurePayload.closedAt,
            closedById: closurePayload.closedById,
            closedByName: closurePayload.closedByName,
            updatedAt: closurePayload.updatedAt,
          },
        },
        { merge: true },
      );

      upsertLocalClosure(row.studentId, selectedCourseId, closurePayload, row.enrollmentId);
      toast.success(`Materia cerrada para ${row.studentName}`);
    } catch (err) {
      console.error(err);
      toast.error("No se pudo cerrar la materia para este alumno.");
    } finally {
      setProcessingStudentId(null);
    }
  };

  const handleReopenCourseForStudent = async (row: StudentCourseRow) => {
    if (!selectedCourseId) return;
    if (processingAll) return;
    if (!canManageClosures || !currentUserId) {
      toast.error("No tienes permisos para reabrir materias.");
      return;
    }

    const confirmed = window.confirm(`¿Reabrir la materia para ${row.studentName}?`);
    if (!confirmed) return;

    setProcessingStudentId(row.studentId);
    try {
      const previous = row.closure ?? null;
      const reopenPayload: CourseClosureState = {
        status: "open",
        finalGrade: previous?.finalGrade,
        autoGrade: previous?.autoGrade ?? row.autoGrade,
        manualOverride: previous?.manualOverride ?? false,
        pendingUngradedCount: row.pendingUngradedCount,
        closedAt: previous?.closedAt ?? null,
        closedById: previous?.closedById,
        closedByName: previous?.closedByName,
        reopenedAt: new Date(),
        reopenedById: currentUserId,
        reopenedByName: "Profesor",
        updatedAt: new Date(),
      };

      const closureFieldPath = `courseClosures.${selectedCourseId}`;
      const enrollmentRef = doc(db, "studentEnrollments", row.enrollmentId);
      await setDoc(
        enrollmentRef,
        {
          studentId: row.studentId,
          studentName: row.studentName,
          groupId,
          [closureFieldPath]: {
            status: reopenPayload.status,
            finalGrade: reopenPayload.finalGrade ?? null,
            autoGrade: reopenPayload.autoGrade ?? null,
            manualOverride: reopenPayload.manualOverride ?? false,
            pendingUngradedCount: reopenPayload.pendingUngradedCount,
            closedAt: reopenPayload.closedAt ?? null,
            closedById: reopenPayload.closedById ?? null,
            closedByName: reopenPayload.closedByName ?? null,
            reopenedAt: reopenPayload.reopenedAt,
            reopenedById: reopenPayload.reopenedById,
            reopenedByName: reopenPayload.reopenedByName,
            updatedAt: reopenPayload.updatedAt,
          },
        },
        { merge: true },
      );

      upsertLocalClosure(row.studentId, selectedCourseId, reopenPayload, row.enrollmentId);
      toast.success(`Materia reabierta para ${row.studentName}`);
    } catch (err) {
      console.error(err);
      toast.error("No se pudo reabrir la materia para este alumno.");
    } finally {
      setProcessingStudentId(null);
    }
  };

  const handleCloseCourseForAll = async () => {
    if (!selectedCourseId) return;
    if (!canManageClosures || !currentUserId) {
      toast.error("No tienes permisos para cerrar materias.");
      return;
    }

    const openRows = rows.filter((row) => row.closure?.status !== "closed");
    if (!openRows.length) {
      toast("Todas las materias de esta selección ya están cerradas.");
      return;
    }

    const parsedRows = openRows.map((row) => {
      const rawGrade = getFinalGradeInput(row).trim();
      const finalGrade = Number(rawGrade);
      return { row, rawGrade, finalGrade };
    });

    const invalidRows = parsedRows.filter(
      ({ rawGrade, finalGrade }) =>
        rawGrade.length === 0 || !Number.isFinite(finalGrade) || finalGrade < 0 || finalGrade > 100,
    );
    if (invalidRows.length > 0) {
      toast.error(
        `Faltan calificaciones válidas (0..100) para ${invalidRows.length} alumno(s).`,
      );
      return;
    }

    const pendingStudents = openRows.filter((row) => row.pendingUngradedCount > 0);
    const pendingTotal = pendingStudents.reduce((acc, row) => acc + row.pendingUngradedCount, 0);
    if (pendingStudents.length > 0) {
      const confirmed = window.confirm(
        `Hay ${pendingStudents.length} alumno(s) con actividades pendientes (${pendingTotal} en total). ¿Cerrar de todas formas para todos?`,
      );
      if (!confirmed) return;
    }

    const confirmedAll = window.confirm(
      `¿Cerrar la materia para ${openRows.length} alumno(s)? Esta acción ocultará la materia en su feed principal.`,
    );
    if (!confirmedAll) return;

    setProcessingAll(true);
    try {
      const now = new Date();
      const closureFieldPath = `courseClosures.${selectedCourseId}`;
      const chunkSize = 400;

      for (let i = 0; i < parsedRows.length; i += chunkSize) {
        const chunk = parsedRows.slice(i, i + chunkSize);
        const batch = writeBatch(db);
        chunk.forEach(({ row, finalGrade }) => {
          const manualOverride =
            row.autoGrade === null ? true : Math.abs(finalGrade - row.autoGrade) > 0.01;
          const enrollmentRef = doc(db, "studentEnrollments", row.enrollmentId);
          batch.set(
            enrollmentRef,
            {
              studentId: row.studentId,
              studentName: row.studentName,
              groupId,
              [closureFieldPath]: {
                status: "closed",
                finalGrade,
                autoGrade: row.autoGrade,
                manualOverride,
                pendingUngradedCount: row.pendingUngradedCount,
                closedAt: now,
                closedById: currentUserId,
                closedByName: "Profesor",
                updatedAt: now,
              },
            },
            { merge: true },
          );
        });
        await batch.commit();
      }

      setEnrollmentByStudent((prev) => {
        const next = { ...prev };
        parsedRows.forEach(({ row, finalGrade }) => {
          const manualOverride =
            row.autoGrade === null ? true : Math.abs(finalGrade - row.autoGrade) > 0.01;
          const current = next[row.studentId] ?? { id: row.enrollmentId, courseClosures: {} };
          next[row.studentId] = {
            ...current,
            id: row.enrollmentId,
            courseClosures: {
              ...current.courseClosures,
              [selectedCourseId]: {
                status: "closed",
                finalGrade,
                autoGrade: row.autoGrade,
                manualOverride,
                pendingUngradedCount: row.pendingUngradedCount,
                closedAt: now,
                closedById: currentUserId,
                closedByName: "Profesor",
                updatedAt: now,
              },
            },
          };
        });
        return next;
      });

      toast.success(`Materia cerrada para ${openRows.length} alumno(s).`);
    } catch (err) {
      console.error(err);
      toast.error("No se pudo cerrar la materia para todos.");
    } finally {
      setProcessingAll(false);
    }
  };

  if (!courses.length) {
    return (
      <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
        Este grupo no tiene materias asignadas.
      </div>
    );
  }

  if (loading) {
    return (
      <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
        Cargando calificaciones...
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">Materia</span>
          <select
            value={selectedCourseId}
            onChange={(e) => setSelectedCourseId(e.target.value)}
            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900"
          >
            {courses.map((course) => (
              <option key={course.courseId} value={course.courseId}>
                {course.courseName}
              </option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-2">
          {canManageClosures ? (
            <button
              type="button"
              onClick={handleCloseCourseForAll}
              disabled={
                processingAll ||
                processingStudentId !== null ||
                selectedCourseTasks.length === 0 ||
                rows.length === 0 ||
                openRowsCount === 0
              }
              className="rounded-lg bg-slate-900 px-3 py-2 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-60"
            >
              {processingAll ? "Cerrando..." : "Cerrar para todos"}
            </button>
          ) : null}
          <span className="text-xs text-slate-500">
            {canManageClosures
              ? "Puedes cerrar o reabrir materia por alumno."
              : "Solo lectura: no tienes permiso para cerrar/reabrir."}
          </span>
        </div>
      </div>

      {selectedCourseTasks.length === 0 ? (
        <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
          Esta materia no tiene actividades evaluables (quiz/tarea).
        </div>
      ) : (
        <div className="overflow-auto rounded-lg border border-slate-200">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 text-slate-600">
              <tr>
                <th className="px-3 py-2 text-left">Alumno</th>
                <th className="px-3 py-2 text-left">Auto</th>
                <th className="px-3 py-2 text-left">Final</th>
                <th className="px-3 py-2 text-left">Pendientes</th>
                <th className="px-3 py-2 text-left">Estado</th>
                <th className="px-3 py-2 text-left">Acciones</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.length === 0 ? (
                <tr>
                  <td className="px-3 py-4 text-center text-slate-500" colSpan={6}>
                    No hay alumnos en este grupo.
                  </td>
                </tr>
              ) : rows.map((row) => {
                const isClosed = row.closure?.status === "closed";
                const finalInput = getFinalGradeInput(row);
                const finalGradeNum = Number(finalInput);
                const invalidFinal =
                  finalInput.trim().length > 0 &&
                  (!Number.isFinite(finalGradeNum) || finalGradeNum < 0 || finalGradeNum > 100);

                return (
                  <tr key={row.studentId} className="hover:bg-slate-50">
                    <td className="px-3 py-2 text-slate-900">{row.studentName || "Sin nombre"}</td>
                    <td className="px-3 py-2 text-slate-700">
                      {typeof row.autoGrade === "number" ? row.autoGrade.toFixed(1) : "—"}
                    </td>
                    <td className="px-3 py-2">
                      <input
                        type="number"
                        min={0}
                        max={100}
                        step={0.1}
                        value={finalInput}
                        onChange={(e) => {
                          const key = getDraftKey(row.studentId);
                          setDraftFinalGrades((prev) => ({ ...prev, [key]: e.target.value }));
                        }}
                        disabled={!canManageClosures || processingAll || processingStudentId === row.studentId}
                        className={`w-28 rounded-lg border px-2 py-1 text-sm ${
                          invalidFinal ? "border-red-400" : "border-slate-300"
                        } ${!canManageClosures ? "bg-slate-100 text-slate-500" : "bg-white text-slate-900"}`}
                      />
                    </td>
                    <td className="px-3 py-2 text-slate-700">
                      {row.pendingUngradedCount} / {row.totalEvaluable}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex flex-col gap-1">
                        <span
                          className={`inline-flex w-fit rounded-full px-2 py-1 text-xs font-semibold ${
                            isClosed
                              ? "bg-emerald-100 text-emerald-700"
                              : "bg-amber-100 text-amber-700"
                          }`}
                        >
                          {isClosed ? "Cerrada" : "Abierta"}
                        </span>
                        {isClosed && row.closure?.closedAt ? (
                          <span className="text-[11px] text-slate-500">
                            Cierre: {formatDate(row.closure.closedAt)}
                          </span>
                        ) : null}
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      {isClosed ? (
                        <button
                          type="button"
                          disabled={!canManageClosures || processingAll || processingStudentId === row.studentId}
                          onClick={() => handleReopenCourseForStudent(row)}
                          className="rounded-lg border border-amber-300 px-3 py-1 text-xs font-semibold text-amber-700 hover:bg-amber-50 disabled:opacity-60"
                        >
                          {processingStudentId === row.studentId ? "Procesando..." : "Reabrir"}
                        </button>
                      ) : (
                        <button
                          type="button"
                          disabled={
                            !canManageClosures ||
                            processingAll ||
                            processingStudentId === row.studentId ||
                            finalInput.trim().length === 0 ||
                            invalidFinal
                          }
                          onClick={() => handleCloseCourseForStudent(row)}
                          className="rounded-lg bg-blue-600 px-3 py-1 text-xs font-semibold text-white hover:bg-blue-500 disabled:opacity-60"
                        >
                          {processingStudentId === row.studentId ? "Procesando..." : "Cerrar"}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
