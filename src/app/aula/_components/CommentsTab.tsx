"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Mic, Paperclip, Send, Trash2 } from "lucide-react";
import toast from "react-hot-toast";
import { getDownloadURL, getStorage, ref, uploadBytes } from "firebase/storage";
import {
  normalizeForumAudioFile,
  pickPreferredAudioRecordingMimeType,
  resolvePreferredContentTypeForMediaFile,
} from "@/lib/media/forum-media";
import { useAulaData } from "../_lib/AulaDataContext";
import {
  addComment,
  formatRelativeTime,
  hasCommentsPath,
  loadComments,
  type AulaComment,
} from "../_lib/comments";
import type { FeedClass } from "../_lib/types";

function CommentItem({ comment, depth = 0 }: { comment: AulaComment; depth?: number }) {
  return (
    <li className={depth > 0 ? "ml-8 border-l border-[var(--aula-border)] pl-4" : ""}>
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--aula-accent)]/20 text-xs font-semibold text-[var(--aula-accent-soft)]">
          {comment.author.slice(0, 1).toUpperCase()}
        </div>
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-baseline gap-2">
            <span className="text-sm font-semibold text-[var(--aula-text)]">{comment.author}</span>
            <span className="text-xs text-[var(--aula-text-muted)]">
              {comment.role === "professor" ? "Profesor" : "Estudiante"}
            </span>
          </p>
          <p className="text-xs text-[var(--aula-text-muted)]">
            {formatRelativeTime(comment.createdAt)}
          </p>
          <p className="mt-1.5 whitespace-pre-wrap break-words text-sm leading-relaxed text-[var(--aula-text)]">
            {comment.text || (comment.audioUrl ? "Comentario de audio" : "")}
          </p>
          {comment.audioUrl ? (
            <div className="mt-2">
              <audio controls src={comment.audioUrl} className="w-full max-w-md" />
            </div>
          ) : null}
        </div>
      </div>
    </li>
  );
}

function PendingAudioPreview({
  file,
  onRemove,
}: {
  file: File | null;
  onRemove: () => void;
}) {
  const previewUrl = useMemo(() => (file ? URL.createObjectURL(file) : ""), [file]);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  if (!file || !previewUrl) return null;

  return (
    <div className="mx-4 mb-4 rounded-xl border border-[var(--aula-border)] bg-[var(--aula-bg)] p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wide text-[var(--aula-accent-soft)]">
            Audio listo
          </p>
          <p className="truncate text-xs text-[var(--aula-text-muted)]">{file.name}</p>
        </div>
        <button
          type="button"
          onClick={onRemove}
          className="inline-flex items-center gap-1 rounded-lg border border-red-500/30 px-2 py-1 text-xs text-red-400 hover:bg-red-500/10"
        >
          <Trash2 size={12} />
          Quitar
        </button>
      </div>
      <audio controls src={previewUrl} className="mt-3 w-full" />
    </div>
  );
}

