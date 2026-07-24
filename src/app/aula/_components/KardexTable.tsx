"use client";

import { Archive, Clock } from "lucide-react";
import { formatDate } from "../_lib/profile";
import type { KardexRow } from "../_lib/kardex";

function GradeBadge({ grade }: { grade: number | null }) {
  if (grade === null) {
    return <span className="text-[var(--aula-text-muted)]">—</span>;
  }
  return (
    <span className="font-semibold text-[var(--aula-text)]">
      {Number.isInteger(grade) ? grade : grade.toFixed(1)}
    </span>
  );
}

function GlobalExamBadge({
  grade,
  source,
}: {
  grade: number | null;
  source: KardexRow["globalExamSource"];
}) {
  if (grade === null) {
    return <span className="text-[var(--aula-text-muted)]">—</span>;
  }

  const formatted = Number.isInteger(grade) ? grade : grade.toFixed(1);
  return (
    <div className="flex flex-col items-end gap-1">
      <span className="font-semibold text-[var(--aula-text)]">{formatted}</span>
      {source === "regularization" ? (
        <span className="rounded-full bg-sky-500/15 px-2 py-0.5 text-[11px] font-medium text-sky-300">
          Regularizacion
        </span>
      ) : null}
    </div>
  );
}

export function KardexTable({ rows, loading }: { rows: KardexRow[]; loading: boolean }) {
  if (loading) {
    return <p className="text-[var(--aula-text-muted)]">Cargando tus calificaciones…</p>;
  }

  if (rows.length === 0) {
    return (
      <p className="text-[var(--aula-text-muted)]">
        Todavía no hay materias con calificación registrada.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto rounded-2xl border border-[var(--aula-border)] bg-[var(--aula-surface)]">
      <table className="w-full min-w-[760px] text-left text-sm">
        <thead className="border-b border-[var(--aula-border)] text-[var(--aula-text-muted)]">
          <tr>
            <th className="px-4 py-3 font-medium">Materia</th>
            <th className="px-4 py-3 font-medium">Grupo</th>
            <th className="px-4 py-3 font-medium">Estado</th>
            <th className="px-4 py-3 font-medium">Cierre</th>
            <th className="px-4 py-3 text-right font-medium">Examen global</th>
            <th className="px-4 py-3 text-right font-medium">Calificación final</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className="border-b border-[var(--aula-border)] last:border-0">
              <td className="px-4 py-3">
                <div className="flex items-center gap-2">
                  <span className="text-[var(--aula-text)]">{row.courseName}</span>
                  {row.archived && (
                    <span
                      title="Materia de un grupo anterior"
                      className="flex items-center gap-1 rounded-full bg-white/5 px-2 py-0.5 text-xs text-[var(--aula-text-muted)]"
                    >
                      <Archive size={11} />
                      Historial
                    </span>
                  )}
                </div>
              </td>
              <td className="px-4 py-3 text-[var(--aula-text-muted)]">{row.groupName}</td>
              <td className="px-4 py-3">
                {row.status === "closed" ? (
                  <span className="rounded-full bg-emerald-500/15 px-2.5 py-1 text-xs font-medium text-emerald-400">
                    Cerrada
                  </span>
                ) : (
                  <span className="flex w-fit items-center gap-1 rounded-full bg-amber-500/15 px-2.5 py-1 text-xs font-medium text-amber-300">
                    <Clock size={11} />
                    En curso
                  </span>
                )}
              </td>
              <td className="px-4 py-3 text-[var(--aula-text-muted)]">
                {row.status === "closed" ? formatDate(row.closedAt) : "—"}
              </td>
              <td className="px-4 py-3 text-right">
                <GlobalExamBadge grade={row.globalExamGrade} source={row.globalExamSource} />
              </td>
              <td className="px-4 py-3 text-right">
                {row.status === "closed" ? (
                  <GradeBadge grade={row.finalGrade} />
                ) : (
                  <span className="text-[var(--aula-text-muted)]">—</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
