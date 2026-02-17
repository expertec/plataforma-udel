import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  query,
  orderBy,
  serverTimestamp,
  setDoc,
} from "firebase/firestore";
import { db } from "./firestore";

const isValidDate = (value: Date): boolean => !Number.isNaN(value.getTime());

const normalizeDate = (value: unknown): Date => {
  if (value instanceof Date && isValidDate(value)) {
    return value;
  }

  if (value && typeof value === "object") {
    const timestampLike = value as {
      toDate?: () => Date;
      seconds?: number;
    };

    if (typeof timestampLike.toDate === "function") {
      const parsed = timestampLike.toDate();
      if (parsed instanceof Date && isValidDate(parsed)) {
        return parsed;
      }
    }

    if (typeof timestampLike.seconds === "number") {
      const parsed = new Date(timestampLike.seconds * 1000);
      if (isValidDate(parsed)) {
        return parsed;
      }
    }
  }

  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value);
    if (isValidDate(parsed)) {
      return parsed;
    }
  }

  return new Date();
};

const normalizeText = (value: unknown, fallback: string): string => {
  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (value && typeof value === "object") {
    const withCommonFields = value as {
      displayName?: unknown;
      name?: unknown;
      firstName?: unknown;
      lastName?: unknown;
    };

    if (typeof withCommonFields.displayName === "string") {
      return withCommonFields.displayName;
    }

    if (typeof withCommonFields.name === "string") {
      return withCommonFields.name;
    }

    if (
      typeof withCommonFields.firstName === "string" ||
      typeof withCommonFields.lastName === "string"
    ) {
      return `${typeof withCommonFields.firstName === "string" ? withCommonFields.firstName : ""} ${typeof withCommonFields.lastName === "string" ? withCommonFields.lastName : ""}`.trim();
    }
  }

  return fallback;
};

const normalizeFormat = (value: unknown): ForumPost["format"] => {
  if (value === "audio" || value === "video" || value === "text") {
    return value;
  }
  return "text";
};

const normalizeRole = (value: unknown): ForumReply["role"] => {
  if (value === "professor" || value === "student" || value === "mentor") {
    return value;
  }
  return undefined;
};

const normalizeNumber = (value: unknown, fallback = 0): number => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return fallback;
};

const normalizeOptionalString = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

/**
 * Aportación principal del foro (post raíz de cada estudiante)
 */
export type ForumPost = {
  id: string;
  text: string;
  authorId: string;
  authorName: string;
  format: "text" | "audio" | "video";
  mediaUrl?: string | null;
  createdAt: Date;
  repliesCount?: number;
  status?: "pending" | "graded";
  grade?: number;
  feedback?: string;
  gradedAt?: Date | null;
};

/**
 * Respuesta en hilo a una aportación del foro
 */
export type ForumReply = {
  id: string;
  postId: string; // ID de la aportación principal
  text: string;
  authorId: string;
  authorName: string;
  role?: "professor" | "student" | "mentor";
  createdAt: Date;
};

/**
 * Obtiene todas las aportaciones del foro de una clase (públicas)
 */
export async function getForumPosts(
  courseId: string,
  lessonId: string,
  classId: string
): Promise<ForumPost[]> {
  const forumsRef = collection(
    db,
    "courses",
    courseId,
    "lessons",
    lessonId,
    "classes",
    classId,
    "forums"
  );

  const q = query(forumsRef, orderBy("createdAt", "desc"));
  const snap = await getDocs(q);

  return snap.docs.map((doc) => {
    const data = doc.data();
    return {
      id: doc.id,
      text: normalizeText(data.text, ""),
      authorId: normalizeText(data.authorId, ""),
      authorName: normalizeText(data.authorName, "Usuario"),
      format: normalizeFormat(data.format),
      mediaUrl: normalizeOptionalString(data.mediaUrl),
      createdAt: normalizeDate(data.createdAt),
      repliesCount: normalizeNumber(data.repliesCount, 0),
      status: data.status ?? undefined,
      grade: typeof data.grade === "number" && Number.isFinite(data.grade) ? data.grade : undefined,
      feedback: normalizeText(data.feedback, ""),
      gradedAt: data.gradedAt ? normalizeDate(data.gradedAt) : null,
    };
  });
}