export function CommentsTab({
  cls,
  onCountChange,
}: {
  cls: FeedClass;
  onCountChange?: (count: number) => void;
}) {
  const { currentUser, studentName } = useAulaData();
  const [comments, setComments] = useState<AulaComment[]>([]);
  const [loading, setLoading] = useState(true);
  const [text, setText] = useState("");
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [processingAudio, setProcessingAudio] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recordingError, setRecordingError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);

  const available = hasCommentsPath(cls);

  const refresh = useCallback(async () => {
    if (!available) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const loaded = await loadComments(cls);
      setComments(loaded);
      onCountChange?.(loaded.length);
    } catch (err) {
      console.error("No se pudieron cargar los comentarios:", err);
    } finally {
      setLoading(false);
    }
  }, [cls, available, onCountChange]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    return () => {
      if (recorderRef.current && recorderRef.current.state !== "inactive") {
        recorderRef.current.stop();
      }
      streamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  const clearAudioInput = () => {
    setAudioFile(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleAudioFileSelection = useCallback(
    async (file: File | null, source: "upload" | "recording") => {
      setRecordingError(null);
      if (!file) {
        clearAudioInput();
        return;
      }

      setProcessingAudio(true);
      try {
        const normalizedFile = await normalizeForumAudioFile(file, source);
        setAudioFile(normalizedFile);
      } catch (error) {
        console.error("No se pudo procesar el audio del comentario:", error);
        clearAudioInput();
        setRecordingError(
          error instanceof Error ? error.message : "No se pudo procesar el audio.",
        );
        toast.error(error instanceof Error ? error.message : "No se pudo procesar el audio.");
      } finally {
        setProcessingAudio(false);
      }
    },
    [],
  );

  const handleAudioRecording = async () => {
    if (recording) {
      recorderRef.current?.stop();
      return;
    }

    if (
      typeof navigator === "undefined" ||
      !navigator.mediaDevices?.getUserMedia ||
      typeof MediaRecorder === "undefined"
    ) {
      const message = "Tu navegador no permite grabar audio aquí.";
      setRecordingError(message);
      toast.error(message);
      return;
    }

    try {
      setRecordingError(null);
      chunksRef.current = [];
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const preferredMimeType = pickPreferredAudioRecordingMimeType();
      const recorder = preferredMimeType
        ? new MediaRecorder(stream, { mimeType: preferredMimeType })
        : new MediaRecorder(stream);
      recorderRef.current = recorder;

      recorder.addEventListener("dataavailable", (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      });

      recorder.addEventListener("stop", () => {
        stream.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
        setRecording(false);

        const recorderMimeType = recorder.mimeType || preferredMimeType || "audio/webm";
        const blob = new Blob(chunksRef.current, { type: recorderMimeType });
        chunksRef.current = [];
        if (blob.size <= 0) return;

        const extension = recorderMimeType.includes("mp4")
          ? "m4a"
          : recorderMimeType.includes("mpeg")
            ? "mp3"
            : "webm";
        const file = new File([blob], `comentario-${Date.now()}.${extension}`, {
          type: recorderMimeType,
        });
        void handleAudioFileSelection(file, "recording");
      });

      recorder.start();
      setRecording(true);
    } catch (error) {
      console.error("No se pudo grabar audio para el comentario:", error);
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      setRecording(false);
      const message = "No se pudo acceder al micrófono.";
      setRecordingError(message);
      toast.error(message);
    }
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    const value = text.trim();
    if ((!value && !audioFile) || !currentUser?.uid) return;

    setSending(true);
    try {
      let storedAudioUrl = "";
      let storedMediaMimeType = "";
      if (audioFile) {
        const storage = getStorage();
        const storageRef = ref(
          storage,
          `comments/${currentUser.uid}/${cls.id}/audio-${Date.now()}-${audioFile.name}`,
        );
        storedMediaMimeType = resolvePreferredContentTypeForMediaFile(
          audioFile,
          audioFile.type || "audio/wav",
        );
        await uploadBytes(storageRef, audioFile, {
          contentType: storedMediaMimeType,
          contentDisposition: "inline",
        });
        storedAudioUrl = await getDownloadURL(storageRef);
      }

      await addComment({
        cls,
        text: value,
        audioUrl: storedAudioUrl,
        mediaMimeType: storedMediaMimeType || null,
        format: storedAudioUrl ? "audio" : "text",
        authorId: currentUser.uid,
        authorName: currentUser.displayName ?? studentName ?? "Estudiante",
      });
      setText("");
      clearAudioInput();
      await refresh();
    } catch (err) {
      console.error("No se pudo guardar el comentario:", err);
      toast.error("No se pudo guardar el comentario");
    } finally {
      setSending(false);
    }
  };

  const roots = comments.filter((comment) => !comment.parentId);
  const repliesOf = (parentId: string) => comments.filter((c) => c.parentId === parentId);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {available ? (
        <>
          <form onSubmit={handleSubmit} className="flex flex-col gap-3 px-4 pb-4">
            <div className="flex items-center gap-2">
              <input
                value={text}
                onChange={(event) => setText(event.target.value)}
                placeholder="Escribe tu comentario o aporta con audio"
                className="flex-1 rounded-xl border border-[var(--aula-border)] bg-[var(--aula-bg)] px-3 py-2.5 text-sm text-[var(--aula-text)] outline-none placeholder:text-[var(--aula-text-muted)] focus:border-[var(--aula-accent)]"
              />
              <button
                type="submit"
                disabled={(!text.trim() && !audioFile) || sending || processingAudio}
                className="rounded-xl bg-[var(--aula-accent)] p-2.5 text-white disabled:opacity-40"
                aria-label="Enviar comentario"
              >
                {sending ? <Loader2 size={18} className="animate-spin" /> : <Send size={18} />}
              </button>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => void handleAudioRecording()}
                disabled={sending || processingAudio}
                className={`inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-xs ${
                  recording
                    ? "border-red-500/40 bg-red-500/10 text-red-300"
                    : "border-[var(--aula-border)] text-[var(--aula-text-muted)] hover:bg-white/5"
                } disabled:opacity-40`}
              >
                <Mic size={14} />
                {recording ? "Detener audio" : "Grabar audio"}
              </button>

              <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-[var(--aula-border)] px-3 py-2 text-xs text-[var(--aula-text-muted)] hover:bg-white/5">
                <Paperclip size={14} />
                Adjuntar audio
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="audio/*,audio/mp4,audio/x-m4a,.wav,.wave,.mp3,.m4a,.aac,.ogg,.oga,.flac,.opus,.weba,.mpeg"
                  onChange={(event) =>
                    void handleAudioFileSelection(event.target.files?.[0] ?? null, "upload")
                  }
                  className="hidden"
                />
              </label>

              {processingAudio ? (
                <span className="text-xs text-amber-300">Procesando audio…</span>
              ) : null}
              {recordingError ? (
                <span className="text-xs text-red-400">{recordingError}</span>
              ) : null}
            </div>
          </form>

          <PendingAudioPreview file={audioFile} onRemove={clearAudioInput} />
        </>
      ) : (
        <p className="px-4 pb-4 text-sm text-[var(--aula-text-muted)]">
          Esta clase no admite comentarios.
        </p>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
        {loading ? (
          <p className="text-sm text-[var(--aula-text-muted)]">Cargando comentarios…</p>
        ) : roots.length === 0 ? (
          <p className="text-sm text-[var(--aula-text-muted)]">
            Todavía no hay comentarios. Sé el primero en aportar.
          </p>
        ) : (
          <ul className="space-y-5">
            {roots.map((comment) => (
              <div key={comment.id} className="space-y-4">
                <CommentItem comment={comment} />
                {repliesOf(comment.id).map((reply) => (
                  <CommentItem key={reply.id} comment={reply} depth={1} />
                ))}
              </div>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
