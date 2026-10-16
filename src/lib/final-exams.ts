export const FINAL_EXAM_POINTS = 10;
export const FINAL_EXAM_OPEN_WEEK = 5;
export const OTHER_ACTIVITIES_POINTS = 90;

export type AssessmentKind = "regular" | "final";

export function finalExamBudgetError(hasFinalExam: boolean, finalPoints: number, otherPoints: number, manualFinalPoints: number | null): string | null {
  if (!hasFinalExam) return null;
  if (manualFinalPoints !== null && manualFinalPoints !== 0) return "El examen final ya se integra automáticamente; no agregues otro examen final manual.";
  if (finalPoints < 0 || finalPoints > FINAL_EXAM_POINTS + 0.001) return "El examen final no puede superar 10 puntos.";
  if (otherPoints > OTHER_ACTIVITIES_POINTS + 0.001) return "Las actividades distintas al examen final no pueden superar 90 puntos. Ajusta los puntajes antes de cerrar la materia.";
  return null;
}
export type FinalExamQuestion = {
  id: string;
  prompt: string;
  explanation?: string;
  type: "multiple" | "truefalse";
  pointValue: number;
  order: number;
  options: Array<{ id: string; text: string; isCorrect: boolean; feedback?: string; correctFeedback?: string; incorrectFeedback?: string }>;
};

export function distributeFinalExamPoints(weights: number[]): number[] {
  if (weights.length === 0 || weights.length > 200 || weights.some((weight) => !Number.isFinite(weight) || weight <= 0)) {
    throw new Error("El examen debe tener entre 1 y 200 reactivos con puntajes positivos.");
  }
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (!Number.isFinite(total)) throw new Error("La suma de los pesos es inválida.");
  const shares = weights.map((weight) => weight / total * FINAL_EXAM_POINTS * 100);
  const cents = shares.map(Math.floor);
  const remaining = FINAL_EXAM_POINTS * 100 - cents.reduce((sum, value) => sum + value, 0);
  const remainders = shares.map((share, index) => ({ index, remainder: share - cents[index] }))
    .sort((left, right) => right.remainder - left.remainder || left.index - right.index);
  for (let index = 0; index < remaining; index += 1) cents[remainders[index].index] += 1;
  if (cents.some((value) => value === 0)) throw new Error("Los pesos de los reactivos son demasiado distintos para distribuir 10 puntos.");
  return cents.map((value) => value / 100);
}

export function finalExamOpensAt(value: unknown): Date | null {
  let date: Date | null = null;
  if (value instanceof Date) date = value;
  else if (typeof value === "string") date = new Date(value);
  else if (value && typeof value === "object" && "toDate" in value && typeof value.toDate === "function") date = value.toDate();
  if (!date || !Number.isFinite(date.getTime())) return null;
  return new Date(date.getTime() + (FINAL_EXAM_OPEN_WEEK - 1) * 7 * 24 * 60 * 60 * 1000);
}
