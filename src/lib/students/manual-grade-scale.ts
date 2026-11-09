export type ManualGradeScaleEntry = {
  studentName: string;
  finalGrade: number | null;
  autoGrade: number | null;
  manualOverride: boolean;
};

type ScaleConfirmation = {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  tone: "warning";
};

export function getManualGradeScaleWarning(entry: ManualGradeScaleEntry): string | null {
  const grade = entry.finalGrade;
  if (!entry.manualOverride || typeof grade !== "number" || !Number.isFinite(grade) ||
    grade < 0 || grade > 10 || (grade === 0 &&
      !(typeof entry.autoGrade === "number" && Number.isFinite(entry.autoGrade) && entry.autoGrade >= 70))) return null;
  return `${grade}/100 es una calificación reprobatoria.` + (grade > 0
    ? ` Si querías registrar ${grade}/10, captura ${Math.round(grade * 100) / 10}/100.`
    : " Revisa la nota: el cálculo automático es aprobatorio.");
}

export async function confirmManualGradeScale(
  entries: ManualGradeScaleEntry[],
  ask: (context: ScaleConfirmation) => Promise<boolean>,
): Promise<boolean> {
  const suspicious = entries.filter(entry => getManualGradeScaleWarning(entry));
  if (suspicious.length === 0) return true;
  const details = suspicious.map(entry =>
    `${entry.studentName}: final manual ${entry.finalGrade}/100` +
    (typeof entry.autoGrade === "number" && Number.isFinite(entry.autoGrade) ? `, cálculo automático ${entry.autoGrade}/100` : ""),
  ).join("; ");
  return ask({
    title: "Revisa la escala de la calificación",
    message: `Las calificaciones finales se guardan de 0 a 100. ${details}. ` +
      "Estas notas se registrarán como reprobatorias. Si la nota es 10 sobre 10, captura 100; si es 9 sobre 10, captura 90. ¿Confirmas que las notas capturadas están sobre 100?",
    confirmLabel: suspicious.length === 1 ? `Confirmar ${suspicious[0].finalGrade}/100` : "Confirmar notas sobre 100",
    cancelLabel: "Revisar captura",
    tone: "warning",
  });
}
