import { normalizeLiveSession, type LiveClassSession } from "@/lib/live-classes/types";

export type StudentPreviewFeedItem = {
  id: string;
  classDocId?: string;
  title: string;
  type: string;
  courseId: string;
  courseTitle?: string;
  lessonId?: string;
  classTitle?: string;
  videoUrl?: string;
  audioUrl?: string;
  content?: string;
  images?: string[];
  hasAssignment?: boolean;
  assignmentTemplateUrl?: string;
  assignmentSubmissionType?: "file" | "audio";
  isClassroomActivity?: boolean;
  showInStudentPlatform?: boolean;
  lessonTitle?: string;
  lessonName?: string;
  likesCount?: number;
  forumEnabled?: boolean;
  forumRequiredFormat?: "text" | "audio" | "video" | null;
  liveSession?: LiveClassSession | null;
};

export type StudentPreviewSnapshot = {
  version: 1;
  courseId: string;
  courseTitle: string;
  savedAt: string;
  generatedByUid?: string;
  feed: StudentPreviewFeedItem[];
};

const STUDENT_PREVIEW_STORAGE_PREFIX = "studentPreviewCourse:";
export const STUDENT_PREVIEW_CACHE_MAX_AGE_MS = 15 * 60 * 1000;

const toTrimmedString = (value: unknown) => (typeof value === "string" ? value.trim() : "");

const toOptionalString = (value: unknown) => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
};

const toOptionalBoolean = (value: unknown) => {
  if (typeof value !== "boolean") return undefined;
  return value;
};

const toOptionalNumber = (value: unknown) => {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return value;
};

const toOptionalStringArray = (value: unknown) => {
  if (!Array.isArray(value)) return undefined;
  return value
    .map((item) => toTrimmedString(item))
    .filter(Boolean);
};

const normalizePreviewFeedItem = (value: unknown): StudentPreviewFeedItem | null => {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const id = toTrimmedString(raw.id);
  const title = toTrimmedString(raw.title);
  const type = toTrimmedString(raw.type);
  const courseId = toTrimmedString(raw.courseId);

  if (!id || !title || !type || !courseId) return null;

  const forumRequiredFormat = raw.forumRequiredFormat;
  const normalizedForumRequiredFormat =
    forumRequiredFormat === "text" ||
    forumRequiredFormat === "audio" ||
    forumRequiredFormat === "video"
      ? forumRequiredFormat
      : null;

  return {
    id,
    classDocId: toOptionalString(raw.classDocId),
    title,
    type,
    courseId,
    courseTitle: toOptionalString(raw.courseTitle),
    lessonId: toOptionalString(raw.lessonId),
    classTitle: toOptionalString(raw.classTitle),
    videoUrl: toOptionalString(raw.videoUrl),
    audioUrl: toOptionalString(raw.audioUrl),
    content: typeof raw.content === "string" ? raw.content : "",
    images: toOptionalStringArray(raw.images),
    hasAssignment: toOptionalBoolean(raw.hasAssignment),
    assignmentTemplateUrl: toOptionalString(raw.assignmentTemplateUrl),
    assignmentSubmissionType: raw.assignmentSubmissionType === "audio" ? "audio" : "file",
    isClassroomActivity: toOptionalBoolean(raw.isClassroomActivity),
    showInStudentPlatform: toOptionalBoolean(raw.showInStudentPlatform),
    lessonTitle: toOptionalString(raw.lessonTitle),
    lessonName: toOptionalString(raw.lessonName),
    likesCount: toOptionalNumber(raw.likesCount),
    forumEnabled: toOptionalBoolean(raw.forumEnabled),
    forumRequiredFormat: normalizedForumRequiredFormat,
    liveSession: normalizeLiveSession(raw.liveSession),
  };
};

const buildPreviewStorageKey = (courseId: string) =>
  `${STUDENT_PREVIEW_STORAGE_PREFIX}${courseId.trim()}`;

export function saveStudentPreviewSnapshot(snapshot: StudentPreviewSnapshot) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(buildPreviewStorageKey(snapshot.courseId), JSON.stringify(snapshot));
  } catch {
    // Ignorar si el navegador bloquea almacenamiento local.
  }
}

export function loadStudentPreviewSnapshot(
  courseId: string,
  maxAgeMs: number = STUDENT_PREVIEW_CACHE_MAX_AGE_MS,
): StudentPreviewSnapshot | null {
  if (typeof window === "undefined") return null;

  const normalizedCourseId = courseId.trim();
  if (!normalizedCourseId) return null;

  try {
    const raw = window.localStorage.getItem(buildPreviewStorageKey(normalizedCourseId));
    if (!raw) return null;

    const parsed = JSON.parse(raw) as Partial<StudentPreviewSnapshot>;
    if (parsed?.version !== 1) return null;
    if (toTrimmedString(parsed.courseId) !== normalizedCourseId) return null;

    const savedAt = toTrimmedString(parsed.savedAt);
    const savedAtMs = Date.parse(savedAt);
    if (!savedAt || !Number.isFinite(savedAtMs) || Date.now() - savedAtMs > maxAgeMs) {
      window.localStorage.removeItem(buildPreviewStorageKey(normalizedCourseId));
      return null;
    }

    const courseTitle = toTrimmedString(parsed.courseTitle) || "Curso";
    const feed = Array.isArray(parsed.feed)
      ? parsed.feed.map(normalizePreviewFeedItem).filter((item): item is StudentPreviewFeedItem => Boolean(item))
      : [];

    if (!feed.length) return null;

    return {
      version: 1,
      courseId: normalizedCourseId,
      courseTitle,
      savedAt,
      generatedByUid: toOptionalString(parsed.generatedByUid),
      feed,
    };
  } catch {
    return null;
  }
}
