"use client";

import { useEffect, useState } from "react";
import { getDocs, collection } from "firebase/firestore";
import { db } from "@/lib/firebase/firestore";
import { getSubmissionsByClass, Submission } from "@/lib/firebase/submissions-service";
import { gradeSubmission } from "@/lib/firebase/submissions-service";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { GradeModal } from "./GradeModal";

type Props = {
  groupId: string;
  classId: string;
  courseId?: string;
  className: string;
  isOpen: boolean;
  onClose: () => void;
};

type Student = {
  id: string;
  name: string;
};

type Row = {
  student: Student;
  submission?: Submission;
};

export function SubmissionsModal({ groupId, classId, className, courseId, isOpen, onClose }: Props) {
  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [gradeModal, setGradeModal] = useState<{
    open: boolean;
    submission?: Submission;
    readonly?: boolean;
  }>({ open: false });

  useEffect(() => {
    if (!isOpen) return;
    const load = async () => {
      setLoading(true);
      try {
        const studentsSnap = await getDocs(collection(db, "groups", groupId, "students"));
        const students: Student[] = studentsSnap.docs.map((d) => {
          const data = d.data();
          return {
            id: d.id,
            name: data.studentName ?? "",
          };
        });

        const submissions = (await getSubmissionsByClass(groupId, classId)).filter(
          (s) => !courseId || !s.courseId || s.courseId === courseId,
        );
        const rows: Row[] = students.map((s) => ({
          student: s,
          submission: submissions.find((sub) => sub.studentId === s.id),
        }));
        setRows(rows);
      } catch (err) {
        console.error(err);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [isOpen, groupId, classId, courseId]);

  const formatDate = (date?: Date | null) => {
    if (!date) return "-";
    return date.toLocaleString("es-MX", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => (!open ? onClose() : null)}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>Entregas: {className}</DialogTitle>
        </DialogHeader>

        {loading ? (
          <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
            Cargando entregas...
          </div>
        ) : (
          <div className="overflow-auto rounded-lg border border-slate-200">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50 text-slate-600">
                <tr>
                  <th className="px-3 py-2 text-left">Nombre</th>
                  <th className="px-3 py-2 text-left">Fecha entrega</th>
                  <th className="px-3 py-2 text-left">Calificación</th>
                  <th className="px-3 py-2 text-left">Acción</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((row) => {
                  const sub = row.submission;
                  const actionLabel = !sub
                    ? "Pendiente"
                    : sub.grade == null
                    ? "Calificar"
                    : "Ver";
                  const isReadonly = sub?.grade != null;
                  return (
                    <tr key={row.student.id} className="hover:bg-slate-50">
                      <td className="px-3 py-2 text-slate-900">{row.student.name}</td>
                      <td className="px-3 py-2 text-slate-600">
                        {sub ? formatDate(sub.submittedAt) : "-"}
                      </td>
                      <td className="px-3 py-2 text-slate-600">
                        {sub?.grade != null ? sub.grade : "-"}
                      </td>
                      <td className="px-3 py-2">
                        <button
                          type="button"
                          className="rounded-lg border border-slate-200 px-3 py-1 text-sm font-medium text-blue-600 hover:border-blue-400 disabled:opacity-60"
                          disabled={!sub}
                          onClick={() =>
                            sub
                              ? setGradeModal({ open: true, submission: sub, readonly: isReadonly })
                              : null
                          }
                        >
                          {actionLabel}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </DialogContent>

      {gradeModal.open && gradeModal.submission ? (
        <GradeModal
          submission={gradeModal.submission}
          readonly={gradeModal.readonly}
          onClose={async () => {
            setGradeModal({ open: false });
            const submissions = (await getSubmissionsByClass(groupId, classId)).filter(
              (s) => !courseId || !s.courseId || s.courseId === courseId,
            );
            setRows((prev) =>
              prev.map((r) => ({
                ...r,
                submission: submissions.find((s) => s.studentId === r.student.id),
              })),
            );
          }}
          onSave={async (grade, feedback) => {
            await gradeSubmission(groupId, gradeModal.submission!.id, grade, feedback);
            const submissions = (await getSubmissionsByClass(groupId, classId)).filter(
              (s) => !courseId || !s.courseId || s.courseId === courseId,
            );
            setRows((prev) =>
              prev.map((r) => ({
                ...r,
                submission: submissions.find((s) => s.studentId === r.student.id),
              })),
            );
            setGradeModal({ open: false });
          }}
        />
      ) : null}
    </Dialog>
  );
}