/**
 * Obtiene la aportación de un estudiante específico
 */
export async function getStudentForumPost(
  courseId: string,
  lessonId: string,
  classId: string,
  studentId: string
): Promise<ForumPost | null> {
  const postRef = doc(
    db,
    "courses",
    courseId,
    "lessons",
    lessonId,
    "classes",
    classId,
    "forums",
    studentId
  );

  const snap = await getDoc(postRef);
  if (!snap.exists()) return null;

  const data = snap.data();
  return {
    id: snap.id,
    text: normalizeText(data.text, ""),
    authorId: normalizeText(data.authorId, ""),
    authorName: normalizeText(data.authorName, "Usuario"),
    format: normalizeFormat(data.format),
    mediaUrl: normalizeOptionalString(data.mediaUrl),
    createdAt: normalizeDate(data.createdAt),
    repliesCount: normalizeNumber(data.repliesCount, 0),
    status: data.status ?? undefined,
    grade: typeof data.grade === "number" && Number.isFinite(data.grade) ? data.grade : undefined,
    feedback: normalizeText(data.feedback, ""),
    gradedAt: data.gradedAt ? normalizeDate(data.gradedAt) : null,
  };
}

/**
 * Crea o actualiza la aportación principal de un estudiante en el foro
 */
export async function createOrUpdateForumPost(params: {
  courseId: string;
  lessonId: string;
  classId: string;
  studentId: string;
  text: string;
  authorName: string;
  format: "text" | "audio" | "video";
  mediaUrl?: string | null;
}): Promise<void> {
  const { courseId, lessonId, classId, studentId, text, authorName, format, mediaUrl } = params;

  const postRef = doc(
    db,
    "courses",
    courseId,
    "lessons",
    lessonId,
    "classes",
    classId,
    "forums",
    studentId
  );

  const existingSnap = await getDoc(postRef);
  const existingRepliesCount = existingSnap.exists()
    ? (existingSnap.data()?.repliesCount ?? 0)
    : 0;
  if (existingSnap.exists()) {
    const data = existingSnap.data();
    const isGraded = data?.status === "graded"
      || typeof data?.grade === "number"
      || data?.gradedAt;
    if (isGraded) {
      throw new Error("FORUM_GRADED");
    }
  }

  await setDoc(postRef, {
    text: text.trim(),
    authorId: studentId,
    authorName: authorName,
    format: format,
    mediaUrl: mediaUrl ?? null,
    createdAt: serverTimestamp(),
    repliesCount: existingRepliesCount,
  }, { merge: true });
}

/**
 * Obtiene todas las respuestas de una aportación del foro
 */
export async function getForumReplies(
  courseId: string,
  lessonId: string,
  classId: string,
  postId: string
): Promise<ForumReply[]> {
  const repliesRef = collection(
    db,
    "courses",
    courseId,
    "lessons",
    lessonId,
    "classes",
    classId,
    "forums",
    postId,
    "replies"
  );

  const q = query(repliesRef, orderBy("createdAt", "asc"));
  const snap = await getDocs(q);

  return snap.docs.map((doc) => {
    const data = doc.data();
    return {
      id: doc.id,
      postId: postId,
      text: normalizeText(data.text, ""),
      authorId: normalizeText(data.authorId, ""),
      authorName: normalizeText(data.authorName, "Usuario"),
      role: normalizeRole(data.role),
      createdAt: normalizeDate(data.createdAt),
    };
  });
}

/**
 * Agrega una respuesta a una aportación del foro
 */
