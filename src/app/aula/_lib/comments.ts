import { addDoc, collection, getDocs, orderBy, query, serverTimestamp } from "firebase/firestore";
import { db } from "@/lib/firebase/firestore";
import type { FeedClass } from "./types";

export type AulaComment = {
  id: string;
  author: string;
  authorId: string;
  text: string;
  audioUrl?: string;
  mediaMimeType?: string | null;
  format?: "text" | "audio";
  createdAt: number;
  parentId: string | null;
  role?: "student" | "professor";
};

const commentsCollection = (cls: FeedClass) =>
  collection(
    db,
    "courses",
    cls.courseId!,
    "lessons",
    cls.lessonId!,
    "classes",
    cls.classDocId!,
    "comments",
  );

export const hasCommentsPath = (cls: FeedClass) =>
  Boolean(cls.courseId && cls.lessonId && cls.classDocId);

export const loadComments = async (cls: FeedClass): Promise<AulaComment[]> => {
  if (!hasCommentsPath(cls)) return [];
  const snap = await getDocs(query(commentsCollection(cls), orderBy("createdAt", "desc")));
  return snap.docs.map((d) => {
    const c = d.data();
    const role = (c.role ?? c.authorRole ?? null) as string | null;
    const author = (c.authorName ?? "").toString().trim();
    return {
      id: d.id,
      author: author && !/^alumno$/i.test(author) ? author : "Estudiante",
      authorId: c.authorId ?? "",
      text: c.text ?? "",
      audioUrl: typeof c.audioUrl === "string" ? c.audioUrl : "",
      mediaMimeType: typeof c.mediaMimeType === "string" ? c.mediaMimeType : null,
      format:
        c.format === "audio" || (typeof c.audioUrl === "string" && c.audioUrl.trim().length > 0)
          ? "audio"
          : "text",
      createdAt: (c.createdAt?.toMillis?.() ?? c.createdAt ?? Date.now()) as number,
      parentId: c.parentId ?? null,
      role: role === "professor" ? "professor" : role === "student" ? "student" : undefined,
    };
  });
};

export const addComment = async (params: {
  cls: FeedClass;
  text: string;
  authorId: string;
  authorName: string;
  audioUrl?: string;
  mediaMimeType?: string | null;
  format?: "text" | "audio";
  parentId?: string | null;
}) => {
  const { cls, text, authorId, authorName, audioUrl, mediaMimeType, format, parentId } = params;
  if (!hasCommentsPath(cls)) throw new Error("La clase no tiene ruta de comentarios");
  await addDoc(commentsCollection(cls), {
    text,
    audioUrl: audioUrl ?? "",
    mediaMimeType: mediaMimeType ?? null,
    format: format === "audio" ? "audio" : "text",
    authorId,
    authorName,
    parentId: parentId ?? null,
    createdAt: serverTimestamp(),
    role: "student",
  });
};

export const formatRelativeTime = (timestamp: number) => {
  const diffSeconds = Math.max(1, Math.floor((Date.now() - timestamp) / 1000));
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["year", 31536000],
    ["month", 2592000],
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
    ["second", 1],
  ];
  const formatter = new Intl.RelativeTimeFormat("es", { numeric: "auto" });
  for (const [unit, seconds] of units) {
    if (diffSeconds >= seconds) {
      return formatter.format(-Math.floor(diffSeconds / seconds), unit);
    }
  }
  return "hace un momento";
};
