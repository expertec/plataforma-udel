"use client";

import { useEffect, useState } from "react";
import { collection, getDocs } from "firebase/firestore";
import { db } from "@/lib/firebase/firestore";
import { getSubmissionsByClass, Submission } from "@/lib/firebase/submissions-service";
import { SubmissionsModal } from "./SubmissionsModal";

type EntregasTabProps = {
  groupId: string;
  courseId: string;
  studentsCount: number;
};

type AssignmentRow = {
  classId: string;
  className: string;
  classType: string;
  submissions: Submission[];
  avgGrade: number | null;
};

export function EntregasTab({ groupId, courseId, studentsCount }: EntregasTabProps) {
  const [assignments, setAssignments] = useState<AssignmentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<{ classId: string; className: string } | null>(null);

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      try {
        const lessonsSnap = await getDocs(collection(db, "courses", courseId, "lessons"));
        const classesPromises = lessonsSnap.docs.map(async (lessonDoc) => {
          const classesSnap = await getDocs(
            collection(db, "courses", courseId, "lessons", lessonDoc.id, "classes"),
          );
          return classesSnap.docs
            .map((docSnap) => {
              const data = docSnap.data() as {
                type?: string;
                title?: string;
                hasAssignment?: boolean;
                assignmentTemplateUrl?: string;
              };
              return {
                id: docSnap.id,
                type: data.type,
                title: data.title,
                hasAssignment: data.hasAssignment ?? false,
              };
            })
            .filter((c) => c.type === "quiz" || c.hasAssignment === true)
            .map((c) => ({
              lessonId: lessonDoc.id,
              classId: c.id,
              title: c.title ?? "Sin título",
              classType: c.type ?? (c.hasAssignment ? "assignment" : ""),
            }));
        });
        const classes = (await Promise.all(classesPromises)).flat();

        const rows: AssignmentRow[] = [];
        for (const cls of classes) {
          const submissions = await getSubmissionsByClass(groupId, cls.classId);
          const graded = submissions.filter((s) => typeof s.grade === "number");
          const avgGrade =
            graded.length > 0 ? graded.reduce((sum, s) => sum + (s.grade ?? 0), 0) / graded.length : null;
          rows.push({
            classId: cls.classId,
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
  }, [courseId, groupId]);

  if (loading) {
    return (
      <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
        Cargando entregas...
      </div>
    );
  }

  if (assignments.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
        Este curso no tiene tareas.
      </div>
    );
  }

  return (
    <div className="space-y-4">
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
              <span className="text-slate-600">
                {row.submissions.length}/{studentsCount || "?"}
              </span>
              <span className="text-slate-600">
                {row.avgGrade !== null ? row.avgGrade.toFixed(1) : "Sin calificar"}
              </span>
              <div>
                <button
                  type="button"
                  onClick={() => setSelected({ classId: row.classId, className: row.className })}
                  className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-medium text-blue-600 hover:border-blue-400"
                >
                  Revisar
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {selected ? (
        <SubmissionsModal
          groupId={groupId}
          classId={selected.classId}
          className={selected.className}
          isOpen
          onClose={() => setSelected(null)}
        />
      ) : null}
    </div>
  );
}
