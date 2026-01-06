"use client";

import { useEffect, useState } from "react";
import { collection, getDocs } from "firebase/firestore";
import { db } from "@/lib/firebase/firestore";
import { getSubmissionsByClass, getAllSubmissions, Submission } from "@/lib/firebase/submissions-service";
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
  submissions: Submission[];
  avgGrade: number | null;
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
        for (const cid of courseIds) {
          const lessonsSnap = await getDocs(collection(db, "courses", cid, "lessons"));
          const classesPromises = lessonsSnap.docs.map(async (lessonDoc) => {
            const classesSnap = await getDocs(
              collection(db, "courses", cid, "lessons", lessonDoc.id, "classes"),
            );
            return classesSnap.docs
              .map((docSnap) => {
                const data = docSnap.data() as {
                  type?: string;
                  title?: string;
                  hasAssignment?: boolean;
                  assignmentTemplateUrl?: string;
                  forumEnabled?: boolean;
                };
                return {
                  id: docSnap.id,
                  type: data.type,
                  title: data.title,
                  hasAssignment: data.hasAssignment ?? false,
                  forumEnabled: data.forumEnabled ?? false,
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

  if (loading) {
    return (
      <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
        Cargando entregas...
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {assignments.length === 0 ? (
        <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
          No hay entregas registradas.
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
          <div className="grid grid-cols-4 gap-3 border-b border-slate-200 bg-slate-50 px-4 py-2 text-xs font-semibold text-slate-600">
            <span>Nombre de la tarea</span>
            <span>Entregas</span>
            <span>Promedio</span>
            <span>Acciones</span>
          </div>
          <div className="divide-y divide-slate-200">
            {assignments.map((row) => (
              <div key={row.classId} className="grid grid-cols-4 gap-3 px-4 py-3 text-sm text-slate-800">
                <span className="font-medium">{row.className}</span>
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
