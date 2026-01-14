"use client";

import { useEffect, useState } from "react";
import { getDocs, collection } from "firebase/firestore";
import { db } from "@/lib/firebase/firestore";
import { getSubmissionsByClass, Submission, deleteSubmission } from "@/lib/firebase/submissions-service";
import { gradeSubmission } from "@/lib/firebase/submissions-service";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { GradeModal } from "./GradeModal";
import toast from "react-hot-toast";

type Props = {
  groupId: string;
  classId: string;
  courseId?: string;
  lessonId?: string;
  classType?: string;
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

export function SubmissionsModal({
  groupId,
  classId,
  className,
  courseId,
  lessonId,
  classType,
  isOpen,
  onClose,
}: Props) {
  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [deletingIds, setDeletingIds] = useState<Set<string>>(new Set());
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

        let submissions: Submission[] = [];
        if (classType === "forum" && courseId && lessonId) {
          const forumSnap = await getDocs(
            collection(db, "courses", courseId, "lessons", lessonId, "classes", classId, "forums"),
          );
          submissions = forumSnap.docs.map((d) => {
            const data = d.data() as any;
            return {
              id: d.id,
              classId,
              classDocId: classId,
              courseId,
              className,
              classType: "forum",
              studentId: data.authorId ?? "",
              studentName: data.authorName ?? "",
              submittedAt: data.createdAt?.toDate?.() ?? null,
              fileUrl: data.mediaUrl ?? "",
              content: data.text ?? "",
              status: "pending",
              grade: undefined,
              feedback: "",
            };
          });
        } else {
          submissions = (await getSubmissionsByClass(groupId, classId)).filter(
            (s) => !courseId || !s.courseId || s.courseId === courseId,
          );
        }
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
  }, [isOpen, groupId, classId, courseId, lessonId, classType]);

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

  const handleResetSubmission = async (submissionId: string, studentName: string) => {
    if (!confirm(`¿Estás seguro de que deseas resetear la tarea de ${studentName}? Esto permitirá que el alumno la vuelva a enviar.`)) {
      return;
    }

    setDeletingIds((prev) => new Set(prev).add(submissionId));
    try {
      await deleteSubmission(groupId, submissionId);
      toast.success("Tarea reseteada. El alumno puede enviarla nuevamente.");

      // Recargar las submissions
      const submissions = (await getSubmissionsByClass(groupId, classId)).filter(
        (s) => !courseId || !s.courseId || s.courseId === courseId,
      );
      setRows((prev) =>
        prev.map((r) => ({
          ...r,
          submission: submissions.find((s) => s.studentId === r.student.id),
        })),
      );
    } catch (err) {
      console.error("Error al resetear la tarea:", err);
      toast.error("No se pudo resetear la tarea");
    } finally {
      setDeletingIds((prev) => {
        const next = new Set(prev);
        next.delete(submissionId);
        return next;
      });
    }
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
                  {classType === "forum" ? <th className="px-3 py-2 text-left">Aporte</th> : null}
                  {classType !== "forum" ? (
                    <>
                      <th className="px-3 py-2 text-left">Archivo</th>
                      <th className="px-3 py-2 text-left">Calificación</th>
                      <th className="px-3 py-2 text-left">Acción</th>
                    </>
                  ) : null}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((row) => {
                  const sub = row.submission;
                  return (
                    <tr key={row.student.id} className="hover:bg-slate-50">
                      <td className="px-3 py-2 text-slate-900">{row.student.name}</td>
                      <td className="px-3 py-2 text-slate-600">
                        {sub ? formatDate(sub.submittedAt) : "-"}
                      </td>
                      {classType === "forum" ? (
                        <td className="px-3 py-2 text-slate-600">
                          {sub ? (
                            <div className="space-y-1">
                              {sub.content ? <p className="text-sm text-slate-800">{sub.content}</p> : null}
                              {sub.fileUrl ? (
                                <a
                                  href={sub.fileUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="text-xs font-semibold text-blue-600 hover:underline"
                                >
                                  Ver adjunto
                                </a>
                              ) : null}
                            </div>
                          ) : (
                            "-"
                          )}
                        </td>
                      ) : (
                        <>
                          <td className="px-3 py-2 text-slate-600">
                            {sub?.fileUrl ? (
                              <a
                                href={sub.fileUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="text-xs font-semibold text-blue-600 hover:underline"
                              >
                                Ver archivo
                              </a>
                            ) : sub?.content ? (
                              <span className="text-xs text-slate-500">Texto/Enlace</span>
                            ) : (
                              "-"
                            )}
                          </td>
                          <td className="px-3 py-2 text-slate-600">
                            {sub?.grade != null ? sub.grade : "-"}
                          </td>
                          <td className="px-3 py-2">
                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                className="rounded-lg border border-slate-200 px-3 py-1 text-sm font-medium text-blue-600 hover:border-blue-400 disabled:opacity-60"
                                disabled={!sub}
                                onClick={() =>
                                  sub
                                    ? setGradeModal({
                                        open: true,
                                        submission: sub,
                                        readonly: sub?.grade != null,
                                      })
                                    : null
                                }
                              >
                                {!sub ? "Pendiente" : sub.grade == null ? "Calificar" : "Ver"}
                              </button>
                              {sub ? (
                                <button
                                  type="button"
                                  className="rounded-lg border border-red-200 bg-red-50 px-3 py-1 text-sm font-medium text-red-600 hover:border-red-400 hover:bg-red-100 disabled:opacity-60"
                                  disabled={deletingIds.has(sub.id)}
                                  onClick={() => handleResetSubmission(sub.id, row.student.name)}
                                >
                                  {deletingIds.has(sub.id) ? "Reseteando..." : "Resetear"}
                                </button>
                              ) : null}
                            </div>
                          </td>
                        </>
                      )}
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
