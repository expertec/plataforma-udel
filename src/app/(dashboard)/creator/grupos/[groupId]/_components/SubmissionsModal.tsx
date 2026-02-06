"use client";

import { useEffect, useState, useMemo } from "react";
import { ArrowLeft } from "lucide-react";
import { getDocs, collection, doc, getDoc } from "firebase/firestore";
import { db } from "@/lib/firebase/firestore";
import { auth } from "@/lib/firebase/client";
import { getSubmissionsByClass, Submission, deleteSubmission } from "@/lib/firebase/submissions-service";
import { gradeSubmission } from "@/lib/firebase/submissions-service";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { GradeModal } from "./GradeModal";
import toast from "react-hot-toast";
import {
  getForumPosts,
  getForumReplies,
  addForumReply,
  type ForumPost,
  type ForumReply,
} from "@/lib/firebase/forum-service";

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
  onGrade?: (grade: number, feedback: string) => Promise<void>;
};

function QuizDetailModal({ submission, questions, onClose, onGrade }: QuizDetailModalProps) {
  const answers = submission.answers ?? [];
  const existingGrade = submission.grade;

  // Si ya tiene calificación, es autocalificado - mostrar preguntas con respuestas
  // Si no tiene calificación, es manual - mostrar solo respuestas del alumno
  const isAutoGraded = existingGrade != null;

  // Estados para calificación manual
  const [manualGrade, setManualGrade] = useState<number | undefined>(existingGrade ?? undefined);
  const [feedback, setFeedback] = useState(submission.feedback ?? "");
  const [saving, setSaving] = useState(false);

  // Mostrar formulario de calificación manual si no tiene calificación
  const needsManualGrade = existingGrade == null;

  const handleSaveGrade = async () => {
    if (manualGrade == null || Number.isNaN(manualGrade) || !onGrade) return;
    setSaving(true);
    try {
      await onGrade(manualGrade, feedback);
      onClose();
    } finally {
      setSaving(false);
    }
  };

  // Calcular respuestas correctas para quizzes autocalificados
  const correctCount = isAutoGraded ? answers.filter((a) => {
    const q = questions.find((qq) => qq.id === a.questionId);
    const opt = q?.options?.find((o) => o.id === a.selectedOptionId);
    return opt?.isCorrect === true;
  }).length : 0;

  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : null)}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-auto">
        <DialogHeader>
          <div className="flex items-center justify-between gap-3">
            <DialogTitle>Respuestas de {submission.studentName}</DialogTitle>
            {existingGrade != null ? (
              <span className={`rounded-full px-3 py-1 text-sm font-bold ${
                existingGrade >= 80 ? "bg-emerald-100 text-emerald-700" :
                existingGrade >= 60 ? "bg-amber-100 text-amber-700" :
                "bg-red-100 text-red-700"
              }`}>
                {existingGrade}/100
              </span>
            ) : (
              <span className="rounded-full bg-blue-100 px-3 py-1 text-sm font-bold text-blue-700">
                Pendiente de calificar
              </span>
            )}
          </div>
        </DialogHeader>

        <div className="mt-4 space-y-4">
          {/* VISTA PARA QUIZZES AUTOCALIFICADOS - Preguntas con respuestas en cards */}
          {isAutoGraded && (
            <>
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
            </>
          )}

          {/* VISTA PARA QUIZZES SIN CALIFICACIÓN - Solo respuestas del alumno */}
          {!isAutoGraded && (
            <>
              {submission.content ? (
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
                  <h4 className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-500">Respuestas del alumno</h4>
                  <p className="whitespace-pre-wrap text-sm text-slate-700 leading-relaxed">{submission.content}</p>
                </div>
              ) : answers.length > 0 ? (
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
                  <h4 className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-500">Respuestas del alumno</h4>
                  <div className="space-y-3">
                    {answers.map((a, idx) => (
                      <div key={idx} className="rounded-lg bg-white p-3 border border-slate-100">
                        <p className="text-sm font-medium text-slate-700">{a.question || `Pregunta ${idx + 1}`}</p>
                        <p className="mt-1 text-sm text-slate-900">{a.selectedOptionText || "-"}</p>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
                  No se encontraron respuestas registradas para este quiz.
                </div>
              )}
            </>
          )}

          {/* Formulario de calificación manual */}
          {needsManualGrade && onGrade && (
            <div className="mt-6 rounded-lg border border-blue-200 bg-blue-50 p-4">
              <h4 className="mb-3 text-sm font-semibold text-blue-900">Calificación Manual</h4>
              <div className="space-y-3">
                <div>
                  <label className="text-xs font-medium text-blue-800">Calificación (0-100)</label>
                  <input
                    type="number"
                    min={0}
                    max={100}
                    value={manualGrade ?? ""}
                    onChange={(e) => setManualGrade(e.target.value ? Number(e.target.value) : undefined)}
                    className="mt-1 w-full rounded-lg border border-blue-200 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    placeholder="Ingresa la calificación"
                  />
                </div>
                <div>
                  <label className="text-xs font-medium text-blue-800">Retroalimentación (opcional)</label>
                  <textarea
                    value={feedback}
                    onChange={(e) => setFeedback(e.target.value)}
                    rows={2}
                    className="mt-1 w-full rounded-lg border border-blue-200 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    placeholder="Escribe un comentario para el alumno..."
                  />
                </div>
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={onClose}
                    className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100"
                  >
                    Cancelar
                  </button>
                  <button
                    type="button"
                    disabled={saving || manualGrade == null || Number.isNaN(manualGrade)}
                    onClick={handleSaveGrade}
                    className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {saving ? "Guardando..." : "Guardar Calificación"}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Botón de cerrar si ya está calificado */}
          {!needsManualGrade && (
            <div className="flex justify-end pt-2">
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                Cerrar
              </button>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
   ForumThreadModal – Vista de hilo de foro con todas las aportaciones
   ───────────────────────────────────────────────────────────────────────────── */

type ForumThreadModalProps = {
  courseId: string;
  lessonId: string;
  classId: string;
  highlightStudentId: string;
  highlightStudentName: string;
  currentUserId: string;
  currentUserName: string;
  onClose: () => void;
};

function ForumThreadModal({
  courseId,
  lessonId,
  classId,
  highlightStudentId,
  highlightStudentName,
  currentUserId,
  currentUserName,
  onClose,
}: ForumThreadModalProps) {
  const [posts, setPosts] = useState<ForumPost[]>([]);
  const [replies, setReplies] = useState<Record<string, ForumReply[]>>({});
  const [expandedPosts, setExpandedPosts] = useState<Set<string>>(new Set());
  const [loadingReplies, setLoadingReplies] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [replyText, setReplyText] = useState<Record<string, string>>({});
  const [sendingReply, setSendingReply] = useState<string | null>(null);

  // Cargar todas las aportaciones del foro
  useEffect(() => {
    const loadPosts = async () => {
      setLoading(true);
      try {
        const forumPosts = await getForumPosts(courseId, lessonId, classId);
        setPosts(forumPosts);
        // Expandir automáticamente el post del estudiante destacado
        if (highlightStudentId) {
          setExpandedPosts(new Set([highlightStudentId]));
          // Cargar respuestas del estudiante destacado
          const studentReplies = await getForumReplies(courseId, lessonId, classId, highlightStudentId);
          setReplies((prev) => ({ ...prev, [highlightStudentId]: studentReplies }));
        }
      } catch (err) {
        console.error("Error cargando posts del foro:", err);
        toast.error("Error al cargar el foro");
      } finally {
        setLoading(false);
      }
    };
    loadPosts();
  }, [courseId, lessonId, classId, highlightStudentId]);

  const toggleReplies = async (postId: string) => {
    if (expandedPosts.has(postId)) {
      setExpandedPosts((prev) => {
        const next = new Set(prev);
        next.delete(postId);
        return next;
      });
      return;
    }

    // Si no tenemos las respuestas, cargarlas
    if (!replies[postId]) {
      setLoadingReplies((prev) => new Set(prev).add(postId));
      try {
        const postReplies = await getForumReplies(courseId, lessonId, classId, postId);
        setReplies((prev) => ({ ...prev, [postId]: postReplies }));
      } catch (err) {
        console.error("Error cargando respuestas:", err);
        toast.error("Error al cargar respuestas");
      } finally {
        setLoadingReplies((prev) => {
          const next = new Set(prev);
          next.delete(postId);
          return next;
        });
      }
    }

    setExpandedPosts((prev) => new Set(prev).add(postId));
  };

  const handleSendReply = async (postId: string) => {
    const text = replyText[postId]?.trim();
    if (!text) return;

    setSendingReply(postId);
    try {
      await addForumReply({
        courseId,
        lessonId,
        classId,
        postId,
        text,
        authorId: currentUserId,
        authorName: currentUserName,
        role: "professor",
      });

      // Recargar respuestas
      const updatedReplies = await getForumReplies(courseId, lessonId, classId, postId);
      setReplies((prev) => ({ ...prev, [postId]: updatedReplies }));

      // Actualizar contador en el post
      setPosts((prev) =>
        prev.map((p) =>
          p.id === postId ? { ...p, repliesCount: (p.repliesCount ?? 0) + 1 } : p
        )
      );

      // Limpiar input
      setReplyText((prev) => ({ ...prev, [postId]: "" }));
      toast.success("Respuesta enviada");
    } catch (err) {
      console.error("Error enviando respuesta:", err);
      toast.error("Error al enviar respuesta");
    } finally {
      setSendingReply(null);
    }
  };

  const formatDate = (date: Date) => {
    return date.toLocaleString("es-MX", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  // Ordenar posts para que el seleccionado aparezca primero
  const sortedPosts = useMemo(() => {
    if (!highlightStudentId) return posts;
    return [...posts].sort((a, b) => {
      if (a.id === highlightStudentId) return -1;
      if (b.id === highlightStudentId) return 1;
      return 0;
    });
  }, [posts, highlightStudentId]);

  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : null)}>
      <DialogContent className="max-w-4xl max-h-[85vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>
            <div className="flex items-center gap-2">
              <span>Foro de discusión</span>
              <span className="text-sm font-normal text-slate-500">
                (destacando aporte de {highlightStudentName})
              </span>
            </div>
          </DialogTitle>
        </DialogHeader>

        <div className="flex-1 overflow-auto space-y-4 pr-2">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <div className="text-slate-500">Cargando aportaciones...</div>
            </div>
          ) : sortedPosts.length === 0 ? (
            <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-6 text-center text-slate-500">
              No hay aportaciones en este foro
            </div>
          ) : (
            sortedPosts.map((post) => {
              const isHighlighted = post.id === highlightStudentId;
              const isExpanded = expandedPosts.has(post.id);
              const postReplies = replies[post.id] ?? [];
              const isLoadingReplies = loadingReplies.has(post.id);

              return (
                <div
                  key={post.id}
                  className={`rounded-xl border-2 transition-all ${
                    isHighlighted
                      ? "border-blue-400 bg-blue-50/50 shadow-md ring-2 ring-blue-200"
                      : "border-slate-200 bg-white"
                  }`}
                >
                  {/* Header del post */}
                  <div className={`px-4 py-3 border-b ${isHighlighted ? "border-blue-200 bg-blue-100/50" : "border-slate-100 bg-slate-50"}`}>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-semibold ${
                          isHighlighted ? "bg-blue-500 text-white" : "bg-slate-300 text-slate-700"
                        }`}>
                          {post.authorName.charAt(0).toUpperCase()}
                        </div>
                        <div>
                          <span className={`font-semibold ${isHighlighted ? "text-blue-800" : "text-slate-800"}`}>
                            {post.authorName}
                          </span>
                          {isHighlighted && (
                            <span className="ml-2 rounded-full bg-blue-500 px-2 py-0.5 text-[10px] font-bold text-white uppercase">
                              Seleccionado
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        {post.format !== "text" && (
                          <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${
                            post.format === "audio" ? "bg-amber-100 text-amber-700" : "bg-purple-100 text-purple-700"
                          }`}>
                            {post.format}
                          </span>
                        )}
                        <span className="text-xs text-slate-500">{formatDate(post.createdAt)}</span>
                      </div>
                    </div>
                  </div>

                  {/* Contenido del post */}
                  <div className="px-4 py-3">
                    {post.text && (
                      <p className="text-sm text-slate-700 whitespace-pre-wrap leading-relaxed">{post.text}</p>
                    )}
                    {post.mediaUrl && (
                      <div className="mt-3">
                        {post.format === "audio" ? (
                          <audio controls src={post.mediaUrl} className="w-full max-w-md" />
                        ) : post.format === "video" ? (
                          <video controls src={post.mediaUrl} className="w-full max-w-lg rounded-lg" />
                        ) : (
                          <a
                            href={post.mediaUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="text-sm font-medium text-blue-600 hover:underline"
                          >
                            Ver adjunto
                          </a>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Botón para ver/ocultar respuestas */}
                  <div className={`px-4 py-2 border-t ${isHighlighted ? "border-blue-200" : "border-slate-100"}`}>
                    <button
                      type="button"
                      onClick={() => toggleReplies(post.id)}
                      className="text-sm font-medium text-blue-600 hover:text-blue-700 flex items-center gap-1"
                    >
                      {isLoadingReplies ? (
                        "Cargando..."
                      ) : isExpanded ? (
                        <>
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
                          </svg>
                          Ocultar respuestas ({post.repliesCount ?? 0})
                        </>
                      ) : (
                        <>
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                          </svg>
                          Ver respuestas ({post.repliesCount ?? 0})
                        </>
                      )}
                    </button>
                  </div>

                  {/* Respuestas */}
                  {isExpanded && (
                    <div className={`px-4 pb-4 ${isHighlighted ? "bg-blue-50/30" : "bg-slate-50/50"}`}>
                      {postReplies.length === 0 ? (
                        <p className="text-xs text-slate-500 py-2">No hay respuestas aún</p>
                      ) : (
                        <div className="space-y-2 mb-3">
                          {postReplies.map((reply) => (
                            <div
                              key={reply.id}
                              className={`rounded-lg p-3 ${
                                reply.role === "professor"
                                  ? "bg-emerald-50 border border-emerald-200"
                                  : "bg-white border border-slate-200"
                              }`}
                            >
                              <div className="flex items-center gap-2 mb-1">
                                <span className={`text-xs font-semibold ${
                                  reply.role === "professor" ? "text-emerald-700" : "text-slate-700"
                                }`}>
                                  {reply.authorName}
                                </span>
                                {reply.role === "professor" && (
                                  <span className="rounded-full bg-emerald-200 px-1.5 py-0.5 text-[9px] font-bold text-emerald-800 uppercase">
                                    Profesor
                                  </span>
                                )}
                                <span className="text-[10px] text-slate-400">{formatDate(reply.createdAt)}</span>
                              </div>
                              <p className="text-sm text-slate-700">{reply.text}</p>
                            </div>
                          ))}
                        </div>
                      )}

                      {/* Input para nueva respuesta */}
                      <div className="flex gap-2">
                        <input
                          type="text"
                          value={replyText[post.id] ?? ""}
                          onChange={(e) => setReplyText((prev) => ({ ...prev, [post.id]: e.target.value }))}
                          placeholder="Escribe una respuesta como profesor..."
                          className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && !e.shiftKey) {
                              e.preventDefault();
                              handleSendReply(post.id);
                            }
                          }}
                        />
                        <button
                          type="button"
                          disabled={!replyText[post.id]?.trim() || sendingReply === post.id}
                          onClick={() => handleSendReply(post.id)}
                          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          {sendingReply === post.id ? "..." : "Enviar"}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>

        <div className="flex justify-end pt-4 border-t border-slate-200">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Cerrar
          </button>
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
  const [searchTerm, setSearchTerm] = useState("");
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
  const [forumThreadModal, setForumThreadModal] = useState<{
    open: boolean;
    studentId: string;
    studentName: string;
  }>({ open: false, studentId: "", studentName: "" });

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

  const handleResetSubmission = async (
    submissionId: string,
    studentName: string,
    label: "tarea" | "aporte" = "tarea",
  ) => {
    const pronoun = label === "tarea" ? "la" : "lo";
    if (!confirm(`¿Estás seguro de que deseas resetear el ${label} de ${studentName}? Esto permitirá que el alumno vuelva a enviar${pronoun}.`)) {
      return;
    }

    setDeletingIds((prev) => new Set(prev).add(submissionId));
    try {
      await deleteSubmission(groupId, submissionId);
      toast.success(`${label === "tarea" ? "Tarea" : "Aporte"} reseteado. El alumno puede enviar${pronoun} nuevamente.`);

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

  const filteredRows = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    if (!term) return rows;
    return rows.filter((r) => r.student.name.toLowerCase().includes(term));
  }, [rows, searchTerm]);

  const columnsCount = isForumClass ? 3 : isQuizClass ? 4 : 5;

  return (
    <Dialog open={isOpen} onOpenChange={(open) => (!open ? onClose() : null)}>
      <DialogContent className="w-full max-w-6xl sm:w-[1200px]">
        <DialogHeader className="space-y-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                className="inline-flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-100"
                aria-label="Volver a tareas por lección"
              >
                <ArrowLeft size={16} />
                <span>Volver</span>
              </button>
              <DialogTitle>Entregas: {className}</DialogTitle>
            </div>
            <div className="relative w-full sm:w-72">
              <input
                type="text"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                placeholder="Buscar alumno..."
                className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 shadow-sm focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-100"
              />
              <svg
                className="pointer-events-none absolute right-3 top-2.5 h-4 w-4 text-slate-400"
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 20 20"
                fill="currentColor"
              >
                <path
                  fillRule="evenodd"
                  d="M12.9 14.32a7 7 0 111.414-1.414l3.387 3.387a1 1 0 01-1.414 1.414l-3.387-3.387zM14 9a5 5 0 11-10 0 5 5 0 0110 0z"
                  clipRule="evenodd"
                />
              </svg>
            </div>
          </div>
          <span className="text-xs text-slate-500">
            Mostrando {filteredRows.length} de {rows.length} alumnos
          </span>
        </DialogHeader>

        {loading ? (
          <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
            Cargando entregas...
          </div>
        ) : (
          <div className="overflow-auto rounded-lg border border-slate-200">
            <table className="min-w-full table-auto text-sm">
              <thead className="bg-slate-50 text-slate-600">
                <tr>
                  <th className="px-3 py-2 text-left align-middle">Nombre</th>
                  <th className="px-3 py-2 text-left align-middle">Fecha entrega</th>
                  {isForumClass ? (
                    <th className="px-3 py-2 text-left align-middle">Acción</th>
                  ) : isQuizClass ? (
                    <>
                      <th className="px-3 py-2 text-left align-middle">Calificación</th>
                      <th className="px-3 py-2 text-left align-middle">Acción</th>
                    </>
                  ) : (
                    <>
                      <th className="px-3 py-2 text-left align-middle min-w-[160px]">Archivo</th>
                      <th className="px-3 py-2 text-left align-middle">Calificación</th>
                      <th className="px-3 py-2 text-left align-middle">Acción</th>
                    </>
                  )}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredRows.length === 0 ? (
                  <tr>
                    <td colSpan={columnsCount} className="px-3 py-6 text-center text-sm text-slate-500">
                      No se encontraron alumnos con ese nombre.
                    </td>
                  </tr>
                ) : null}
                {filteredRows.map((row) => {
                  const sub = row.submission;
                  const gradeValue = sub?.grade != null ? sub.grade : "-";
                  return (
                    <tr key={row.student.id} className="hover:bg-slate-50">
                      <td className="px-3 py-2 align-middle text-slate-900">{row.student.name}</td>
                      <td className="px-3 py-2 align-middle text-slate-600">
                        {sub ? formatDate(sub.submittedAt) : "-"}
                      </td>
                      {isForumClass ? (
                        <td className="px-3 py-2">
                          <div className="flex items-center gap-2">
                            {sub ? (
                              <>
                                <button
                                  type="button"
                                  className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-1 text-sm font-medium text-blue-600 hover:border-blue-400 hover:bg-blue-100"
                                  onClick={() => setForumThreadModal({
                                    open: true,
                                    studentId: row.student.id,
                                    studentName: row.student.name,
                                  })}
                                >
                                  Ver hilo
                                </button>
                                <button
                                  type="button"
                                  className="rounded-lg border border-red-200 bg-red-50 px-3 py-1 text-sm font-medium text-red-600 hover:border-red-400 hover:bg-red-100 disabled:opacity-60"
                                  disabled={deletingIds.has(sub.id)}
                                  onClick={() => handleResetSubmission(sub.id, row.student.name, "aporte")}
                                >
                                  {deletingIds.has(sub.id) ? "Reseteando..." : "Resetear"}
                                </button>
                              </>
                            ) : (
                              <span className="text-slate-400">-</span>
                            )}
                          </div>
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
                                <span className="rounded-full bg-blue-100 px-2 py-1 text-xs font-semibold text-blue-700">
                                  Pendiente
                                </span>
                              ) : (
                                "-"
                              )}
                            </td>
                            <td className="px-3 py-2">
                              {sub ? (
                                <div className="flex items-center gap-2">
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
                                            content: data?.content ?? sub.content,
                                            answers: data?.answers ?? [],
                                          },
                                        });
                                      } catch (err) {
                                        console.error("Error cargando detalles:", err);
                                        toast.error("No se pudieron cargar los detalles");
                                      }
                                    }}
                                    className={`rounded-lg border px-3 py-1 text-sm font-medium ${
                                      sub.grade == null
                                        ? "border-blue-400 bg-blue-50 text-blue-600 hover:bg-blue-100"
                                        : "border-slate-200 text-blue-600 hover:border-blue-400"
                                    }`}
                                  >
                                    {sub.grade == null ? "Ver y Calificar" : "Ver detalles"}
                                  </button>
                                  <button
                                    type="button"
                                    className="rounded-lg border border-red-200 bg-red-50 px-3 py-1 text-sm font-medium text-red-600 hover:border-red-400 hover:bg-red-100 disabled:opacity-60"
                                    disabled={deletingIds.has(sub.id)}
                                    onClick={() => handleResetSubmission(sub.id, row.student.name)}
                                  >
                                    {deletingIds.has(sub.id) ? "Reseteando..." : "Resetear"}
                                  </button>
                                </div>
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
                                    <audio controls src={sub.audioUrl} className="w-[260px] max-w-full" />
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
          onGrade={async (grade, feedback) => {
            await gradeSubmission(groupId, quizDetailModal.submission!.id, grade, feedback);
            toast.success("Calificación guardada correctamente");
            const submissions = (await getSubmissionsByClass(groupId, classId)).filter(
              (s) => !courseId || !s.courseId || s.courseId === courseId,
            );
            setRows((prev) =>
              prev.map((r) => ({
                ...r,
                submission: submissions.find((s) => s.studentId === r.student.id),
              })),
            );
            setQuizDetailModal({ open: false });
          }}
        />
      ) : null}

      {forumThreadModal.open && courseId && lessonId ? (
        <ForumThreadModal
          courseId={courseId}
          lessonId={lessonId}
          classId={classId}
          highlightStudentId={forumThreadModal.studentId}
          highlightStudentName={forumThreadModal.studentName}
          currentUserId={auth.currentUser?.uid ?? ""}
          currentUserName={auth.currentUser?.displayName ?? "Profesor"}
          onClose={() => setForumThreadModal({ open: false, studentId: "", studentName: "" })}
        />
      ) : null}
    </Dialog>
  );
}
