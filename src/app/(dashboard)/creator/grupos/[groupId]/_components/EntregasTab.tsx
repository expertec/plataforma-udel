"use client";

import { useEffect, useMemo, useState } from "react";
import { ChevronDown, Download } from "lucide-react";
import { collection, doc, getDoc, getDocs, orderBy, query } from "firebase/firestore";
import toast from "react-hot-toast";
import {
  getAllSubmissions,
  hasNumericSubmissionGrade,
  Submission,
  shouldPreferIncomingSubmission,
} from "@/lib/firebase/submissions-service";
import { getForumPosts } from "@/lib/firebase/forum-service";
import { getGroupStudents } from "@/lib/firebase/groups-service";
import { db } from "@/lib/firebase/firestore";
import { SubmissionsModal } from "./SubmissionsModal";

type EntregasTabProps = {
  groupId: string;
  courseIds: string[];
  studentsCount: number;
  isInPerson?: boolean;
  readOnly?: boolean;
};

type AssignmentRow = {
  classId: string;
  courseId: string;
  lessonId: string;
  className: string;
  classType: string;
  lessonTitle: string;
  courseTitle?: string;
  lessonOrder?: number;
  classOrder?: number;
  submissions: Submission[];
  avgGrade: number | null;
};

type LessonGroup = {
  key: string;
  lessonId: string;
  courseId: string;
  lessonTitle: string;
  courseTitle?: string;
  lessonOrder?: number;
  assignments: AssignmentRow[];
};

type GroupStudent = {
  id: string;
  name: string;
};

const drawRoundRect = (
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) => {
  ctx.beginPath();
  if (typeof ctx.roundRect === "function") {
    ctx.roundRect(x, y, width, height, radius);
    return;
  }
  const r = Math.min(radius, width / 2, height / 2);
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
};

const wrapTextLines = (
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  maxLines: number,
) => {
  const normalized = text.replace(/\s+/g, " ").trim() || "Sin nombre";
  const words = normalized.split(" ");
  const lines: string[] = [];
  let current = "";

  words.forEach((word) => {
    const candidate = current ? `${current} ${word}` : word;
    if (ctx.measureText(candidate).width <= maxWidth) {
      current = candidate;
      return;
    }
    if (current) lines.push(current);
    current = word;
  });

  if (current) lines.push(current);
  if (lines.length <= maxLines) return lines;

  const trimmed = lines.slice(0, maxLines);
  let last = trimmed[maxLines - 1];
  while (last.length > 0 && ctx.measureText(`${last}…`).width > maxWidth) {
    last = last.slice(0, -1);
  }
  trimmed[maxLines - 1] = `${last || "…"}${last.endsWith("…") ? "" : "…"}`;
  return trimmed;
};

const formatWeekExportName = (value: string) =>
  value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

