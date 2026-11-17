type LiveSchedule = {
  scheduledStartAt?: string | null;
  scheduledEndAt?: string | null;
};

/** Require explicit dates for every new or edited live schedule. */
export function getLiveScheduleError(session: LiveSchedule | null): string | null {
  const start = session?.scheduledStartAt ? Date.parse(session.scheduledStartAt) : NaN;
  const end = session?.scheduledEndAt ? Date.parse(session.scheduledEndAt) : NaN;
  if (!Number.isFinite(start)) return "Indica una fecha y hora de inicio válidas.";
  if (!Number.isFinite(end)) return "Indica una fecha y hora de finalización válidas.";
  if (end <= start) return "La fecha de finalización debe ser posterior al inicio.";
  return null;
}

/** Legacy schedules without an end reserve 60 minutes, without changing stored data. */
export function getEffectiveLiveEndAt(session: LiveSchedule | null): string | null {
  if (session?.scheduledEndAt) return session.scheduledEndAt;
  const start = session?.scheduledStartAt ? Date.parse(session.scheduledStartAt) : NaN;
  if (!Number.isFinite(start)) return null;
  const end = new Date(start + 60 * 60 * 1000);
  return Number.isFinite(end.getTime()) ? end.toISOString() : null;
}