export async function addForumReply(params: {
  courseId: string;
  lessonId: string;
  classId: string;
  postId: string;
  text: string;
  authorId: string;
  authorName: string;
  role?: "professor" | "student" | "mentor";
}): Promise<string> {
  const { courseId, lessonId, classId, postId, text, authorId, authorName, role } = params;

  const repliesRef = collection(
    db,
    "courses",
    courseId,
    "lessons",
    lessonId,
    "classes",
    classId,
    "forums",
    postId,
    "replies"
  );

  const docRef = await addDoc(repliesRef, {
    text: text.trim(),
    authorId: authorId,
    authorName: authorName,
    role: role ?? "student",
    createdAt: serverTimestamp(),
  });

  // Incrementar contador de respuestas en el post principal
  const postRef = doc(
    db,
    "courses",
    courseId,
    "lessons",
    lessonId,
    "classes",
    classId,
    "forums",
    postId
  );

  const postSnap = await getDoc(postRef);
  if (postSnap.exists()) {
    const currentRepliesCount = postSnap.data()?.repliesCount ?? 0;
    await setDoc(
      postRef,
      {
        repliesCount: currentRepliesCount + 1,
      },
      { merge: true }
    );
  }

  return docRef.id;
}

/**
 * Elimina una respuesta del foro
 */
export async function deleteForumReply(
  courseId: string,
  lessonId: string,
  classId: string,
  postId: string,
  replyId: string
): Promise<void> {
  const replyRef = doc(
    db,
    "courses",
    courseId,
    "lessons",
    lessonId,
    "classes",
    classId,
    "forums",
    postId,
    "replies",
    replyId
  );

  await deleteDoc(replyRef);

  // Decrementar contador de respuestas en el post principal
  const postRef = doc(
    db,
    "courses",
    courseId,
    "lessons",
    lessonId,
    "classes",
    classId,
    "forums",
    postId
  );

  const postSnap = await getDoc(postRef);
  if (postSnap.exists()) {
    const currentRepliesCount = postSnap.data()?.repliesCount ?? 0;
    await setDoc(
      postRef,
      {
        repliesCount: Math.max(0, currentRepliesCount - 1),
      },
      { merge: true }
    );
  }
}

/**
 * Verifica si un estudiante ya tiene una aportación en el foro
 */
export async function hasStudentPosted(
  courseId: string,
  lessonId: string,
  classId: string,
  studentId: string
): Promise<boolean> {
  const postRef = doc(
    db,
    "courses",
    courseId,
    "lessons",
    lessonId,
    "classes",
    classId,
    "forums",
    studentId
  );

  const snap = await getDoc(postRef);
  return snap.exists();
}

/**
 * Obtiene el contador de respuestas de una aportación
 */
export async function getForumPostRepliesCount(
  courseId: string,
  lessonId: string,
  classId: string,
  postId: string
): Promise<number> {
  const postRef = doc(
    db,
    "courses",
    courseId,
    "lessons",
    lessonId,
    "classes",
    classId,
    "forums",
    postId
  );

  const snap = await getDoc(postRef);
  if (!snap.exists()) return 0;

  return snap.data()?.repliesCount ?? 0;
}

/**
 * Elimina la aportación principal de un estudiante si aún no está evaluada
 */
export async function deleteStudentForumPostIfNotEvaluated(params: {
  courseId: string;
  lessonId: string;
  classId: string;
  studentId: string;
}): Promise<void> {
  const { courseId, lessonId, classId, studentId } = params;

  const postRef = doc(
    db,
    "courses",
    courseId,
    "lessons",
    lessonId,
    "classes",
    classId,
    "forums",
    studentId
  );

  const postSnap = await getDoc(postRef);
  if (!postSnap.exists()) return;

  const data = postSnap.data();
  const isGraded = data?.status === "graded"
    || typeof data?.grade === "number"
    || data?.gradedAt;
  if (isGraded) {
    throw new Error("FORUM_GRADED");
  }

  const repliesRef = collection(
    db,
    "courses",
    courseId,
    "lessons",
    lessonId,
    "classes",
    classId,
    "forums",
    studentId,
    "replies"
  );
  const repliesSnap = await getDocs(repliesRef);
  await Promise.all(repliesSnap.docs.map((reply) => deleteDoc(reply.ref)));

  await deleteDoc(postRef);
}