export function EntregasTab({
  groupId,
  courseIds,
  studentsCount,
  isInPerson = false,
  readOnly = false,
}: EntregasTabProps) {
  const [assignments, setAssignments] = useState<AssignmentRow[]>([]);
  const [students, setStudents] = useState<GroupStudent[]>([]);
  const [loading, setLoading] = useState(true);
  const [exportingLessonKey, setExportingLessonKey] = useState<string | null>(null);
  const [selected, setSelected] = useState<{
    classId: string;
    className: string;
    courseId: string;
    lessonId: string;
    classType: string;
  } | null>(null);

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      try {
        const groupStudents = (await getGroupStudents(groupId))
          .map((student) => ({
            id: student.id,
            name: student.studentName ?? "",
          }))
          .sort((a, b) => a.name.localeCompare(b.name, "es-MX"));
        setStudents(groupStudents);
        const studentIds = new Set(groupStudents.map((student) => student.id));

        const allClasses: Array<{
          lessonId: string;
          classId: string;
          title: string;
          classType: string;
          courseId: string;
          forumEnabled?: boolean;
          lessonTitle: string;
          lessonOrder?: number;
          classOrder?: number;
        }> = [];
        const courseTitles = new Map<string, string>();

        for (const cid of courseIds) {
          const courseDoc = await getDoc(doc(db, "courses", cid));
          const courseTitle = courseDoc.exists() ? (courseDoc.data()?.title ?? "Curso") : "Curso";
          courseTitles.set(cid, courseTitle);

          const lessonsSnap = await getDocs(
            query(collection(db, "courses", cid, "lessons"), orderBy("order", "asc")),
          );
          const classesPromises = lessonsSnap.docs.map(async (lessonDoc) => {
            const lessonData = lessonDoc.data() as { title?: string; order?: number };
            const lessonTitle = lessonData?.title ?? "Lección";
            const lessonOrder = lessonData?.order ?? undefined;
            const classesSnap = await getDocs(
              query(
                collection(db, "courses", cid, "lessons", lessonDoc.id, "classes"),
                orderBy("order", "asc"),
              ),
            );
            return classesSnap.docs
              .map((docSnap) => {
                const data = docSnap.data() as {
                  type?: string;
                  title?: string;
                  hasAssignment?: boolean;
                  assignmentTemplateUrl?: string;
                  forumEnabled?: boolean;
                  order?: number;
                };
                return {
                  id: docSnap.id,
                  type: data.type,
                  title: data.title,
                  hasAssignment: data.hasAssignment ?? false,
                  forumEnabled: data.forumEnabled ?? false,
                  classOrder: data.order ?? undefined,
                };
              })
              .filter((c) => c.type === "quiz" || c.hasAssignment === true || c.forumEnabled === true)
              .map((c) => ({
                lessonId: lessonDoc.id,
                classId: c.id,
                courseId: cid,
                title: c.title ?? "Sin título",
                classType:
                  c.type === "quiz"
                    ? "quiz"
                    : c.forumEnabled
                    ? "forum"
                    : c.hasAssignment
                    ? "assignment"
                    : "",
                lessonTitle,
                lessonOrder,
                classOrder: c.classOrder,
              }));
          });
          const classes = (await Promise.all(classesPromises)).flat();
          allClasses.push(...classes);
        }

        const allSubs: Submission[] = await getAllSubmissions(groupId);

        const forumSubs: Submission[] = [];
        for (const cls of allClasses.filter((c) => c.classType === "forum")) {
          const forumPosts = await getForumPosts(cls.courseId, cls.lessonId, cls.classId);
          forumPosts.forEach((post) => {
            const authorId = (post.authorId ?? "").trim() || post.id;
            if (authorId && studentIds.size && !studentIds.has(authorId)) return;
            forumSubs.push({
              id: post.id,
              classId: cls.classId,
              classDocId: cls.classId,
              courseId: cls.courseId,
              className: cls.title,
              classType: "forum",
              studentId: authorId,
              studentName: post.authorName ?? "",
              submittedAt: post.createdAt ?? null,
              fileUrl: post.mediaUrl ?? "",
              content: post.text ?? "",
              status:
                post.status === "graded" || typeof post.grade === "number"
                  ? "graded"
                  : "pending",
              grade: typeof post.grade === "number" ? post.grade : undefined,
              feedback: post.feedback ?? "",
              gradedAt: post.gradedAt ?? null,
              gradedById: post.gradedById ?? undefined,
              gradedByName: post.gradedByName ?? undefined,
            });
          });
        }

        const mergedSubs = [...allSubs, ...forumSubs];

        const rows: AssignmentRow[] = [];
        for (const cls of allClasses) {
          const submissions = mergedSubs.filter(
            (s) =>
              (s.classDocId ?? s.classId) === cls.classId &&
              (!s.courseId || s.courseId === cls.courseId),
          );
          const graded = submissions.filter((s) => typeof s.grade === "number");
          const avgGrade =
            graded.length > 0 ? graded.reduce((sum, s) => sum + (s.grade ?? 0), 0) / graded.length : null;
          rows.push({
            classId: cls.classId,
            courseId: cls.courseId,
            lessonId: cls.lessonId,
            className: cls.title,
            classType: cls.classType,
            lessonTitle: cls.lessonTitle,
            lessonOrder: cls.lessonOrder,
            classOrder: cls.classOrder,
            courseTitle: courseTitles.get(cls.courseId),
            submissions,
            avgGrade,
          });
        }
        setAssignments(rows);
      } catch (err) {
        console.error(err);
      } finally {
        setLoading(false);
      }
    };

    load();
  }, [courseIds, groupId]);

  const lessonGroups: LessonGroup[] = useMemo(() => {
    const map = new Map<string, LessonGroup>();
    const order: string[] = [];

    assignments.forEach((row) => {
      const key = `${row.courseId}::${row.lessonId}`;
      if (!map.has(key)) {
        map.set(key, {
          key,
          lessonId: row.lessonId,
          courseId: row.courseId,
          lessonTitle: row.lessonTitle,
          courseTitle: row.courseTitle,
          lessonOrder: row.lessonOrder,
          assignments: [],
        });
        order.push(key);
      }
      map.get(key)?.assignments.push(row);
    });

    return order
      .map((k) => map.get(k)!)
      .sort((a, b) => {
        const orderA = a.lessonOrder ?? Number.MAX_SAFE_INTEGER;
        const orderB = b.lessonOrder ?? Number.MAX_SAFE_INTEGER;
        if (orderA !== orderB) return orderA - orderB;
        return a.lessonTitle.localeCompare(b.lessonTitle);
      })
      .map((lesson) => ({
        ...lesson,
        assignments: [...lesson.assignments].sort((a, b) => {
          const orderA = a.classOrder ?? Number.MAX_SAFE_INTEGER;
          const orderB = b.classOrder ?? Number.MAX_SAFE_INTEGER;
          if (orderA !== orderB) return orderA - orderB;
          return a.className.localeCompare(b.className, "es-MX");
        }),
      }));
  }, [assignments]);

  const [openLessonKey, setOpenLessonKey] = useState<string | null>(null);

  useEffect(() => {
    if (!openLessonKey && lessonGroups.length > 0) {
      setOpenLessonKey(lessonGroups[0].key);
    }
  }, [lessonGroups, openLessonKey]);

  const downloadWeeklyGradesImage = async (lesson: LessonGroup) => {
    if (students.length === 0) {
      toast.error("No hay alumnos para exportar.");
      return;
    }
    if (lesson.assignments.length === 0) {
      toast.error("Esta semana no tiene actividades evaluables.");
      return;
    }

    setExportingLessonKey(lesson.key);
    try {
      const latestByActivityAndStudent = new Map<string, Submission>();
      lesson.assignments.forEach((assignment) => {
        assignment.submissions.forEach((submission) => {
          const studentId = submission.studentId?.trim();
          if (!studentId) return;
          const mapKey = `${assignment.classId}::${studentId}`;
          const current = latestByActivityAndStudent.get(mapKey);
          if (!current || shouldPreferIncomingSubmission(current, submission)) {
            latestByActivityAndStudent.set(mapKey, submission);
          }
        });
      });

      const matrixRows = students.map((student) => {
        const grades = lesson.assignments.map((assignment) => {
          const submission = latestByActivityAndStudent.get(`${assignment.classId}::${student.id}`);
          const numericGrade = submission && hasNumericSubmissionGrade(submission) ? submission.grade : null;
          const label = !submission ? "—" : numericGrade !== null ? numericGrade.toFixed(1) : "Pend.";
          return { label, numericGrade };
        });
        const total = grades.reduce((acc, item) => acc + (item.numericGrade ?? 0), 0);
        const gradedCount = grades.filter((item) => typeof item.numericGrade === "number").length;
        return {
          studentName: student.name || "Sin nombre",
          grades,
          total,
          gradedCount,
        };
      });

      const canvas = document.createElement("canvas");
      const marginX = 44;
      const studentColumnWidth = 360;
      const activityColumnWidth = Math.max(118, Math.min(176, Math.floor(520 / lesson.assignments.length)));
      const totalColumnWidth = 132;
      const tableWidth = studentColumnWidth + lesson.assignments.length * activityColumnWidth + totalColumnWidth;
      const width = Math.max(1080, tableWidth + marginX * 2);
      const contentWidth = width - marginX * 2;
      const headerHeight = 166;
      const tableHeaderHeight = 64;
      const rowHeight = 86;
      const tableContainerHeight = tableHeaderHeight + matrixRows.length * rowHeight + 26;
      const height = headerHeight + tableContainerHeight + 36;

      canvas.width = width;
      canvas.height = height;

      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("No se pudo crear el lienzo");

      ctx.fillStyle = "#f8f4f2";
      ctx.fillRect(0, 0, width, height);

      const headerGradient = ctx.createLinearGradient(0, 0, width, headerHeight);
      headerGradient.addColorStop(0, "#5d1115");
      headerGradient.addColorStop(0.55, "#7b241d");
      headerGradient.addColorStop(1, "#8f2d1c");
      ctx.fillStyle = headerGradient;
      ctx.fillRect(0, 0, width, headerHeight);

      ctx.fillStyle = "#ffffff";
      ctx.font = "700 38px Arial, sans-serif";
      ctx.fillText("Resumen semanal de calificaciones", marginX, 72);

      ctx.font = "500 20px Arial, sans-serif";
      ctx.fillStyle = "rgba(255, 255, 255, 0.92)";
      const subtitle = `${lesson.courseTitle ?? "Materia"} • ${lesson.lessonTitle}`;
      wrapTextLines(ctx, subtitle, contentWidth, 2).forEach((line, index) => {
        ctx.fillText(line, marginX, 110 + index * 26);
      });

      const tableTop = headerHeight - 8;
      ctx.fillStyle = "#ffffff";
      drawRoundRect(ctx, marginX, tableTop, tableWidth, tableContainerHeight, 28);
      ctx.fill();
      ctx.strokeStyle = "#eadfd8";
      ctx.lineWidth = 1;
      ctx.stroke();

      const startX = marginX + 18;
      const columns = [
        { label: "Alumno", x: startX, width: studentColumnWidth },
        ...lesson.assignments.map((assignment, index) => ({
          label: assignment.className,
          x: startX + studentColumnWidth + index * activityColumnWidth,
          width: activityColumnWidth,
        })),
        {
          label: "Total semana",
          x: startX + studentColumnWidth + lesson.assignments.length * activityColumnWidth,
          width: totalColumnWidth,
        },
      ];

      ctx.fillStyle = "#f4ede8";
      drawRoundRect(ctx, marginX + 10, tableTop + 10, tableWidth - 20, tableHeaderHeight, 18);
      ctx.fill();

      ctx.font = "700 15px Arial, sans-serif";
      ctx.fillStyle = "#5b463f";
      columns.forEach((column, index) => {
        if (index === 0) {
          ctx.textAlign = "left";
          ctx.fillText(column.label, column.x, tableTop + 44);
          return;
        }
        const titleLines = wrapTextLines(ctx, column.label, column.width - 16, 2);
        ctx.textAlign = "center";
        titleLines.forEach((line, lineIndex) => {
          ctx.fillText(line, column.x + column.width / 2, tableTop + 30 + lineIndex * 16);
        });
      });

      matrixRows.forEach((row, rowIndex) => {
        const rowY = tableTop + tableHeaderHeight + rowIndex * rowHeight + 10;
        ctx.fillStyle = rowIndex % 2 === 0 ? "#ffffff" : "#fcf8f5";
        ctx.fillRect(marginX + 10, rowY, tableWidth - 20, rowHeight);

        ctx.strokeStyle = "#efe4de";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(marginX + 10, rowY + rowHeight);
        ctx.lineTo(marginX + tableWidth - 10, rowY + rowHeight);
        ctx.stroke();

        ctx.fillStyle = "#231815";
        ctx.font = "600 17px Arial, sans-serif";
        ctx.textAlign = "left";
        wrapTextLines(ctx, row.studentName, studentColumnWidth - 24, 2).forEach((line, lineIndex) => {
          ctx.fillText(line, startX, rowY + 32 + lineIndex * 20);
        });

        row.grades.forEach((grade, gradeIndex) => {
          const column = columns[gradeIndex + 1];
          ctx.textAlign = "center";
          ctx.font = "700 18px Arial, sans-serif";
          ctx.fillStyle = grade.numericGrade !== null ? "#7b241d" : grade.label === "Pend." ? "#b45309" : "#64748b";
          ctx.fillText(grade.label, column.x + column.width / 2, rowY + 48);
        });

        const totalColumn = columns[columns.length - 1];
        ctx.textAlign = "center";
        ctx.fillStyle = row.gradedCount > 0 ? "#5d1115" : "#64748b";
        ctx.font = "700 18px Arial, sans-serif";
        ctx.fillText(row.gradedCount > 0 ? row.total.toFixed(1) : "—", totalColumn.x + totalColumn.width / 2, rowY + 48);
      });

      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(
          (result) => {
            if (result) {
              resolve(result);
              return;
            }
            reject(new Error("No se pudo generar la imagen"));
          },
          "image/jpeg",
          0.95,
        );
      });

      const safeCourse = formatWeekExportName(lesson.courseTitle ?? "materia") || "materia";
      const safeLesson = formatWeekExportName(lesson.lessonTitle) || "semana";
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `calificaciones-${safeCourse}-${safeLesson}.jpg`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast.success("Imagen semanal descargada.");
    } catch (error) {
      console.error("No se pudo generar la imagen semanal:", error);
      toast.error("No se pudo descargar la imagen semanal.");
    } finally {
      setExportingLessonKey(null);
    }
  };

  if (loading) {
    return (
      <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
        Cargando entregas...
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {readOnly ? (
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
          Vista de coordinación: solo lectura de entregas y horarios.
        </div>
      ) : null}
      {lessonGroups.length === 0 ? (
        <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
          No hay entregas registradas.
        </div>
      ) : (
        <div className="space-y-3">
          {lessonGroups.map((lesson) => {
            const isOpen = openLessonKey === lesson.key;
            const activitiesCount = lesson.assignments.length;
            return (
              <div key={lesson.key} className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
                <div className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-slate-50">
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 flex-col text-left"
                    onClick={() => setOpenLessonKey(isOpen ? null : lesson.key)}
                  >
                    <span className="text-sm font-semibold text-slate-900">
                      {lesson.lessonTitle}
                    </span>
                    <span className="text-xs text-slate-500">
                      {lesson.courseTitle ? `${lesson.courseTitle} • ` : ""}
                      {activitiesCount} {activitiesCount === 1 ? "actividad" : "actividades"}
                    </span>
                  </button>
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      onClick={() => void downloadWeeklyGradesImage(lesson)}
                      disabled={exportingLessonKey === lesson.key}
                      className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:border-slate-300 disabled:opacity-60"
                    >
                      <Download size={14} />
                      <span>{exportingLessonKey === lesson.key ? "Generando..." : "Descargar imagen"}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setOpenLessonKey(isOpen ? null : lesson.key)}
                      className="flex items-center gap-3 text-xs text-slate-500"
                    >
                      <span>Ver detalles</span>
                      <ChevronDown
                        size={18}
                        className={`transform transition-transform ${isOpen ? "rotate-180" : "rotate-0"}`}
                      />
                    </button>
                  </div>
                </div>

                {isOpen ? (
                  <div className="border-t border-slate-200">
                    <div className="grid grid-cols-4 gap-3 bg-slate-50 px-4 py-2 text-xs font-semibold text-slate-600">
                      <span>Nombre de la tarea</span>
                      <span>Entregas</span>
                      <span>Promedio</span>
                      <span>Acciones</span>
                    </div>
                    <div className="divide-y divide-slate-200">
                      {lesson.assignments.map((row) => (
                        <div key={row.classId} className="grid grid-cols-4 gap-3 px-4 py-3 text-sm text-slate-800">
                          <div className="space-y-1">
                            <span className="block font-medium">{row.className}</span>
                            <span
                              className={`w-fit rounded-full px-2 py-1 text-[11px] font-semibold ${
                                row.classType === "quiz"
                                  ? "bg-amber-100 text-amber-700"
                                  : row.classType === "forum"
                                  ? "bg-purple-100 text-purple-700"
                                  : "bg-blue-100 text-blue-700"
                              }`}
                            >
                              {row.classType === "quiz" ? "Quiz" : row.classType === "forum" ? "Foro" : "Tarea"}
                            </span>
                          </div>
                          <span className="text-slate-600">
                            {row.submissions.length}/{studentsCount || "?"}
                          </span>
                          <span className="text-slate-600">
                            {row.avgGrade !== null ? row.avgGrade.toFixed(1) : "Sin calificar"}
                          </span>
                          <div>
                            <button
                              type="button"
                              onClick={() =>
                                setSelected({
                                  classId: row.classId,
                                  className: row.className,
                                  courseId: row.courseId,
                                  lessonId: row.lessonId,
                                  classType: row.classType,
                                })
                              }
                              className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-medium text-blue-600 hover:border-blue-400"
                            >
                              {readOnly ? "Ver" : "Revisar"}
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}

      {selected ? (
        <SubmissionsModal
          groupId={groupId}
          classId={selected.classId}
          className={selected.className}
          classType={selected.classType}
          lessonId={selected.lessonId}
          courseId={selected.courseId}
          isInPerson={isInPerson}
          readOnly={readOnly}
          isOpen
          onClose={() => setSelected(null)}
        />
      ) : null}
    </div>
  );
}
