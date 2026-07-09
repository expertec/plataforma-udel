"use client";

import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Submission } from "@/lib/firebase/submissions-service";
import { formatForumPointValue, normalizeForumPointValue } from "@/lib/forum-grading";

type GradeModalProps = {
  submission: Submission;
  readonly?: boolean;
  onClose: () => void;
  onSave?: (grade: number, feedback: string) => Promise<void> | void;
};

export function GradeModal({ submission, readonly, onClose, onSave }: GradeModalProps) {
  const [grade, setGrade] = useState<number | undefined>(submission.grade ?? undefined);
  const [feedback, setFeedback] = useState(submission.feedback ?? "");
  const [saving, setSaving] = useState(false);
  const isForumSubmission = submission.classType === "forum";
  const gradeMax = isForumSubmission ? normalizeForumPointValue(submission.forumPointValue) : 100;
  const gradeLabel = `Calificación (0-${isForumSubmission ? formatForumPointValue(gradeMax) : gradeMax})`;
  const isGradeInvalid = grade == null || Number.isNaN(grade) || grade < 0 || grade > gradeMax;
  const isContentUrl =
    typeof submission.content === "string" &&
    /^https?:\/\//i.test(submission.content.trim());
  const normalizedFileUrl = (submission.fileUrl ?? "").trim();
  const normalizedAudioUrl = (submission.audioUrl ?? "").trim();
  const inferredAudioUrl = (() => {
    if (normalizedAudioUrl) return normalizedAudioUrl;
    if (!normalizedFileUrl) return "";
    const audioPattern = /\.(mp3|wav|wave|m4a|aac|ogg|oga|opus|flac|weba|webm)(?:$|[?#])/i;
    return audioPattern.test(normalizedFileUrl) ? normalizedFileUrl : "";
  })();
  const inferredVideoUrl = (() => {
    if (!normalizedFileUrl) return "";
    const videoPattern = /\.(mp4|mov|m4v|webm|ogv|avi|mkv)(?:$|[?#])/i;
    return !inferredAudioUrl && videoPattern.test(normalizedFileUrl) ? normalizedFileUrl : "";
  })();

  useEffect(() => {
    setGrade(submission.grade ?? undefined);
    setFeedback(submission.feedback ?? "");
  }, [submission]);

  const handleSave = async () => {
    if (isGradeInvalid || grade == null) return;
    if (!onSave) return;
    setSaving(true);
    try {
      await onSave(grade, feedback);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : null)}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Calificar entrega</DialogTitle>
        </DialogHeader>

        <div className="space-y-3 text-sm text-slate-700">
          <div>
            <p className="font-semibold">{submission.studentName}</p>
            <p className="text-xs text-slate-500">Alumno</p>
          </div>
          <div className="space-y-1">
            <p className="text-xs text-slate-500">Archivo</p>
            {inferredAudioUrl ? (
              <div className="space-y-2">
                <audio
                  controls
                  src={inferredAudioUrl}
                  className="w-full rounded-lg border border-slate-200 bg-slate-50 p-1"
                />
                <a
                  href={inferredAudioUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-blue-600 hover:underline break-all"
                >
                  Abrir audio
                </a>
              </div>
            ) : inferredVideoUrl ? (
              <div className="space-y-2">
                <video
                  controls
                  src={inferredVideoUrl}
                  className="w-full rounded-lg border border-slate-200 bg-slate-50"
                />
                <a
                  href={inferredVideoUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-blue-600 hover:underline break-all"
                >
                  Abrir video
                </a>
              </div>
            ) : submission.fileUrl ? (
              <a
                href={submission.fileUrl}
                target="_blank"
                rel="noreferrer"
                className="text-blue-600 hover:underline break-all"
              >
                Ver archivo
              </a>
            ) : (
              <p className="text-slate-500">Sin archivo</p>
            )}
          </div>
          {submission.audioUrl && !inferredAudioUrl ? (
            <div className="space-y-1">
              <p className="text-xs text-slate-500">Audio adjunto</p>
              <audio
                controls
                src={submission.audioUrl}
                className="w-full rounded-lg border border-slate-200 bg-slate-50 p-1"
              />
            </div>
          ) : null}
          {submission.content ? (
            <div className="space-y-1">
              <p className="text-xs text-slate-500">Contenido</p>
              {isContentUrl ? (
                <a
                  href={submission.content}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex w-fit items-center gap-2 rounded-lg bg-blue-600 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-blue-500"
                >
                  Descargar contenido
                </a>
              ) : (
                <p className="whitespace-pre-wrap rounded-md border border-slate-200 bg-slate-50 p-2">
                  {submission.content}
                </p>
              )}
            </div>
          ) : null}

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="text-xs font-medium text-slate-700">{gradeLabel}</label>
              <input
                type="number"
                min={0}
                max={gradeMax}
                value={grade ?? ""}
                disabled={readonly}
                onChange={(e) => setGrade(e.target.value ? Number(e.target.value) : undefined)}
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:bg-slate-50"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-slate-700">Estado</label>
              <p className="mt-1 text-sm font-semibold text-slate-800">
                {submission.status ?? "pending"}
              </p>
            </div>
          </div>

          <div>
            <label className="text-xs font-medium text-slate-700">Retroalimentación</label>
            <textarea
              value={feedback}
              disabled={readonly}
              onChange={(e) => setFeedback(e.target.value)}
              rows={3}
              className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:bg-slate-50"
            />
          </div>

          <div className="flex items-center justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Cerrar
            </button>
            {!readonly ? (
              <button
                type="button"
                disabled={saving || isGradeInvalid}
                onClick={handleSave}
                className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {saving ? "Guardando..." : "Guardar"}
              </button>
            ) : null}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
