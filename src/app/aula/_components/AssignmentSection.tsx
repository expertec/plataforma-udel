"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Download, FileUp, Loader2, Trash2 } from "lucide-react";
import toast from "react-hot-toast";
import { collection, getDocs, limit, query, where } from "firebase/firestore";
import { getDownloadURL, getStorage, ref, uploadBytes } from "firebase/storage";
import { db } from "@/lib/firebase/firestore";
import { createSubmission, deleteSubmission } from "@/lib/firebase/submissions-service";
import { resolvePreferredContentTypeForMediaFile } from "@/lib/media/forum-media";
import { useAulaData } from "../_lib/AulaDataContext";
import type { FeedClass } from "../_lib/types";

type ExistingSubmission = {
  id: string;
  status: "pending" | "graded" | "late";
  grade: number | null;
  fileUrl: string;
  audioUrl: string;
  feedback: string;
};

export function AssignmentSection({ cls }: { cls: FeedClass }) {
  const { currentUser, studentName, isCourseClosed } = useAulaData();
  const [submission, setSubmission] = useState<ExistingSubmission | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const submissionType = cls.assignmentSubmissionType === "audio" ? "audio" : "file";
  const baseClassId = cls.classDocId ?? cls.id;
  const closed = isCourseClosed(cls);

  const refresh = useCallback(async () => {
    if (!currentUser?.uid || !cls.groupId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const snap = await getDocs(
        query(
          collection(db, "groups", cls.groupId, "submissions"),
          where("classId", "==", baseClassId),
          where("studentId", "==", currentUser.uid),
          limit(1),
        ),
      );
      if (snap.empty) {
        setSubmission(null);
      } else {
        const docSnap = snap.docs[0];
        const data = docSnap.data();
        const graded = data.status === "graded" || typeof data.grade === "number";
        setSubmission({
          id: docSnap.id,
          status: graded ? "graded" : data.status === "late" ? "late" : "pending",
          grade: typeof data.grade === "number" ? data.grade : null,
          fileUrl: data.fileUrl ?? "",
          audioUrl: data.audioUrl ?? "",
          feedback: data.feedback ?? "",
        });
      }
    } catch (err) {
      console.error("No se pudo consultar la entrega:", err);
    } finally {
      setLoading(false);
    }
  }, [currentUser?.uid, cls.groupId, baseClassId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleSubmit = async () => {
    if (!currentUser?.uid || !cls.enrollmentId || !cls.groupId) {
      toast.error("Faltan datos para enviar la tarea");
      return;
    }
    if (closed) {
      toast.error("Esta materia está cerrada; no se permiten nuevas entregas.");
      return;
    }
    if (!file) {
      toast.error(
        submissionType === "audio"
          ? "Adjunta un audio antes de enviar la tarea."
          : "Adjunta un archivo antes de enviar la tarea.",
      );
      return;
    }

    setUploading(true);
    try {
      const storage = getStorage();
      const prefix = submissionType === "audio" ? "audio" : "archivo";
      const storageRef = ref(
        storage,
        `assignments/${currentUser.uid}/${cls.id}/${prefix}-${Date.now()}-${file.name}`,
      );
      await uploadBytes(storageRef, file, {
        contentType: resolvePreferredContentTypeForMediaFile(
          file,
          file.type || "application/octet-stream",
        ),
        contentDisposition: "inline",
      });
      const downloadUrl = await getDownloadURL(storageRef);

      // enrollmentId y groupId van fuera del tipo, igual que en el feed clásico,
      // porque el documento de la entrega los conserva.
      const payload = {
        classId: baseClassId,
        classDocId: baseClassId,
        className: cls.title ?? "Tarea",
        courseId: cls.courseId ?? "",
        courseTitle: cls.courseTitle ?? "",
        lessonId: cls.lessonId ?? "",
        lessonTitle: cls.lessonTitle ?? cls.lessonName ?? "",
        classType: cls.type,
        studentId: currentUser.uid,
        studentName: studentName || currentUser.displayName || "Estudiante",
        submittedAt: new Date(),
        content: "",
        fileUrl: submissionType === "file" ? downloadUrl : "",
        audioUrl: submissionType === "audio" ? downloadUrl : "",
        enrollmentId: cls.enrollmentId,
        groupId: cls.groupId,
        status: "pending" as const,
      };
      await createSubmission(cls.groupId, payload);

      toast.success("Tarea enviada");
      setFile(null);
      if (inputRef.current) inputRef.current.value = "";
      await refresh();
    } catch (err) {
      console.error("No se pudo enviar la tarea:", err);
      const message = err instanceof Error ? err.message : "";
      toast.error(
        message.toLowerCase().includes("curso está cerrado")
          ? "Esta materia está cerrada; no se permiten nuevas entregas."
          : "No se pudo enviar la tarea",
      );
    } finally {
      setUploading(false);
    }
  };

  const handleDelete = async () => {
    if (!submission || !cls.groupId) return;
    if (submission.status === "graded") {
      toast.error("Esta tarea ya fue evaluada; no puedes eliminarla.");
      return;
    }
    if (!window.confirm("¿Eliminar tu entrega? Podrás volver a enviarla.")) return;
    try {
      await deleteSubmission(cls.groupId, submission.id);
      toast.success("Entrega eliminada. Ya puedes volver a enviarla.");
      await refresh();
    } catch (err) {
      console.error("No se pudo eliminar la entrega:", err);
      toast.error("No se pudo eliminar la entrega.");
    }
  };

  if (!cls.hasAssignment) return null;

  return (
    <section>
      <p className="text-sm text-[var(--aula-text-muted)]">
        {submissionType === "audio"
          ? "Graba o adjunta un audio para entregar esta tarea."
          : "Adjunta el archivo con tu entrega."}
      </p>

      {cls.assignmentTemplateUrl && (
        <a
          href={cls.assignmentTemplateUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-4 inline-flex items-center gap-2 rounded-lg border border-[var(--aula-border)] px-3 py-2 text-sm text-[var(--aula-text)] hover:bg-white/5"
        >
          <Download size={16} />
          Descargar plantilla
        </a>
      )}

      {loading ? (
        <p className="mt-4 text-sm text-[var(--aula-text-muted)]">Consultando tu entrega…</p>
      ) : submission ? (
        <div className="mt-4 rounded-xl border border-[var(--aula-border)] bg-[var(--aula-bg)] p-4">
          <p className="text-sm text-[var(--aula-text)]">
            {submission.status === "graded"
              ? `Entrega calificada${submission.grade !== null ? `: ${submission.grade}` : ""}`
              : "Entrega enviada. Está pendiente de calificación."}
          </p>
          {submission.feedback && (
            <p className="mt-2 text-sm text-[var(--aula-text-muted)]">
              Retroalimentación: {submission.feedback}
            </p>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-3">
            {(submission.fileUrl || submission.audioUrl) && (
              <a
                href={submission.fileUrl || submission.audioUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm font-medium text-[var(--aula-accent-soft)] hover:underline"
              >
                Ver mi entrega
              </a>
            )}
            {submission.status !== "graded" && (
              <button
                type="button"
                onClick={handleDelete}
                className="inline-flex items-center gap-1.5 text-sm text-red-400 hover:underline"
              >
                <Trash2 size={14} />
                Eliminar entrega
              </button>
            )}
          </div>
        </div>
      ) : closed ? (
        <p className="mt-4 text-sm text-[var(--aula-text-muted)]">
          Esta materia está cerrada; no se permiten nuevas entregas.
        </p>
      ) : (
        <div className="mt-4 space-y-3">
          <input
            ref={inputRef}
            type="file"
            accept={submissionType === "audio" ? "audio/*" : undefined}
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            className="block w-full text-sm text-[var(--aula-text-muted)] file:mr-3 file:rounded-lg file:border-0 file:bg-white/10 file:px-3 file:py-2 file:text-sm file:text-[var(--aula-text)]"
          />
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!file || uploading}
            className="inline-flex items-center gap-2 rounded-xl bg-[var(--aula-accent)] px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-40"
          >
            {uploading ? <Loader2 size={16} className="animate-spin" /> : <FileUp size={16} />}
            {uploading ? "Enviando…" : "Enviar tarea"}
          </button>
        </div>
      )}
    </section>
  );
}
