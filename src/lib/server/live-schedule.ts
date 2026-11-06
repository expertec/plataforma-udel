import { FieldValue, type Firestore, type Transaction } from "firebase-admin/firestore";
import { normalizeLiveSession } from "@/lib/live-classes/types";
import { isUndergraduateProgram } from "@/lib/program-level";

export class LiveScheduleError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function courseIds(data: Record<string, unknown>): string[] {
  const courses = Array.isArray(data.courses) ? data.courses : [];
  return Array.from(new Set([
    data.courseId,
    ...(Array.isArray(data.courseIds) ? data.courseIds : []),
    ...courses.map((course) => course && typeof course === "object" ? course.courseId : null),
  ].filter((id): id is string => typeof id === "string" && !!id.trim()).map((id) => id.trim())));
}

function formatDate(value: string, timezone: string): string {
  try {
    return new Intl.DateTimeFormat("es-MX", {
      dateStyle: "short", timeStyle: "short", timeZone: timezone,
    }).format(new Date(value));
  } catch {
    return value;
  }
}

/** Check every undergraduate group that receives this course, across all its courses. */
export async function writeWithLiveScheduleCheck(params: {
  db: Firestore;
  courseId: string;
  classPath: string;
  liveSession: unknown;
  write: (transaction: Transaction) => void;
}): Promise<void> {
  const session = normalizeLiveSession(params.liveSession);
  await params.db.runTransaction(async (transaction) => {
    const groups = await transaction.get(params.db.collection("groups"));
    const affected = groups.docs.filter((group) => {
      const data = group.data();
      return data.status !== "archived" && data.status !== "finished" &&
        isUndergraduateProgram(typeof data.program === "string" ? data.program : "") &&
        courseIds(data).includes(params.courseId);
    });
    if (affected.length === 0 || !session || (session.status !== "scheduled" && session.status !== "live")) {
      params.write(transaction);
      return;
    }
    const start = session.scheduledStartAt ? Date.parse(session.scheduledStartAt) : NaN;
    const end = session.scheduledEndAt ? Date.parse(session.scheduledEndAt) : NaN;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      throw new LiveScheduleError(400, "Para programar clases de licenciatura, indica inicio y cierre válidos; el cierre debe ser posterior al inicio.");
    }
    const affectedCourses = new Set(affected.flatMap((group) => courseIds(group.data())));
    const lessons = await Promise.all(Array.from(affectedCourses, async (courseId) => ({
      courseId,
      snapshot: await transaction.get(params.db.collection("courses").doc(courseId).collection("lessons")),
    })));
    const classes = await Promise.all(lessons.flatMap(({ courseId, snapshot }) => snapshot.docs.map(async (lesson) => ({
      courseId,
      snapshot: await transaction.get(lesson.ref.collection("classes").where("type", "==", "live")),
    }))));
    for (const { courseId, snapshot } of classes) {
      for (const existing of snapshot.docs) {
        if (existing.ref.path === params.classPath) continue;
        const data = existing.data();
        const other = normalizeLiveSession(data.liveSession);
        if (!other || (other.status !== "scheduled" && other.status !== "live") || !other.scheduledStartAt) continue;
        const otherStart = Date.parse(other.scheduledStartAt);
        // Legacy sessions without a closing time reserve the interval until a closing time is supplied.
        const otherEnd = other.scheduledEndAt ? Date.parse(other.scheduledEndAt) : Infinity;
        if (!Number.isFinite(otherStart) || Number.isNaN(otherEnd) || !(start < otherEnd && otherStart < end)) continue;
        const group = affected.find((item) => courseIds(item.data()).includes(courseId))!;
        const groupName = String(group.data().groupName || group.id);
        const className = String(data.title || "Clase en vivo");
        const interval = `${formatDate(other.scheduledStartAt, session.timezone)}${other.scheduledEndAt ? ` a ${formatDate(other.scheduledEndAt, session.timezone)}` : " (sin cierre programado; define su hora de cierre)"}`;
        throw new LiveScheduleError(409, `El grupo ${groupName} ya tiene «${className}» de ${interval}. Elige otro horario para evitar el empalme.`);
      }
    }
    // All scheduling writers lock the same groups, so concurrent requests cannot reserve overlapping slots.
    affected.forEach((group) => transaction.update(group.ref, { liveScheduleVersion: FieldValue.increment(1) }));
    params.write(transaction);
  });
}
