"use client";

import { useEffect, useState } from "react";
import { getDocs, collection, doc, getDoc } from "firebase/firestore";
import { db } from "@/lib/firebase/firestore";
import { getSubmissionsByClass, Submission, deleteSubmission } from "@/lib/firebase/submissions-service";
import { gradeSubmission } from "@/lib/firebase/submissions-service";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { GradeModal } from "./GradeModal";
import toast from "react-hot-toast";

type QuizAnswer = {
  questionId: string;
  question: string;
  selectedOptionId: string;
  selectedOptionText: string;
  isCorrect?: boolean;
};

type QuizDetailModalProps = {
  submission: Submission & { answers?: QuizAnswer[] };
  questions: Array<{
    id: string;
    prompt: string;
    options: Array<{ id: string; text: string; isCorrect?: boolean }>;
  }>;
  onClose: () => void;
};

function QuizDetailModal({ submission, questions, onClose }: QuizDetailModalProps) {
  const answers = submission.answers ?? [];
  const correctCount = answers.filter((a) => {
    const q = questions.find((qq) => qq.id === a.questionId);
    const opt = q?.options?.find((o) => o.id === a.selectedOptionId);
    return opt?.isCorrect === true;
  }).length;
  const grade = submission.grade ?? Math.round((correctCount / Math.max(questions.length, 1)) * 100);

  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : null)}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-auto">
        <DialogHeader>
          <div className="flex items-center justify-between gap-3">
            <DialogTitle>Respuestas de {submission.studentName}</DialogTitle>
            <span className={`rounded-full px-3 py-1 text-sm font-bold ${
              grade >= 80 ? "bg-emerald-100 text-emerald-700" :
              grade >= 60 ? "bg-amber-100 text-amber-700" :
              "bg-red-100 text-red-700"
            }`}>
              {grade}/100
            </span>
          </div>
        </DialogHeader>

        <div className="mt-4 space-y-4">
          <div className="flex items-center justify-between rounded-lg bg-slate-50 p-3 text-sm">
            <span className="text-slate-600">Respuestas correctas</span>
            <span className="font-semibold text-slate-900">{correctCount} de {questions.length}</span>
          </div>

          <div className="space-y-3">
            {questions.map((q, idx) => {
              const answer = answers.find((a) => a.questionId === q.id);
              const selectedOpt = q.options?.find((o) => o.id === answer?.selectedOptionId);
              const correctOpt = q.options?.find((o) => o.isCorrect === true);
              const isCorrect = selectedOpt?.isCorrect === true;
              const hasCorrectness = q.options?.some((o) => typeof o.isCorrect === "boolean");

              return (
                <div key={q.id} className={`rounded-lg border p-3 ${
                  !answer ? "border-slate-200 bg-slate-50" :
                  hasCorrectness && isCorrect ? "border-emerald-200 bg-emerald-50" :
                  hasCorrectness && !isCorrect ? "border-red-200 bg-red-50" :
                  "border-slate-200 bg-white"
                }`}>
                  <div className="flex items-start gap-2">
                    <span className="mt-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-slate-200 text-xs font-semibold text-slate-700">
                      {idx + 1}
                    </span>
                    <div className="flex-1">
                      <p className="text-sm font-medium text-slate-900">{q.prompt}</p>
                      {answer ? (
                        <div className="mt-2 space-y-1">
                          <div className="flex items-center gap-2">
                            <span className={`text-xs font-medium ${
                              hasCorrectness && isCorrect ? "text-emerald-700" :
                              hasCorrectness && !isCorrect ? "text-red-700" :
                              "text-slate-600"
                            }`}>
                              Respuesta:
                            </span>
                            <span className={`text-sm ${
                              hasCorrectness && isCorrect ? "text-emerald-800" :
                              hasCorrectness && !isCorrect ? "text-red-800" :
                              "text-slate-800"
                            }`}>
                              {answer.selectedOptionText || selectedOpt?.text || "-"}
                            </span>
                            {hasCorrectness ? (
                              isCorrect ? (
                                <span className="rounded-full bg-emerald-200 px-2 py-0.5 text-[10px] font-bold text-emerald-800">Correcto</span>
                              ) : (
                                <span className="rounded-full bg-red-200 px-2 py-0.5 text-[10px] font-bold text-red-800">Incorrecto</span>
                              )
                            ) : null}
                          </div>
                          {hasCorrectness && !isCorrect && correctOpt ? (
                            <div className="flex items-center gap-2 text-xs text-emerald-700">
                              <span className="font-medium">Respuesta correcta:</span>
                              <span>{correctOpt.text}</span>
                            </div>
                          ) : null}
                        </div>
                      ) : (
                        <p className="mt-1 text-xs text-slate-500">Sin respuesta</p>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

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
  const isQuizClass = classType === "quiz";
  const isForumClass = classType === "forum";
  const [gradeModal, setGradeModal] = useState<{
    open: boolean;
    submission?: Submission;
    readonly?: boolean;
  }>({ open: false });
  const [quizQuestions, setQuizQuestions] = useState<Array<{
    id: string;
    prompt: string;
    options: Array<{ id: string; text: string; isCorrect?: boolean }>;
  }>>([]);
  const [quizDetailModal, setQuizDetailModal] = useState<{
    open: boolean;
    submission?: Submission & { answers?: QuizAnswer[] };
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

        // Cargar preguntas del quiz si es un quiz
        if (classType === "quiz" && courseId && lessonId) {
          try {
            const qSnap = await getDocs(
              collection(db, "courses", courseId, "lessons", lessonId, "classes", classId, "questions"),
            );
            const questions = qSnap.docs.map((d) => {
              const qd = d.data();
              return {
                id: d.id,
                prompt: qd.prompt ?? qd.text ?? qd.question ?? "",
                options: Array.isArray(qd.options)
                  ? qd.options.map((opt: any) => ({
                      id: opt.id ?? opt.text ?? "",
                      text: opt.text ?? "",
                      isCorrect: opt.isCorrect,
                    }))
                  : [],
              };
            });
            setQuizQuestions(questions);
          } catch (err) {
            console.error("Error cargando preguntas del quiz:", err);
          }
        }
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
                  {isForumClass ? (
                    <th className="px-3 py-2 text-left">Aporte</th>
                  ) : isQuizClass ? (
                    <>
                      <th className="px-3 py-2 text-left">Calificación</th>
                      <th className="px-3 py-2 text-left">Acción</th>
                    </>
                  ) : (
                    <>
                      <th className="px-3 py-2 text-left">Archivo</th>
                      <th className="px-3 py-2 text-left">Calificación</th>
                      <th className="px-3 py-2 text-left">Acción</th>
                    </>
                  )}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((row) => {
                  const sub = row.submission;
                  const gradeValue = sub?.grade != null ? sub.grade : "-";
                  return (
                    <tr key={row.student.id} className="hover:bg-slate-50">
                      <td className="px-3 py-2 text-slate-900">{row.student.name}</td>
                      <td className="px-3 py-2 text-slate-600">
                        {sub ? formatDate(sub.submittedAt) : "-"}
                      </td>
                      {isForumClass ? (
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
                        ) : isQuizClass ? (
                          <>
                            <td className="px-3 py-2">
                              {sub?.grade != null ? (
                                <span className={`rounded-full px-2 py-1 text-xs font-semibold ${
                                  sub.grade >= 80 ? "bg-emerald-100 text-emerald-700" :
                                  sub.grade >= 60 ? "bg-amber-100 text-amber-700" :
                                  "bg-red-100 text-red-700"
                                }`}>
                                  {sub.grade}/100
                                </span>
                              ) : sub ? (
                                <span className="text-slate-500">Pendiente</span>
                              ) : (
                                "-"
                              )}
                            </td>
                            <td className="px-3 py-2">
                              {sub ? (
                                <button
                                  type="button"
                                  onClick={async () => {
                                    // Obtener respuestas del submission
                                    try {
                                      const subDoc = await getDoc(doc(db, "groups", groupId, "submissions", sub.id));
                                      const data = subDoc.data() as any;
                                      setQuizDetailModal({
                                        open: true,
                                        submission: {
                                          ...sub,
                                          answers: data?.answers ?? [],
                                        },
                                      });
                                    } catch (err) {
                                      console.error("Error cargando detalles:", err);
                                      toast.error("No se pudieron cargar los detalles");
                                    }
                                  }}
                                  className="rounded-lg border border-slate-200 px-3 py-1 text-sm font-medium text-blue-600 hover:border-blue-400"
                                >
                                  Ver detalles
                                </button>
                              ) : (
                                <span className="text-slate-400">-</span>
                              )}
                            </td>
                          </>
                        ) : (
                          <>
                            <td className="px-3 py-2 text-slate-600">
                              <div className="space-y-2">
                                {sub?.audioUrl ? (
                                  <div className="space-y-1">
                                    <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-500">
                                      Audio
                                    </p>
                                    <audio controls src={sub.audioUrl} className="w-full" />
                                  </div>
                                ) : null}
                                {sub?.fileUrl ? (
                                  <a
                                    href={sub.fileUrl}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="text-xs font-semibold text-blue-600 hover:underline"
                                  >
                                    Ver archivo
                                  </a>
                                ) : null}
                                {!sub?.fileUrl && !sub?.audioUrl ? (
                                  sub?.content ? (
                                    <span className="text-xs text-slate-500">Texto/Enlace</span>
                                  ) : (
                                    "-"
                                  )
                                ) : null}
                              </div>
                            </td>
                            <td className="px-3 py-2 text-slate-600">
                              {gradeValue}
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

      {quizDetailModal.open && quizDetailModal.submission ? (
        <QuizDetailModal
          submission={quizDetailModal.submission}
          questions={quizQuestions}
          onClose={() => setQuizDetailModal({ open: false })}
        />
      ) : null}
    </Dialog>
  );
}
