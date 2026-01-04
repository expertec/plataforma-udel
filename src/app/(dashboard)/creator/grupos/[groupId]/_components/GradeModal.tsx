"use client";

import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Submission } from "@/lib/firebase/submissions-service";

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
  const isContentUrl =
    typeof submission.content === "string" &&
    /^https?:\/\//i.test(submission.content.trim());

  useEffect(() => {
    setGrade(submission.grade ?? undefined);
    setFeedback(submission.feedback ?? "");
  }, [submission]);

  const handleSave = async () => {
    if (grade == null || Number.isNaN(grade)) return;
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
            {submission.fileUrl ? (
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
              <label className="text-xs font-medium text-slate-700">Calificación</label>
              <input
                type="number"
                min={0}
                max={100}
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
                disabled={saving || grade == null || Number.isNaN(grade)}
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
