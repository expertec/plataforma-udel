"use client";

import { useEffect, useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";
import { collection, doc, getDoc, getDocs, orderBy, query } from "firebase/firestore";
import { db } from "@/lib/firebase/firestore";
import { getAllSubmissions, Submission } from "@/lib/firebase/submissions-service";
import { SubmissionsModal } from "./SubmissionsModal";

type EntregasTabProps = {
  groupId: string;
  courseIds: string[];
  studentsCount: number;
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

export function EntregasTab({ groupId, courseIds, studentsCount }: EntregasTabProps) {
  const [assignments, setAssignments] = useState<AssignmentRow[]>([]);
  const [loading, setLoading] = useState(true);
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
        const studentsSnap = await getDocs(collection(db, "groups", groupId, "students"));
        const studentIds = new Set(studentsSnap.docs.map((d) => d.id));

        const allClasses: Array<{
          lessonId: string;
          classId: string;
          title: string;
          classType: string;
          courseId: string;
          forumEnabled?: boolean;
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
          const snap = await getDocs(
            collection(
              db,
              "courses",
              cls.courseId,
              "lessons",
              cls.lessonId,
              "classes",
              cls.classId,
              "forums",
            ),
          );
          snap.docs.forEach((d) => {
            const data = d.data() as any;
            const authorId = data.authorId ?? "";
            if (authorId && studentIds.size && !studentIds.has(authorId)) return;
            forumSubs.push({
              id: d.id,
              classId: cls.classId,
              classDocId: cls.classId,
              courseId: cls.courseId,
              className: cls.title,
              classType: "forum",
              studentId: authorId,
              studentName: data.authorName ?? "",
              submittedAt: data.createdAt?.toDate?.() ?? null,
              fileUrl: data.mediaUrl ?? "",
              content: data.text ?? "",
              status: "pending",
              grade: undefined,
              feedback: "",
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
      });
  }, [assignments]);

  const [openLessonKey, setOpenLessonKey] = useState<string | null>(null);

  useEffect(() => {
    if (!openLessonKey && lessonGroups.length > 0) {
      setOpenLessonKey(lessonGroups[0].key);
    }
  }, [lessonGroups, openLessonKey]);

  if (loading) {
    return (
      <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
        Cargando entregas...
      </div>
    );
  }

  return (
    <div className="space-y-4">
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
                <button
                  type="button"
                  className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-slate-50"
                  onClick={() => setOpenLessonKey(isOpen ? null : lesson.key)}
                >
                  <div className="flex flex-col">
                    <span className="text-sm font-semibold text-slate-900">
                      {lesson.lessonTitle}
                    </span>
                    <span className="text-xs text-slate-500">
                      {lesson.courseTitle ? `${lesson.courseTitle} • ` : ""}
                      {activitiesCount} {activitiesCount === 1 ? "actividad" : "actividades"}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 text-xs text-slate-500">
                    <span>Ver detalles</span>
                    <ChevronDown
                      size={18}
                      className={`transform transition-transform ${isOpen ? "rotate-180" : "rotate-0"}`}
                    />
                  </div>
                </button>

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
                              Revisar
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
          isOpen
          onClose={() => setSelected(null)}
        />
      ) : null}
    </div>
  );
}
