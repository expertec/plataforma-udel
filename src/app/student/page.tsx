"use client";

import React, { useEffect, useRef, useState, useCallback, useMemo } from "react";
import Player from "@vimeo/player";
import { auth } from "@/lib/firebase/client";
import { onAuthStateChanged, User } from "firebase/auth";
import toast from "react-hot-toast";
import { getStorage, ref, uploadBytes, getDownloadURL } from "firebase/storage";
import {
  collection,
  collectionGroup,
  doc,
  getDoc,
  getDocs,
  addDoc,
  limit,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  where,
  updateDoc,
} from "firebase/firestore";
import { db } from "@/lib/firebase/firestore";
import { createSubmission } from "@/lib/firebase/submissions-service";

type FeedClass = {
  id: string;
  classDocId?: string;
  title: string;
  type: string;
  courseId?: string;
  courseTitle?: string;
  lessonId?: string;
  enrollmentId?: string;
  groupId?: string;
  classTitle?: string;
  videoUrl?: string;
  audioUrl?: string;
  content?: string;
  images?: string[];
  hasAssignment?: boolean;
  assignmentTemplateUrl?: string;
  lessonTitle?: string;
  lessonName?: string;
  likesCount?: number;
};

const VIDEO_COMPLETION_THRESHOLD = 80;
const ENFORCE_VIDEO_GATE = true;
const getRequiredPct = (type?: string) => (type === "image" ? 100 : VIDEO_COMPLETION_THRESHOLD);
const localProgressKey = (uid: string) => `classProgress:${uid}`;
const UNIVERSITY_LOGO_SRC = "/university-logo.jpg";

// Normaliza los tipos de clase para evitar variantes como "texto" o "imagen"
const normalizeClassType = (rawType: unknown) => {
  const value = (rawType ?? "").toString().trim().toLowerCase();
  if (!value) return "video";
  if (["text", "texto", "article", "document", "doc"].includes(value)) return "text";
  if (["image", "imagen", "photo", "foto", "picture", "gallery"].includes(value)) return "image";
  if (["audio", "podcast", "sonido"].includes(value)) return "audio";
  if (["quiz", "test", "assessment", "examen"].includes(value)) return "quiz";
  return value;
};

const loadLocalProgress = (uid: string) => {
  if (typeof window === "undefined") return { progress: {}, completed: {}, seen: {} };
  try {
    const raw = localStorage.getItem(localProgressKey(uid));
    if (!raw) return { progress: {}, completed: {}, seen: {} };
    const parsed = JSON.parse(raw);
    return {
      progress: parsed.progress ?? {},
      completed: parsed.completed ?? {},
      seen: parsed.seen ?? {},
    } as { progress: Record<string, number>; completed: Record<string, boolean>; seen: Record<string, boolean> };
  } catch {
    return { progress: {}, completed: {}, seen: {} };
  }
};

const saveLocalProgress = (
  uid: string,
  data: { progress: Record<string, number>; completed: Record<string, boolean>; seen: Record<string, boolean> },
) => {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(localProgressKey(uid), JSON.stringify(data));
  } catch {
    // Si falla localStorage (p. ej. modo incógnito), simplemente ignoramos.
  }
};

export default function StudentFeedPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [classes, setClasses] = useState<FeedClass[]>([]);
  const [courseName, setCourseName] = useState("");
  const [groupName, setGroupName] = useState("");
  const [groupId, setGroupId] = useState<string | null>(null);
  const [studentName, setStudentName] = useState<string>("");
  const [unmutedId, setUnmutedId] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [currentUser, setCurrentUser] = useState<User | null>(auth.currentUser);
  const [authLoading, setAuthLoading] = useState(!auth.currentUser);
  const [activeIndex, setActiveIndex] = useState(0);
  const sectionRefs = useRef<Record<string, HTMLElement | null>>({});
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [progressMap, setProgressMap] = useState<Record<string, number>>({});
  const [assignmentModal, setAssignmentModal] = useState<{
    open: boolean;
    classId?: string;
    templateUrl?: string;
    nextIndex?: number;
  }>({ open: false });
  const [assignmentAck, setAssignmentAck] = useState<Record<string, boolean>>({});
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [commentsClassId, setCommentsClassId] = useState<string | null>(null);
  const [commentsMap, setCommentsMap] = useState<Record<string, CommentsPanelComment[]>>({});
  const [commentsCountMap, setCommentsCountMap] = useState<Record<string, number>>({});
  const [descriptionExpanded, setDescriptionExpanded] = useState<Record<string, boolean>>({});
  const [assignmentPanel, setAssignmentPanel] = useState<{ open: boolean; classId?: string | null }>({ open: false });
  const [assignmentNoteMap, setAssignmentNoteMap] = useState<Record<string, string>>({});
  const [assignmentFileMap, setAssignmentFileMap] = useState<Record<string, File | null>>({});
  const [assignmentUploadingMap, setAssignmentUploadingMap] = useState<Record<string, boolean>>({});
  const [assignmentStatusMap, setAssignmentStatusMap] = useState<Record<string, "submitted">>({});
  const authorNameCacheRef = useRef<Record<string, string>>({});
  const lastActiveRef = useRef<number>(0);
  const activeIdRef = useRef<string | null>(null);
  const progressRef = useRef<Record<string, number>>({});
  const assignmentAckRef = useRef<Record<string, boolean>>({});
  const [enrollmentId, setEnrollmentId] = useState<string | null>(null);

  const videosRef = useRef<Record<string, HTMLVideoElement | null>>({});
  const [completedMap, setCompletedMap] = useState<Record<string, boolean>>({});
  const completedRef = useRef<Record<string, boolean>>({});
  const [seenMap, setSeenMap] = useState<Record<string, boolean>>({});
  const seenRef = useRef<Record<string, boolean>>({});
  const [imageIndexMap, setImageIndexMap] = useState<Record<string, number>>({});
  const imageIndexRef = useRef<Record<string, number>>({});
  const initialPositionedRef = useRef(false);
  const [progressReady, setProgressReady] = useState(false);
  const [autoReposition, setAutoReposition] = useState(false);
  const lastPendingRef = useRef<number | null>(null);
  const [collapsedLessons, setCollapsedLessons] = useState<Record<string, boolean>>({});
  const wheelLockRef = useRef(false);
  const wheelAccumRef = useRef(0);
  const wheelTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const gateToastRef = useRef<{ classId: string | null; ts: number }>({ classId: null, ts: 0 });
  const [courseTitleMap, setCourseTitleMap] = useState<Record<string, string>>({});
  const [likesMap, setLikesMap] = useState<Record<string, number>>({});
  const [likedMap, setLikedMap] = useState<Record<string, boolean>>({});
  const [likePendingMap, setLikePendingMap] = useState<Record<string, boolean>>({});
  const [loadingCommentsMap, setLoadingCommentsMap] = useState<Record<string, boolean>>({});

  const getPrevSameCourse = useCallback(
    (targetIdx: number) => {
      const target = classes[targetIdx];
      if (!target || !target.courseId) return null;
      for (let i = targetIdx - 1; i >= 0; i -= 1) {
        if (classes[i]?.courseId === target.courseId) return classes[i];
      }
      return null;
    },
    [classes],
  );

  const activeClass = classes[activeIndex];
  const activeImagesCount =
    activeClass?.type === "image" && activeClass.images ? activeClass.images.length : 0;
  const activeImageIdx = activeClass?.id ? imageIndexMap[activeClass.id] ?? 0 : 0;
  const hasPendingImages = activeImagesCount > 0 && activeImageIdx < activeImagesCount - 1;
  const findClassById = useCallback(
    (id: string | null | undefined) => classes.find((c) => c.id === id) ?? null,
    [classes],
  );

  useEffect(() => {
    if (activeClass?.type === "image" && activeClass.id && imageIndexMap[activeClass.id] === undefined) {
      imageIndexRef.current[activeClass.id] = 0;
      setImageIndexMap((prev) => ({ ...prev, [activeClass.id]: 0 }));
    }
  }, [activeClass?.id, activeClass?.type, imageIndexMap]);

  const courseThreads = useMemo(() => {
    const courseMap = new Map<
      string,
      {
        courseId: string;
        courseTitle: string;
        lessons: Map<
          string,
          { lessonId: string; lessonTitle: string; items: Array<{ id: string; title: string; index: number; type: string }> }
        >;
      }
    >();
    classes.forEach((cls, idx) => {
      const cId = cls.courseId ?? "sin-curso";
      const cTitle = courseTitleMap[cls.courseId ?? ""] || cls.courseTitle || courseName || "Curso";
      if (!courseMap.has(cId)) {
        courseMap.set(cId, { courseId: cId, courseTitle: cTitle, lessons: new Map() });
      }
      const courseEntry = courseMap.get(cId)!;
      const lId = `${cId}-${cls.lessonId ?? cls.lessonTitle ?? "leccion"}`;
      const lTitle = cls.lessonName ?? cls.lessonTitle ?? "Lección";
      if (!courseEntry.lessons.has(lId)) {
        courseEntry.lessons.set(lId, { lessonId: lId, lessonTitle: lTitle, items: [] });
      }
      courseEntry.lessons.get(lId)?.items.push({
        id: cls.id,
        title: cls.title,
        index: idx,
        type: cls.type,
      });
    });
    return Array.from(courseMap.values()).map((c) => ({
      ...c,
      lessons: Array.from(c.lessons.values()),
    }));
  }, [classes, courseTitleMap]);

  // Colapsar lecciones por defecto y mantener abierta la lección activa
  useEffect(() => {
    const lessonsFlat = courseThreads.flatMap((c) => c.lessons);
    if (!lessonsFlat.length) return;

    const classComplete = (item: { id: string; type: string }) => {
      const pct = Math.max(
        progressMap[item.id] ?? 0,
        completedMap[item.id] || seenMap[item.id] ? 100 : 0,
      );
      return pct >= getRequiredPct(item.type);
    };

    const activeLesson = classes.find((c) => c.id === activeId);
    const activeLessonKey =
      activeLesson?.courseId && activeLesson?.lessonId
        ? `${activeLesson.courseId}-${activeLesson.lessonId}`
        : lessonsFlat[0]?.lessonId;
    const firstPending = classes.find((c) => {
      const pct = Math.max(
        progressMap[c.id] ?? 0,
        completedMap[c.id] || seenMap[c.id] ? 100 : 0,
      );
      return pct < getRequiredPct(c.type);
    });
    const pendingLessonKey =
      firstPending && firstPending.courseId
        ? `${firstPending.courseId}-${firstPending.lessonId ?? firstPending.lessonTitle}`
        : activeLessonKey;

    const nextCollapsed: Record<string, boolean> = {};
    lessonsFlat.forEach((lesson) => {
      const allDone = lesson.items.every((it) => classComplete(it));
      const shouldOpen =
        lesson.lessonId === activeLessonKey || lesson.lessonId === pendingLessonKey;
      nextCollapsed[lesson.lessonId] = shouldOpen ? false : allDone ? true : true;
    });

    setCollapsedLessons(nextCollapsed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, classes.length, courseThreads.length, progressMap, completedMap, seenMap]);

  const saveSeenForUser = useCallback(
    async (classId: string, progress: number, completed: boolean) => {
      if (!currentUser?.uid) return;
      try {
        const seenDoc = doc(db, "users", currentUser.uid, "seenClasses", classId);
        await setDoc(
          seenDoc,
          {
            seen: completed || progress >= VIDEO_COMPLETION_THRESHOLD,
            progress: Math.max(progress, completed ? 100 : progress),
            updatedAt: new Date(),
          },
          { merge: true },
        );
      } catch (err: any) {
        // Evitar spam de permisos faltantes
        if (err?.code !== "permission-denied") {
          console.warn("No se pudo guardar seenClasses; se continuará solo con enrollment/local:", err);
        }
      }
    },
    [currentUser?.uid],
  );

  // Función para guardar progreso en Firestore
  const saveProgressToFirestore = useCallback(
    async (classId: string, progress: number, previousProgress: number, requiredPct: number) => {
      if (!currentUser?.uid || !enrollmentId) return;

      try {
        const progressDoc = doc(db, "studentEnrollments", enrollmentId, "classProgress", classId);
        const newProgress = Math.max(progress, previousProgress);
        const completed = newProgress >= requiredPct;
        const justCompleted = previousProgress < requiredPct && completed;
        if (justCompleted) {
          completedRef.current[classId] = true;
          setCompletedMap((prev) => ({ ...prev, [classId]: true }));
          seenRef.current[classId] = true;
          setSeenMap((prev) => ({ ...prev, [classId]: true }));
        }
        const storedProgress = completed ? Math.max(newProgress, 100) : newProgress;
        await setDoc(
          progressDoc,
          {
            progress: storedProgress, // Guardar el máximo progreso alcanzado
            lastUpdated: new Date(),
            completed,
            seen: completed || seenRef.current[classId] === true,
            ...(justCompleted ? { completedAt: new Date() } : {}),
          },
          { merge: true },
        );
        const local = loadLocalProgress(currentUser.uid);
        const mergedProgress = { ...local.progress, [classId]: storedProgress };
        const mergedCompleted = {
          ...local.completed,
          [classId]: completedRef.current[classId] ?? completed,
        };
        const mergedSeen = {
          ...local.seen,
          [classId]: seenRef.current[classId] ?? completed,
        };
        saveLocalProgress(currentUser.uid, {
          progress: mergedProgress,
          completed: mergedCompleted,
          seen: mergedSeen,
        });
        await saveSeenForUser(classId, storedProgress, completed || justCompleted);
      } catch (error) {
        console.error("Error guardando progreso:", error);
      }
    },
    [currentUser?.uid, enrollmentId, saveSeenForUser],
  );

  // Función para cargar progreso desde Firestore
  const loadProgressFromFirestore = async (enrollId: string) => {
    if (!currentUser?.uid) return;

    try {
      const local = loadLocalProgress(currentUser.uid);
      const progressSnap = await getDocs(
        collection(db, "studentEnrollments", enrollId, "classProgress")
      );
      let userSeenDocs: Array<{ id: string; data: () => any }> = [];
      try {
        const snap = await getDocs(collection(db, "users", currentUser.uid, "seenClasses"));
        userSeenDocs = snap.docs.map((d) => ({ id: d.id, data: () => d.data() }));
      } catch (err) {
        console.warn("No se pudo leer seenClasses, continuaré solo con enrollment/local:", err);
      }

      const loadedProgress: Record<string, number> = { ...local.progress };
      const loadedCompleted: Record<string, boolean> = { ...local.completed };
      const loadedSeen: Record<string, boolean> = { ...local.seen };

      userSeenDocs.forEach((docSeen) => {
        const data = docSeen.data();
        const seen = Boolean(data.seen);
        const progress = data.progress ?? 0;
        loadedSeen[docSeen.id] = loadedSeen[docSeen.id] || seen;
        loadedCompleted[docSeen.id] =
          loadedCompleted[docSeen.id] || seen || (progress ?? 0) >= VIDEO_COMPLETION_THRESHOLD;
        if (seen) {
          loadedProgress[docSeen.id] = Math.max(
            loadedProgress[docSeen.id] ?? 0,
            progress ?? 0,
            100,
          );
        }
      });
      progressSnap.forEach((doc) => {
        const data = doc.data();
        const completed = Boolean(data.completed);
        const seen = Boolean(data.seen) || completed;
        const progress = data.progress ?? 0;
        const mergedSeen = seen || loadedSeen[doc.id] || progress >= VIDEO_COMPLETION_THRESHOLD;
        const mergedCompleted = completed || loadedCompleted[doc.id] || mergedSeen;
        const mergedProgress = mergedSeen
          ? Math.max(100, loadedProgress[doc.id] ?? 0)
          : Math.max(progress ?? 0, loadedProgress[doc.id] ?? 0);
        loadedCompleted[doc.id] = mergedCompleted;
        loadedSeen[doc.id] = mergedSeen;
        loadedProgress[doc.id] = mergedProgress;
      });

      setProgressMap(loadedProgress);
      progressRef.current = loadedProgress;
      setCompletedMap(loadedCompleted);
      completedRef.current = loadedCompleted;
      setSeenMap(loadedSeen);
      seenRef.current = loadedSeen;
      saveLocalProgress(currentUser.uid, { progress: loadedProgress, completed: loadedCompleted, seen: loadedSeen });
      setProgressReady(true);
    } catch (error) {
      console.error("Error cargando progreso:", error);
      setProgressReady(true);
    }
  };

  const handleToggleLike = useCallback(
    async (cls: FeedClass) => {
      if (!currentUser?.uid) {
        toast.error("Inicia sesión para dar like.");
        return;
      }
      if (!cls.courseId || !cls.lessonId || !cls.classDocId) {
        toast.error("No se pudo identificar la clase.");
        return;
      }
      const classId = cls.id;
      if (likePendingMap[classId]) return;
      const wasLiked = likedMap[classId] ?? false;
      const delta = wasLiked ? -1 : 1;

      setLikePendingMap((prev) => ({ ...prev, [classId]: true }));
      setLikedMap((prev) => ({ ...prev, [classId]: !wasLiked }));
      setLikesMap((prev) => ({
        ...prev,
        [classId]: Math.max(0, (prev[classId] ?? 0) + delta),
      }));

      try {
        const result = await runTransaction(db, async (tx) => {
          const classRef = doc(
            db,
            "courses",
            cls.courseId!,
            "lessons",
            cls.lessonId!,
            "classes",
            cls.classDocId!,
          );
          const likeRef = doc(
            db,
            "courses",
            cls.courseId!,
            "lessons",
            cls.lessonId!,
            "classes",
            cls.classDocId!,
            "likes",
            currentUser.uid,
          );
          const likeSnap = await tx.get(likeRef);
          const classSnap = await tx.get(classRef);
          const alreadyLiked = likeSnap.exists();
          const currentCount = (classSnap.data()?.likesCount ?? 0) as number;
          const nextCount = Math.max(0, currentCount + (alreadyLiked ? -1 : 1));

          tx.set(classRef, { likesCount: nextCount }, { merge: true });
          if (alreadyLiked) {
            tx.delete(likeRef);
          } else {
            tx.set(
              likeRef,
              { likedAt: serverTimestamp(), userId: currentUser.uid },
              { merge: true },
            );
          }
          return { nextLiked: !alreadyLiked, nextCount };
        });

        setLikedMap((prev) => ({ ...prev, [classId]: result.nextLiked }));
        setLikesMap((prev) => ({ ...prev, [classId]: result.nextCount }));
      } catch (err) {
        console.error("No se pudo actualizar el like:", err);
        setLikedMap((prev) => ({ ...prev, [classId]: wasLiked }));
        setLikesMap((prev) => ({
          ...prev,
          [classId]: Math.max(0, (prev[classId] ?? 0) - delta),
        }));
        toast.error("No se pudo actualizar el like");
      } finally {
        setLikePendingMap((prev) => ({ ...prev, [classId]: false }));
      }
    },
    [currentUser?.uid, likePendingMap, likedMap],
  );

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      setCurrentUser(u);
      setAuthLoading(false);
    });
    return unsub;
  }, []);

  useEffect(() => {
    const handleOpenComments = () => {
      const targetId = activeIdRef.current ?? classes[activeIndex]?.id ?? null;
      if (!targetId) return;
      setCommentsClassId(targetId);
      setCommentsOpen(true);
    };
    window.addEventListener("open-comments", handleOpenComments);
    return () => window.removeEventListener("open-comments", handleOpenComments);
  }, [activeIndex, classes]);

  const loadCommentsForClass = useCallback(
    async (classId: string) => {
      const meta = findClassById(classId);
      if (!meta?.courseId || !meta?.lessonId || !meta?.classDocId) return;
      setLoadingCommentsMap((prev) => ({ ...prev, [classId]: true }));
      const normalizeAuthor = (name: unknown, authorId: string) => {
        const raw = (name ?? "").toString().trim();
        if (!raw || /^alumno$/i.test(raw)) {
          if (currentUser?.uid && authorId === currentUser.uid) {
            return (currentUser.displayName ?? studentName ?? "").trim() || "Estudiante";
          }
          return "Estudiante";
        }
        return raw;
      };
      try {
        const snap = await getDocs(
          query(
            collection(
              db,
              "courses",
              meta.courseId,
              "lessons",
              meta.lessonId,
              "classes",
              meta.classDocId,
              "comments",
            ),
            orderBy("createdAt", "desc"),
          ),
        );
        const data: CommentsPanelComment[] = snap.docs.map((d): CommentsPanelComment => {
          const c = d.data();
          const role = (c.role ?? c.authorRole ?? null) as string | null;
          const rawAuthor = normalizeAuthor(c.authorName, c.authorId ?? "");
          return {
            id: d.id,
            author: rawAuthor,
            authorId: c.authorId ?? "",
            text: c.text ?? "",
            createdAt: (c.createdAt?.toMillis?.() ?? c.createdAt ?? Date.now()) as number,
            parentId: c.parentId ?? null,
            role: role === "professor" ? "professor" : role === "student" ? "student" : undefined,
          };
        });
        // Enriquecer nombres faltantes desde users/{uid}
        const missingIds = Array.from(
          new Set(
            data
              .filter(
                (d) =>
                  d.authorId &&
                  (
                    !d.author ||
                    /^profesor$/i.test(d.author) ||
                    /^estudiante$/i.test(d.author) ||
                    (d.role === "professor" && !authorNameCacheRef.current[d.authorId])
                  ),
              )
              .map((d) => d.authorId || ""),
          ),
        ).filter((id): id is string => !!id && !authorNameCacheRef.current[id]);

        if (missingIds.length) {
          await Promise.all(
            missingIds.map(async (uid) => {
              try {
                const snapUser = await getDoc(doc(db, "users", uid));
                const name = (snapUser.data()?.name ?? snapUser.data()?.displayName ?? "") as string;
                if (name) {
                  authorNameCacheRef.current[uid] = name;
                }
              } catch {
                // ignoramos fallos silenciosamente
              }
            }),
          );
        }

        const withNames: CommentsPanelComment[] = data.map((d) => {
          const cached = authorNameCacheRef.current[d.authorId ?? ""];
          if (cached) return { ...d, author: cached };
          if (d.role === "professor" && !/^profesor$/i.test(d.author ?? "")) return d;
          return d;
        });
        setCommentsMap((prev) => ({ ...prev, [classId]: withNames }));
        setCommentsCountMap((prev) => ({ ...prev, [classId]: withNames.length }));
      } catch (err) {
        console.error("No se pudieron cargar comentarios:", err);
        toast.error("No se pudieron cargar los comentarios");
      } finally {
        setLoadingCommentsMap((prev) => ({ ...prev, [classId]: false }));
      }
    },
    [findClassById, currentUser, studentName],
  );

  useEffect(() => {
    if (commentsOpen && commentsClassId) {
      loadCommentsForClass(commentsClassId);
    }
  }, [commentsOpen, commentsClassId, loadCommentsForClass]);

  // Cargar estado de tarea enviada cuando se abre el panel de tarea
  useEffect(() => {
    const loadAssignmentStatus = async () => {
      if (!assignmentPanel.open || !assignmentPanel.classId) return;
      if (!currentUser?.uid) return;
      const cls = findClassById(assignmentPanel.classId);
      if (!cls?.groupId) return;
      const baseClassId = cls.classDocId ?? cls.id;
      try {
        const subRef = collection(db, "groups", cls.groupId, "submissions");
        const existing = await getDocs(
          query(
            subRef,
            where("classId", "==", baseClassId),
            where("studentId", "==", currentUser.uid),
            limit(1),
          ),
        );
        if (!existing.empty) {
          setAssignmentStatusMap((prev) => ({ ...prev, [cls.id]: "submitted" }));
          assignmentAckRef.current = { ...assignmentAckRef.current, [cls.id]: true };
          setAssignmentAck((prev) => ({ ...prev, [cls.id]: true }));
        }
      } catch (err) {
        console.warn("No se pudo leer el estado de la tarea:", err);
      }
    };
    loadAssignmentStatus();
  }, [assignmentPanel.open, assignmentPanel.classId, currentUser?.uid, findClassById]);

  useEffect(() => {
    const load = async () => {
      setClasses([]);
      setActiveId(null);
      setActiveIndex(0);
      if (!currentUser?.uid) {
        setError("No hay usuario autenticado");
        setLoading(false);
        return;
      }
      try {
        setProgressReady(false);
        initialPositionedRef.current = false;
        setError(null);
        // 1) Primer enrollment del alumno
        let enrSnap = await getDocs(
          query(
            collection(db, "studentEnrollments"),
            where("studentId", "==", currentUser.uid),
            orderBy("enrolledAt", "desc"),
            limit(1),
          ),
        );

        // 1.b) Fallback: si no existe enrollment, intentar derivarlo de la subcolección groups/*/students
        if (enrSnap.empty) {
          const membershipSnap = await getDocs(
            query(
              collectionGroup(db, "students"),
              where("studentId", "==", currentUser.uid),
              limit(1),
            ),
          );
          if (!membershipSnap.empty) {
            const membership = membershipSnap.docs[0];
            const groupIdFromRef = membership.ref.parent.parent?.id;
            if (groupIdFromRef) {
              const groupDoc = await getDoc(doc(db, "groups", groupIdFromRef));
              if (groupDoc.exists()) {
                const gd = groupDoc.data();
                // Crea el enrollment faltante para que futuras cargas sean directas
                await setDoc(
                  doc(db, "studentEnrollments", `${groupIdFromRef}_${currentUser.uid}`),
                  {
                    studentId: currentUser.uid,
                    studentName: membership.data().studentName ?? "",
                    studentEmail: membership.data().studentEmail ?? "",
                    groupId: groupIdFromRef,
                    groupName: gd.groupName ?? "",
                    courseId: gd.courseId ?? "",
                    courseName: gd.courseName ?? "",
                    teacherName: gd.teacherName ?? "",
                    status: "active",
                    enrolledAt: gd.updatedAt ?? new Date(),
                    finalGrade: null,
                  },
                  { merge: true },
                );
                // Volver a cargar el enrollment recién creado
                enrSnap = await getDocs(
                  query(
                    collection(db, "studentEnrollments"),
                    where("studentId", "==", currentUser.uid),
                    orderBy("enrolledAt", "desc"),
                    limit(1),
                  ),
                );
              }
            }
          }
        }

        if (enrSnap.empty) {
          setError(
            "No tienes cursos asignados todavía. Pide a tu profesor que te inscriba en un grupo.",
          );
          setLoading(false);
          return;
        }
        const enrollmentDoc = enrSnap.docs[0];
        const enrollment = enrollmentDoc.data();
        const groupId = enrollment.groupId;
        const currentEnrollmentId = enrollmentDoc.id;

        // Guardar el enrollmentId para usar en saveProgress
        setEnrollmentId(currentEnrollmentId);

        // Cargar progreso guardado
        await loadProgressFromFirestore(currentEnrollmentId);

        // 2) Grupo y curso
        const groupDoc = await getDoc(doc(db, "groups", groupId));
        if (!groupDoc.exists()) {
          setError("El grupo asignado no existe.");
          setLoading(false);
          return;
        }
      const groupData = groupDoc.data();
      setGroupName(groupData.groupName ?? "");
      setGroupId(groupId);
      const coursesArray: Array<{ courseId: string; courseName: string }> =
        Array.isArray(groupData.courses) && groupData.courses.length > 0
          ? groupData.courses
          : groupData.courseId
            ? [{ courseId: groupData.courseId, courseName: groupData.courseName ?? "" }]
            : [];
      const primaryCourseId = coursesArray[0]?.courseId ?? groupData.courseId;
      const primaryCourseName = coursesArray[0]?.courseName ?? groupData.courseName ?? "";
      setStudentName(enrollment.studentName ?? currentUser.displayName ?? "Estudiante");

      const feed: FeedClass[] = [];
      for (const courseEntry of coursesArray) {
        const courseDoc = await getDoc(doc(db, "courses", courseEntry.courseId));
        const courseData = courseDoc.exists() ? courseDoc.data() : null;
        if (!courseData) {
          // Curso eliminado: saltar y no mostrar clases
          continue;
        }
        const courseTitle = courseData?.title ?? courseEntry.courseName ?? "Curso";
        if (courseData?.isArchived) {
          // Saltar cursos archivados en el feed
          continue;
        }

        // 3) Lecciones y clases por curso
        const lessonsSnap = await getDocs(
          query(collection(db, "courses", courseEntry.courseId, "lessons"), orderBy("order", "asc")),
        );
        for (const lesson of lessonsSnap.docs) {
          const ldata = lesson.data();
          const lessonTitle = ldata.title ?? "Lección";
            const classesSnap = await getDocs(
              query(
                collection(db, "courses", courseEntry.courseId, "lessons", lesson.id, "classes"),
                orderBy("order", "asc"),
              ),
            );
            classesSnap.forEach((cls) => {
              const c = cls.data();
              const normType = normalizeClassType(c.type);
              const imageArray =
                c.images ??
                c.imageUrls ??
                (c.imageUrl ? [c.imageUrl] : []);

            feed.push({
              id: `${courseEntry.courseId}_${cls.id}`,
              classDocId: cls.id,
              title: c.title ?? "Clase sin título",
              type: normType,
              courseId: courseEntry.courseId,
              lessonId: lesson.id,
              enrollmentId: currentEnrollmentId,
              groupId,
              classTitle: c.title ?? "Clase sin título",
              videoUrl: (c.videoUrl ?? "").trim(),
              audioUrl: (c.audioUrl ?? "").trim(),
              content: c.content ?? "",
              images: Array.isArray(imageArray)
                ? imageArray.filter(Boolean).map((u: string) => u.trim())
                : [],
              hasAssignment: c.hasAssignment ?? false,
              assignmentTemplateUrl: c.assignmentTemplateUrl ?? "",
              lessonTitle,
              lessonName: lessonTitle,
              courseTitle,
              likesCount: c.likesCount ?? 0,
            });
          });
        }
        setCourseTitleMap((prev) => ({
          ...prev,
          [courseEntry.courseId]: courseTitle,
        }));
      }

      if (feed.length === 0) {
        setError(
          "Las materias asignadas a tu grupo están archivadas o sin contenido disponible.",
        );
        setClasses([]);
        setActiveId(null);
        setActiveIndex(0);
        setLoading(false);
        return;
      }

      // Actualizar nombre mostrado (curso base)
      setCourseName(primaryCourseName);

      const initialLikes: Record<string, number> = {};
      feed.forEach((item) => {
        initialLikes[item.id] = item.likesCount ?? 0;
      });

      setClasses(feed);
      setLikesMap(initialLikes);
      setLikedMap({});
      setLikePendingMap({});
      setActiveIndex(0);
      setActiveId(feed[0]?.id ?? null);
      } catch (err) {
        console.error(err);
        setError("No se pudieron cargar tus clases");
      } finally {
        setLoading(false);
      }
    };
    if (!authLoading) {
      load();
    }
  }, [authLoading, currentUser?.uid]);

  // Cargar likes propios por clase
  useEffect(() => {
    let cancelled = false;
    const loadLikes = async () => {
      if (!currentUser?.uid) return;
      if (!classes.length) return;
      try {
        const pairs = await Promise.all(
          classes.map(async (cls) => {
            if (!cls.courseId || !cls.lessonId || !cls.classDocId) return [cls.id, false] as const;
            try {
              const likeRef = doc(
                db,
                "courses",
                cls.courseId,
                "lessons",
                cls.lessonId,
                "classes",
                cls.classDocId,
                "likes",
                currentUser.uid,
              );
              const likeSnap = await getDoc(likeRef);
              return [cls.id, likeSnap.exists()] as const;
            } catch (err) {
              console.warn("No se pudo leer el like de una clase:", err);
              return [cls.id, false] as const;
            }
          }),
        );
        if (cancelled) return;
        const nextLiked: Record<string, boolean> = {};
        pairs.forEach(([id, liked]) => {
          nextLiked[id] = liked;
        });
        setLikedMap((prev) => ({ ...prev, ...nextLiked }));
      } catch (err) {
        console.warn("No se pudieron cargar los likes del alumno:", err);
      }
    };
    loadLikes();
    return () => {
      cancelled = true;
    };
  }, [classes, currentUser?.uid]);

  // Snap & reproducción: usamos IntersectionObserver para determinar la tarjeta activa
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          // Evitar que el observer cambie de tarjeta antes de posicionar en la clase pendiente
          if (!initialPositionedRef.current) return;
          if (entry.isIntersecting) {
            const id = entry.target.getAttribute("data-id");
            const idx = entry.target.getAttribute("data-index");
            const nextIdx = idx ? Number(idx) : null;
            const prevIdx = lastActiveRef.current;
            if (id) {
              setActiveId(id);
              activeIdRef.current = id;
            }
            if (nextIdx !== null) {
              setActiveIndex(nextIdx);
              lastActiveRef.current = nextIdx;
            }
          }
          const video = videosRef.current[entry.target.id];
          if (video) {
            if (entry.isIntersecting) video.play().catch(() => {});
            else video.pause();
          }
        });
      },
      {
        threshold: 0.6,
        root: containerRef.current ?? null,
      },
    );

    const cards = document.querySelectorAll(".feed-card");
    cards.forEach((c) => observer.observe(c));
    return () => observer.disconnect();
  }, [classes.length]);

  // Cuando cambia la clase activa, aseguramos audio activado y reproducimos el activo
  useEffect(() => {
    if (activeId) {
      setUnmutedId(activeId);
      activeIdRef.current = activeId;
      if (commentsOpen) setCommentsClassId(activeId);
    }
    Object.entries(videosRef.current).forEach(([id, video]) => {
      if (!video) return;
      if (id === activeId) {
        video.muted = false;
        video.play().catch(() => {});
      } else {
        video.pause();
      }
    });
  }, [activeId]);

  const scrollToIndex = (idx: number, smooth = true) => {
    const clampedIdx = Math.max(0, Math.min(classes.length - 1, idx));
    const target = classes[clampedIdx];
    if (!target) return;

    const node = sectionRefs.current[target.id];
    const container = containerRef.current;
    if (!node || !container) return;

    const nodeTop = node.offsetTop;
    const behavior = smooth ? "smooth" : "auto";
    container.scrollTo({ top: nodeTop, behavior });
  };

  const isClassComplete = useCallback(
    (cls: FeedClass) => {
      const pct = Math.max(
        progressMap[cls.id] ?? 0,
        progressRef.current[cls.id] ?? 0,
        completedMap[cls.id] || completedRef.current[cls.id] || seenMap[cls.id] || seenRef.current[cls.id] ? 100 : 0,
      );
      return pct >= getRequiredPct(cls.type);
    },
    [completedMap, progressMap, seenMap],
  );

  // Al cargar, posicionar en la primera clase pendiente
  useEffect(() => {
    if (loading || initialPositionedRef.current || !progressReady) return;
    if (!classes.length) return;

    const computeComplete = (cls: FeedClass) => {
      const pct = Math.max(
        progressMap[cls.id] ?? 0,
        completedMap[cls.id] || seenMap[cls.id] ? 100 : 0,
      );
      return pct >= getRequiredPct(cls.type);
    };

    const firstPendingIdx = classes.findIndex((cls) => !computeComplete(cls));
    const targetIndex = firstPendingIdx === -1 ? Math.max(classes.length - 1, 0) : firstPendingIdx;
    const targetId = classes[targetIndex]?.id ?? null;
    setActiveIndex(targetIndex);
    setActiveId(targetId);
    lastActiveRef.current = targetIndex;
    activeIdRef.current = targetId;
    requestAnimationFrame(() => {
      scrollToIndex(targetIndex, false);
      initialPositionedRef.current = true;
    });
    if (autoReposition) {
      requestAnimationFrame(() => {
        scrollToIndex(targetIndex, false);
        initialPositionedRef.current = true;
        setAutoReposition(false);
      });
    }
  }, [classes, isClassComplete, loading, progressReady, progressMap, completedMap, seenMap, autoReposition]);

  // Reforzar ubicación si se actualiza el progreso después del montaje (desactivado auto-jump)
  useEffect(() => {
    // dejamos intencionalmente sin autoReposition para evitar saltos dobles al terminar una clase
  }, [progressReady, classes, progressMap, completedMap, seenMap, activeIndex, loading, autoReposition]);

  const jumpToIndex = useCallback(
    (idx: number) => {
      setAutoReposition(false);
      const prevSameCourse = getPrevSameCourse(idx);
      if (prevSameCourse && !isClassComplete(prevSameCourse)) {
        toast.error("Completa la clase anterior de esta materia antes de continuar.");
        return;
      }
      scrollToIndex(idx, true);
    },
    [getPrevSameCourse, isClassComplete, scrollToIndex],
  );

  const handleTextReachEnd = useCallback(
    (idx: number) => {
      const nextIdx = idx + 1;
      if (nextIdx >= classes.length) return;
      const prevSameCourse = getPrevSameCourse(nextIdx);
      if (prevSameCourse && !isClassComplete(prevSameCourse)) return;
      scrollToIndex(nextIdx, true);
    },
    [classes.length, getPrevSameCourse, isClassComplete],
  );

  // Bloquear scroll múltiple: solo una clase por gesto de wheel/touchpad
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleWheel = (e: WheelEvent) => {
      // Permitir scroll natural dentro de contenedores de texto u otros scrollables
      const target = e.target as HTMLElement | null;
      if (target?.closest('[data-scrollable="true"]')) {
        return;
      }

      if (e.ctrlKey || e.metaKey) return; // no interferir con zoom
      e.preventDefault();
      const now = Date.now();

      if (wheelTimeoutRef.current) clearTimeout(wheelTimeoutRef.current);

      wheelAccumRef.current += e.deltaY;

      // Umbral para considerar un gesto completo
      const threshold = 120; // típico delta en trackpad
      if (!wheelLockRef.current && Math.abs(wheelAccumRef.current) >= threshold) {
        wheelLockRef.current = true;
        const direction = wheelAccumRef.current > 0 ? 1 : -1;
        const nextIdx = (activeIndex ?? 0) + direction;
        // Gate solo si es mismo curso
        const prevSameCourse = getPrevSameCourse(nextIdx);
        if (prevSameCourse && !isClassComplete(prevSameCourse)) {
          wheelLockRef.current = false;
          wheelAccumRef.current = 0;
          return;
        }
        scrollToIndex(nextIdx, false);

        // pequeño cooldown para no encadenar saltos
        setTimeout(() => {
          wheelLockRef.current = false;
        }, 500);

        wheelAccumRef.current = 0;
      }

      // reset si no sigue moviendo
      wheelTimeoutRef.current = setTimeout(() => {
        wheelAccumRef.current = 0;
      }, 200);
    };

    container.addEventListener("wheel", handleWheel, { passive: false });
    return () => {
      container.removeEventListener("wheel", handleWheel);
      if (wheelTimeoutRef.current) clearTimeout(wheelTimeoutRef.current);
    };
  }, [activeIndex, scrollToIndex]);

  // Handler de progreso que NO causa re-renders excesivos
  const handleProgress = useCallback(
    (classId: string, pct: number, classType: string, hasAssignment: boolean, assignmentTemplateUrl?: string) => {
      const previousCompleted = completedRef.current[classId] ?? false;
      const previousProgress = progressRef.current[classId] ?? 0;
      const maxProgress = Math.max(pct, previousProgress);
      const requiredPct = getRequiredPct(classType);

      // Siempre actualizar progressRef para tener el valor más reciente
      progressRef.current[classId] = maxProgress;

      // Actualizar estado cada 0.5% para visualización en tiempo real
      if (Math.abs(maxProgress - previousProgress) >= 0.5) {
        setProgressMap((prev) => ({
          ...prev,
          [classId]: maxProgress,
        }));
      }

      // Guardar en Firestore (debounced - solo cada 5%)
      if (
        maxProgress > previousProgress + 0.01 &&
        (Math.floor(maxProgress / 5) > Math.floor(previousProgress / 5) || (maxProgress >= 95 && previousProgress < 95))
      ) {
        console.log(`💾 Guardando en Firestore - Clase: ${classId}, Progreso: ${maxProgress.toFixed(2)}%`);
        saveProgressToFirestore(classId, maxProgress, previousProgress, requiredPct);
      }

      if ((!previousCompleted && maxProgress >= requiredPct) || seenRef.current[classId]) {
        completedRef.current[classId] = true;
        setCompletedMap((prev) => ({ ...prev, [classId]: true }));
        seenRef.current[classId] = true;
        setSeenMap((prev) => ({ ...prev, [classId]: true }));
      }

      // Mostrar modal de tarea cuando el video termina (>= 95%)
      if (
        maxProgress >= 95 &&
        previousProgress < 95 &&
        hasAssignment &&
        !assignmentAckRef.current[classId]
      ) {
        setAssignmentModal({
          open: true,
          classId: classId,
          templateUrl: assignmentTemplateUrl,
          nextIndex: undefined,
        });
      }
    },
    [saveProgressToFirestore],
  );

  useEffect(() => {
    const cls = classes[activeIndex];
    if (!cls) return;
    if (completedRef.current[cls.id] || seenRef.current[cls.id]) return;

    if (cls.type === "quiz" || (cls.type === "text" && !cls.content)) {
      handleProgress(cls.id, 100, cls.type, cls.hasAssignment || false, cls.assignmentTemplateUrl);
    }
  }, [activeIndex, classes, handleProgress]);

  const renderContent = (cls: FeedClass, idx: number) => {
    if (cls.type === "video" && cls.videoUrl) {
      return (
        <div className="relative w-full h-full flex items-center justify-center">
          <VideoPlayer
            key={cls.id}
            id={cls.id}
            src={cls.videoUrl}
            isActive={activeId === cls.id}
            muted={unmutedId !== cls.id}
            onToggleMute={() => setUnmutedId((prev) => (prev === cls.id ? null : cls.id))}
            initialProgress={Math.max(
              progressMap[cls.id] ?? 0,
              (completedMap[cls.id] || seenMap[cls.id]) ? 100 : 0,
            )}
            registerRef={(el) => {
              videosRef.current[cls.id] = el;
            }}
            onProgress={(pct) =>
              handleProgress(cls.id, pct, cls.type, cls.hasAssignment || false, cls.assignmentTemplateUrl)
            }
            hasAssignment={cls.hasAssignment || false}
            assignmentTemplateUrl={cls.assignmentTemplateUrl}
          />
          {(cls.title || cls.content) ? (
            <div className="pointer-events-auto absolute left-3 right-3 bottom-16 max-w-[90%] rounded-2xl bg-black/45 px-3 py-2 text-white shadow-lg backdrop-blur-sm lg:bottom-14">
              <div className="text-sm font-semibold leading-tight">{cls.title}</div>
              {cls.content ? (
                <div className="mt-1 text-xs leading-relaxed text-white/90">
                  <p
                    className={`whitespace-pre-wrap ${descriptionExpanded[cls.id] ? "" : "line-clamp-2"}`}
                  >
                    {cls.content}
                  </p>
                  {cls.content.length > 120 ? (
                    <button
                      type="button"
                      className="mt-1 text-[11px] font-semibold text-blue-200 hover:text-blue-100"
                      onClick={(e) => {
                        e.stopPropagation();
                        setDescriptionExpanded((prev) => ({ ...prev, [cls.id]: !prev[cls.id] }));
                      }}
                    >
                      {descriptionExpanded[cls.id] ? "menos" : "más"}
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      );
    }

    if (cls.type === "audio" && cls.audioUrl) {
      return (
        <div className="flex h-full w-full items-center justify-center px-4 lg:px-10 lg:pr-[140px]">
          <div className="flex w-full max-w-3xl flex-col items-center justify-center gap-4 px-4 lg:px-6">
            <div className="flex items-center gap-3">
              <span className="rounded-full bg-white/10 p-3">
                <ControlIcon name="audio" />
              </span>
              <p className="text-lg font-semibold text-white">{cls.title}</p>
            </div>
            <audio
              controls
              src={cls.audioUrl}
              className="w-full rounded-full bg-white/5 px-2 py-1 text-white accent-red-500"
              onTimeUpdate={(e) => {
                if (activeId !== cls.id) return;
                const duration = e.currentTarget.duration || 0;
                if (!duration) return;
                const pct = (e.currentTarget.currentTime / duration) * 100;
                handleProgress(cls.id, pct, cls.type, cls.hasAssignment || false, cls.assignmentTemplateUrl);
              }}
              onEnded={() => {
                if (activeId !== cls.id) return;
                handleProgress(cls.id, 100, cls.type, cls.hasAssignment || false, cls.assignmentTemplateUrl);
              }}
            >
              Tu navegador no soporta audio.
            </audio>
          </div>
        </div>
      );
    }

    if (cls.type === "image" && cls.images && cls.images.length > 0) {
      const storedPct = Math.max(progressMap[cls.id] ?? 0, (completedMap[cls.id] || seenMap[cls.id]) ? 100 : 0);
      const initialImageIndex =
        storedPct >= getRequiredPct("image") ? Math.max((cls.images.length ?? 1) - 1, 0) : (imageIndexMap[cls.id] ?? 0);
      if (cls.id && imageIndexRef.current[cls.id] === undefined) {
        imageIndexRef.current[cls.id] = initialImageIndex;
      }
      return (
        <ImageCarousel
          images={cls.images}
          title={cls.title}
          activeIndex={initialImageIndex}
          isActive={activeId === cls.id}
          onIndexChange={(idx) => {
            imageIndexRef.current[cls.id] = idx;
            setImageIndexMap((prev) => ({ ...prev, [cls.id]: idx }));
          }}
          onProgress={(pct) => handleProgress(cls.id, pct, cls.type, cls.hasAssignment || false, cls.assignmentTemplateUrl)}
        />
      );
    }

    if (cls.type === "text" && cls.content) {
      return (
        <TextContent
          title={cls.title}
          content={cls.content}
          isActive={activeId === cls.id}
          onProgress={(pct) => handleProgress(cls.id, pct, cls.type, cls.hasAssignment || false, cls.assignmentTemplateUrl)}
          onReachEnd={() => handleTextReachEnd(idx)}
        />
      );
    }

    if (cls.type === "quiz") {
      return (
        <QuizContent
          classId={cls.id}
          classDocId={cls.classDocId ?? cls.id}
          courseId={cls.courseId}
          courseTitle={courseTitleMap[cls.courseId ?? ""] || cls.courseTitle || courseName || "Curso"}
          lessonId={cls.lessonId}
          enrollmentId={enrollmentId ?? undefined}
          groupId={cls.groupId}
          classTitle={cls.classTitle ?? cls.title}
          studentName={studentName || currentUser?.displayName || "Estudiante"}
          studentId={currentUser?.uid}
          isActive={activeId === cls.id}
          onProgress={(pct) => handleProgress(cls.id, pct, cls.type, cls.hasAssignment || false, cls.assignmentTemplateUrl)}
        />
      );
    }

    if (cls.type === "text" && !cls.content) {
      return (
        <div className="flex w-full h-full items-center justify-center bg-neutral-950 text-neutral-200">
          No hay contenido de texto cargado.
        </div>
      );
    }

    return (
      <div className="flex w-full h-full items-center justify-center bg-neutral-950 text-neutral-400">
        Contenido no soportado
      </div>
    );
  };

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center text-slate-600">
        Cargando tu feed...
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center text-slate-700">
        {error}
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-black text-white" style={{ touchAction: "pan-y" }}>
      <header className="fixed left-0 top-0 z-20 hidden h-full w-64 flex-col border-r border-white/10 bg-neutral-900/80 p-4 lg:flex">
        <div className="space-y-1">
          <h1 className="text-xl font-bold">Mis clases</h1>
          <p className="text-xs text-neutral-500">{groupName}</p>
        </div>
        <div className="mt-4 flex-1 space-y-4 overflow-y-auto pr-1">
          {courseThreads.map((course) => {
            const totalCourseItems = course.lessons.reduce((acc, l) => acc + l.items.length, 0);
            const completedCourseItems = course.lessons.reduce(
              (acc, l) =>
                acc +
                l.items.filter(
                  (it) =>
                    Math.max(
                      progressMap[it.id] ?? 0,
                      completedMap[it.id] || seenMap[it.id] ? 100 : 0,
                    ) >= getRequiredPct(it.type),
                ).length,
              0,
            );
            return (
              <div key={course.courseId} className="rounded-xl border border-white/5 bg-neutral-900/60 p-3 shadow-inner">
                <div className="mb-3 flex items-center justify-between gap-3 rounded-lg bg-white/5 px-3 py-2">
                  <span className="text-sm font-semibold text-neutral-100">{course.courseTitle}</span>
                  <span className="text-[11px] text-neutral-300">
                    {completedCourseItems}/{totalCourseItems}
                  </span>
                </div>
                <div className="space-y-3">
                  {course.lessons.map((lesson) => {
                    const totalItems = lesson.items.length;
                    const completedItems = lesson.items.filter((it) => Math.max(progressMap[it.id] ?? 0, (completedMap[it.id] || seenMap[it.id]) ? 100 : 0) >= getRequiredPct(it.type)).length;
                    const collapsed = collapsedLessons[lesson.lessonId] ?? false;
                    return (
                      <div key={lesson.lessonId} className="rounded-lg border border-white/5 bg-neutral-900/70 p-2">
                        <button
                          type="button"
                          onClick={() =>
                            setCollapsedLessons((prev) => ({
                              ...prev,
                              [lesson.lessonId]: !collapsed,
                            }))
                          }
                          className="flex w-full items-center gap-2 text-xs font-semibold text-neutral-100 hover:text-white"
                        >
                          <span className="line-clamp-1 flex-1 text-left">{lesson.lessonTitle}</span>
                          <span className="text-[10px] text-neutral-300">{completedItems}/{totalItems}</span>
                          <span
                            className={`inline-flex h-4 w-4 items-center justify-center rounded-full border border-white/20 text-[9px] transition ${
                              collapsed ? "rotate-180" : ""
                            }`}
                            aria-hidden
                          >
                            ˅
                          </span>
                        </button>

                        {!collapsed ? (
                          <div className="mt-2 space-y-2 pl-3">
                            {lesson.items.map((item, itemIdx) => {
                              const pct = Math.round(Math.max(progressMap[item.id] ?? 0, (completedMap[item.id] || seenMap[item.id]) ? 100 : 0));
                              const isActive = activeId === item.id;
                              const isLast = itemIdx === lesson.items.length - 1;
                              const requiredPct = getRequiredPct(item.type);
                              const isCompleted = pct >= requiredPct;
                              return (
                                <div key={item.id} className="relative pl-5">
                                  <span
                                    className={`absolute left-1 top-0 h-full w-px ${isLast ? "h-3" : ""} bg-white/10`}
                                    aria-hidden
                                  />
                                  <span className="absolute left-0 top-[9px]">
                                    {isCompleted ? (
                                      <span className="flex h-3.5 w-3.5 items-center justify-center rounded-full bg-emerald-500 text-white shadow">
                                        <ControlIcon name="check" />
                                      </span>
                                    ) : (
                                      <span className="block h-2 w-2 rounded-full border border-white/40 bg-amber-400" />
                                    )}
                                  </span>
                                  <button
                                    onClick={() => jumpToIndex(item.index)}
                                    className={`group flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left text-[11px] transition ${
                                      isActive ? "bg-white/10 text-white" : "text-neutral-300 hover:bg-white/5"
                                    }`}
                                  >
                                    <span className="flex-1 truncate">{item.title}</span>
                                    <span className="rounded-full bg-white/10 px-2 py-[1px] text-[9px] text-neutral-200 group-hover:bg-white/20">
                                      {pct}%
                                    </span>
                                  </button>
                                </div>
                              );
                            })}
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </header>

      <main className="ml-0 lg:ml-64">
        {/* Header overlay móvil */}
        <div className="pointer-events-none absolute left-4 top-4 z-30 flex flex-col gap-1 text-xs text-white/80 lg:hidden">
          <span className="rounded-full bg-black/50 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.12em]">
            {courseName || "Curso"}
          </span>
          <span className="rounded-full bg-black/30 px-3 py-1">{groupName || "Grupo"}</span>
        </div>
        <div
          ref={containerRef}
          className="relative flex h-screen snap-y snap-mandatory flex-col overflow-y-scroll scroll-smooth no-scrollbar overscroll-contain"
        >
          {classes.map((cls, idx) => {
            const safeDescription =
              cls.type === "text"
                ? ""
                : typeof cls.content === "string"
                  ? cls.content.replace(/<[^>]+>/g, "").trim()
                  : "";
            const showMobileMeta = Boolean(cls.title && safeDescription);
            const contentBoxSizeClass = "lg:w-[min(90vh,90vw,820px)] lg:h-[min(90vh,90vw,820px)]";

            return (
              <section
                key={cls.id}
                id={cls.id}
                data-id={cls.id}
                data-index={idx}
                ref={(el) => {
                  sectionRefs.current[cls.id] = el;
                }}
                className="feed-card relative flex h-screen min-h-screen w-full snap-start snap-always items-center justify-center bg-black"
              >
                <div className="relative flex h-full w-full items-center justify-center lg:px-8 lg:py-5 mx-auto overflow-visible">
                  <div className="relative flex items-center justify-center gap-6 lg:gap-10 w-full h-full lg:w-auto lg:h-auto pt-16 lg:pt-0">
                  <div className={`relative w-full h-full ${contentBoxSizeClass} overflow-hidden rounded-none lg:rounded-2xl border-0 lg:border border-white/10 lg:bg-neutral-900/60 lg:shadow-2xl flex items-center justify-center`}>
                      {renderContent(cls, idx)}

                      {/* Stack móvil (estilo TikTok) */}
                      {cls.type !== "quiz" ? (
                        <ActionStack
                          likes={likesMap[cls.id] ?? cls.likesCount ?? 0}
                          comments={(commentsCountMap[cls.id] ?? commentsMap[cls.id]?.length ?? 0)}
                          isLiked={likedMap[cls.id] ?? false}
                          onLike={() => handleToggleLike(cls)}
                          likeDisabled={likePendingMap[cls.id] ?? false}
                          hasAssignment={cls.hasAssignment || false}
                          onAssignment={() => setAssignmentPanel({ open: true, classId: cls.id })}
                          positionClass="absolute right-2 top-1/4 -translate-y-1/4 lg:hidden"
                        />
                      ) : null}

                    {/* Overlay inferior con avance y estado */}
                    <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/70 to-transparent p-4">
                      <div className="mb-2 flex items-center gap-2 text-xs text-neutral-200">
                        {/* Solo mostramos el estado listo; no mostramos avisos de % faltante */}
                        <span className="inline-flex items-center rounded-full bg-green-500/20 px-3 py-1 text-green-200">
                          {ENFORCE_VIDEO_GATE ? "Listo para avanzar" : "Avance libre"}
                        </span>
                        {cls.hasAssignment ? (
                          <span className="inline-flex items-center rounded-full bg-blue-500/20 px-3 py-1 text-[11px] font-semibold text-blue-100">
                            Tarea activa
                          </span>
                        ) : null}
                      </div>
                    </div>
                  </div>

                  {/* Stack desktop al costado del contenido */}
                  {cls.type !== "quiz" ? (
                    <ActionStack
                      likes={likesMap[cls.id] ?? cls.likesCount ?? 0}
                      comments={(commentsCountMap[cls.id] ?? commentsMap[cls.id]?.length ?? 0)}
                      isLiked={likedMap[cls.id] ?? false}
                      onLike={() => handleToggleLike(cls)}
                      likeDisabled={likePendingMap[cls.id] ?? false}
                      hasAssignment={cls.hasAssignment || false}
                      onAssignment={() => setAssignmentPanel({ open: true, classId: cls.id })}
                      positionClass="hidden lg:flex flex-col items-center gap-4"
                    />
                  ) : null}

                  {showMobileMeta ? (
                    <MobileSafeMeta title={cls.title} description={safeDescription} />
                  ) : null}
                </div>
                </div>
              </section>
            );
          })}

          <div className="pointer-events-auto fixed right-3 bottom-16 z-40 flex flex-col gap-3 lg:right-6 lg:top-1/2 lg:-translate-y-1/2 lg:bottom-auto">
            <button
              type="button"
              onClick={() => jumpToIndex(activeIndex - 1)}
              disabled={activeIndex === 0}
              className="flex h-12 w-12 items-center justify-center rounded-full bg-black/40 text-white shadow-lg backdrop-blur transition hover:bg-white/20 disabled:opacity-40"
            >
              <ControlIcon name="arrowUp" />
            </button>
            <button
              type="button"
              onClick={() => jumpToIndex(activeIndex + 1)}
              disabled={activeIndex >= classes.length - 1}
              className="flex h-12 w-12 items-center justify-center rounded-full bg-black/40 text-white shadow-lg backdrop-blur transition hover:bg-white/20 disabled:opacity-40"
            >
              <ControlIcon name="arrowDown" />
            </button>
          </div>

          {/* Panel de comentarios */}
          {commentsOpen && commentsClassId ? (
            <CommentsPanel
              classId={commentsClassId}
              comments={commentsMap[commentsClassId] ?? []}
              loading={loadingCommentsMap[commentsClassId] ?? false}
              onClose={() => setCommentsOpen(false)}
              onAdd={(text, parentId) => {
                if (!currentUser) {
                  toast.error("Inicia sesión para comentar");
                  return;
                }
                const targetMeta = findClassById(commentsClassId);
                if (!targetMeta?.courseId || !targetMeta?.lessonId || !targetMeta?.classDocId) {
                  toast.error("No se pudo identificar la clase para comentar");
                  return;
                }

                const optimistic = {
                  id: `local-${Date.now()}`,
                  author: (currentUser.displayName ?? studentName ?? "").trim() || currentUser.uid || "Estudiante",
                  authorId: currentUser.uid,
                  role: "student" as const,
                  text,
                  createdAt: Date.now(),
                  parentId: parentId ?? null,
                };
                setCommentsMap((prev) => ({
                  ...prev,
                  [commentsClassId]: [...(prev[commentsClassId] ?? []), optimistic],
                }));
                setCommentsCountMap((prev) => ({
                  ...prev,
                  [commentsClassId]: (prev[commentsClassId] ?? (commentsMap[commentsClassId]?.length ?? 0)) + 1,
                }));

                const path = collection(
                  db,
                  "courses",
                  targetMeta.courseId,
                  "lessons",
                  targetMeta.lessonId,
                  "classes",
                  targetMeta.classDocId,
                  "comments",
                );
                addDoc(path, {
                  text,
                  authorId: currentUser.uid,
                  authorName: currentUser.displayName ?? studentName ?? "Estudiante",
                  parentId: parentId ?? null,
                  createdAt: serverTimestamp(),
                  role: "student",
                })
                  .then(() => loadCommentsForClass(commentsClassId))
                  .catch((err) => {
                    console.error("No se pudo guardar el comentario:", err);
                    toast.error("No se pudo guardar el comentario");
                    setCommentsMap((prev) => ({
                      ...prev,
                      [commentsClassId]: (prev[commentsClassId] ?? []).filter((c) => c.id !== optimistic.id),
                    }));
                    setCommentsCountMap((prev) => ({
                      ...prev,
                      [commentsClassId]: Math.max(
                        0,
                        (prev[commentsClassId] ?? (commentsMap[commentsClassId]?.length ?? 1)) - 1,
                      ),
                    }));
                  });
              }}
            />
          ) : null}

          {/* Modal de tarea */}
          {assignmentModal.open ? (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
              <div className="w-full max-w-md rounded-2xl bg-neutral-900 p-6 shadow-2xl">
                <h3 className="text-lg font-semibold text-white">Descarga la plantilla</h3>
                <p className="mt-2 text-sm text-neutral-300">
                  Esta clase tiene tarea. Descarga la plantilla antes de continuar.
                </p>
                <div className="mt-4 flex flex-col gap-3">
                  {assignmentModal.templateUrl ? (
                    <a
                      href={assignmentModal.templateUrl}
                      target="_blank"
                      rel="noreferrer"
                    className="inline-flex items-center justify-center rounded-full bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-500"
                  >
                    Descargar plantilla
                  </a>
                ) : (
                  <p className="text-sm text-neutral-400">No hay plantilla adjunta.</p>
                  )}
                  <div className="flex justify-end gap-2">
                    <button
                      onClick={() => setAssignmentModal({ open: false })}
                      className="rounded-full border border-white/20 px-4 py-2 text-sm text-white hover:bg-white/10"
                    >
                      Cerrar
                    </button>
                    <button
                      onClick={() => {
                        if (assignmentModal.classId) {
                          setAssignmentAck((prev) => {
                            const next = { ...prev, [assignmentModal.classId!]: true };
                            assignmentAckRef.current = next;
                            return next;
                          });
                          setAssignmentModal({ open: false });
                          if (assignmentModal.nextIndex !== undefined) {
                            scrollToIndex(assignmentModal.nextIndex);
                          }
                        } else {
                          setAssignmentModal({ open: false });
                        }
                      }}
                      className="rounded-full bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-500"
                    >
                      Continuar
                    </button>
                  </div>
                </div>
              </div>
            </div>
          ) : null}

          {/* Panel de tarea lateral */}
          {assignmentPanel.open && assignmentPanel.classId ? (() => {
            const cls = findClassById(assignmentPanel.classId);
            if (!cls) return null;
            return (
              <AssignmentPanel
                classId={cls.id}
                classTitle={cls.title}
                templateUrl={cls.assignmentTemplateUrl}
                note={assignmentNoteMap[cls.id] ?? ""}
                onChangeNote={(val) => setAssignmentNoteMap((prev) => ({ ...prev, [cls.id]: val }))}
                selectedFile={assignmentFileMap[cls.id] ?? null}
                uploading={assignmentUploadingMap[cls.id] ?? false}
                onFileChange={(file) => setAssignmentFileMap((prev) => ({ ...prev, [cls.id]: file }))}
                submitted={assignmentStatusMap[cls.id] === "submitted" || assignmentAckRef.current[cls.id]}
                onClose={() => setAssignmentPanel({ open: false })}
                onSubmit={async () => {
                  if (!currentUser?.uid || !enrollmentId || !cls.groupId) {
                    toast.error("Faltan datos para enviar la tarea");
                    return;
                  }
                  const baseClassId = cls.classDocId ?? cls.id;
                  // Evitar envíos duplicados
                  const subRef = collection(db, "groups", cls.groupId, "submissions");
                  const existing = await getDocs(
                    query(
                      subRef,
                      where("classId", "==", baseClassId),
                      where("studentId", "==", currentUser.uid),
                      limit(1),
                    ),
                  );
                  if (!existing.empty) {
                    setAssignmentStatusMap((prev) => ({ ...prev, [cls.id]: "submitted" }));
                    assignmentAckRef.current = { ...assignmentAckRef.current, [cls.id]: true };
                    setAssignmentAck((prev) => ({ ...prev, [cls.id]: true }));
                    toast.success("Ya habías enviado esta tarea.");
                    return;
                  }
                  const file = assignmentFileMap[cls.id] ?? null;
                  let attachmentUrl = "";
                  if (file) {
                    try {
                      setAssignmentUploadingMap((prev) => ({ ...prev, [cls.id]: true }));
                      const storage = getStorage();
                      const storageRef = ref(storage, `assignments/${currentUser.uid}/${cls.id}/${Date.now()}-${file.name}`);
                      await uploadBytes(storageRef, file, { contentType: file.type || "application/octet-stream" });
                      attachmentUrl = await getDownloadURL(storageRef);
                    } catch (err) {
                      console.error("No se pudo subir el archivo:", err);
                      toast.error("No se pudo subir el archivo");
                      setAssignmentUploadingMap((prev) => ({ ...prev, [cls.id]: false }));
                      return;
                    } finally {
                      setAssignmentUploadingMap((prev) => ({ ...prev, [cls.id]: false }));
                    }
                  }
                  const content = attachmentUrl || assignmentNoteMap[cls.id] || "";
                const payload = {
                  classId: baseClassId,
                  classDocId: baseClassId,
                  className: cls.title ?? "Tarea",
                  courseId: cls.courseId ?? "",
                  courseTitle: cls.courseTitle ?? "",
                  classType: cls.type,
                  studentId: currentUser.uid,
                  studentName: studentName ?? currentUser.displayName ?? "Estudiante",
                    submittedAt: new Date(),
                    content,
                    attachmentUrl,
                    enrollmentId,
                    groupId: cls.groupId,
                    status: "submitted",
                  };
                  try {
                    await createSubmission(cls.groupId, payload);
                    setAssignmentAck((prev) => {
                      const next = { ...prev, [cls.id]: true };
                      assignmentAckRef.current = next;
                      return next;
                    });
                    setAssignmentStatusMap((prev) => ({ ...prev, [cls.id]: "submitted" }));
                    toast.success("Tarea enviada");
                    setAssignmentFileMap((prev) => ({ ...prev, [cls.id]: null }));
                    setAssignmentPanel({ open: false, classId: null });
                  } catch (err) {
                    console.error("No se pudo enviar la tarea:", err);
                    toast.error("No se pudo enviar la tarea");
                  }
                }}
              />
            );
          })() : null}
        </div>
        <style jsx global>{`
          .no-scrollbar {
            -ms-overflow-style: none;
            scrollbar-width: none;
          }
          .no-scrollbar::-webkit-scrollbar {
            display: none;
          }
        `}</style>
      </main>
    </div>
  );
}

type VideoPlayerProps = {
  id: string;
  src: string;
  isActive: boolean;
  muted: boolean;
  onToggleMute: () => void;
  registerRef: (el: HTMLVideoElement | null) => void;
  onProgress?: (percent: number) => void;
  initialProgress?: number;
  hasAssignment?: boolean;
  assignmentTemplateUrl?: string;
};

const VideoPlayer = React.memo(function VideoPlayer({
  id,
  src,
  isActive,
  muted,
  onToggleMute,
  registerRef,
  onProgress,
  initialProgress = 0,
}: VideoPlayerProps) {
  const isVimeo = /vimeo\.com/.test(src);
  const isYouTube = !isVimeo && isEmbedUrl(src);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const vimeoPlayerRef = useRef<Player | null>(null);
  const playerInitializedRef = useRef(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [progress, setProgress] = useState(initialProgress);
  const onProgressRef = useRef(onProgress);

  const handleVimeoToggle = useCallback(() => {
    if (!isVimeo || !vimeoPlayerRef.current || !playerInitializedRef.current) return;
    vimeoPlayerRef.current
      .getPaused()
      .then((paused) => {
        if (paused) {
          return vimeoPlayerRef.current
            ?.play()
            .then(() => setIsPlaying(true))
            .catch(() => {});
        }
        return vimeoPlayerRef.current
          ?.pause()
          .then(() => setIsPlaying(false))
          .catch(() => {});
      })
      .catch(() => {});
  }, [isVimeo]);

  // Mantener onProgress actualizado sin causar re-inicialización
  useEffect(() => {
    onProgressRef.current = onProgress;
  }, [onProgress]);

  // Actualizar progreso cuando cambia initialProgress (al cargar desde Firestore)
  useEffect(() => {
    setProgress((prev) => Math.max(prev, initialProgress));
  }, [initialProgress]);

  // Inicializar Vimeo Player con un pequeño delay para asegurar que el iframe esté listo
  useEffect(() => {
    if (!isVimeo || playerInitializedRef.current) return;

    const initPlayer = async () => {
      // Esperar a que el iframe esté montado
      await new Promise(resolve => setTimeout(resolve, 100));

      if (!iframeRef.current) {
        console.log(`⚠️ iframe no disponible después del delay - ID: ${id}`);
        return;
      }

      try {
        console.log(`🚀 Iniciando Vimeo Player - ID: ${id}`);
        const player = new Player(iframeRef.current);
        await player.ready();
        console.log(`✅ Player ready() completado - ID: ${id}`);

        vimeoPlayerRef.current = player;
        playerInitializedRef.current = true;

        // Configurar eventos
        player.on('play', () => setIsPlaying(true));
        player.on('playing', () => setIsPlaying(true));
        player.on('pause', () => setIsPlaying(false));
        player.on('ended', () => setIsPlaying(false));
        player.on('timeupdate', (data) => {
          const pct = (data.seconds / data.duration) * 100;
          setProgress(pct);
          if (data.seconds > 0) setIsPlaying(true);
          if (onProgressRef.current) {
            onProgressRef.current(pct);
          }
        });

        // Forzar mute inicial según prop antes de reproducir
        await player.setMuted(muted);

        // Si hay progreso guardado, mover el video a esa posición
        if (initialProgress > 0) {
          const duration = await player.getDuration();
          const targetTime = (initialProgress / 100) * duration;
          await player.setCurrentTime(targetTime);
          console.log(`⏩ Video posicionado en ${Math.round(initialProgress)}% - ID: ${id}`);
        }

        // Intentar reproducir si está activo
        if (isActive) {
          try {
            await player.play();
            setIsPlaying(true);
          } catch (err) {
            console.warn("Autoplay bloqueado; se requiere interacción del usuario", err);
          }
        }

        console.log(`✅ Vimeo Player inicializado - ID: ${id}`);
      } catch (error) {
        console.error(`❌ Error inicializando Vimeo Player - ID: ${id}`, error);
        playerInitializedRef.current = false;
      }
    };

    initPlayer();

    return () => {
      if (vimeoPlayerRef.current) {
        console.log(`🧹 Cleanup Vimeo Player - ID: ${id}`);
        vimeoPlayerRef.current.destroy();
        vimeoPlayerRef.current = null;
        playerInitializedRef.current = false;
      }
    };
  }, [isVimeo, id]); // SOLO isVimeo e id - NO muted!

  // Mantener mute y play/pause sincronizados con el estado del componente
  useEffect(() => {
    if (!vimeoPlayerRef.current || !playerInitializedRef.current) return;
    vimeoPlayerRef.current.setMuted(muted).catch(() => {});
    if (isActive) {
      vimeoPlayerRef.current
        .play()
        .then(() => setIsPlaying(true))
        .catch(() => {});
    } else {
      vimeoPlayerRef.current
        .pause()
        .then(() => setIsPlaying(false))
        .catch(() => {});
    }
  }, [muted, isActive]);

  // Vimeo con controles nativos pero estilizados
  if (isVimeo) {
    const rawEmbedUrl = toEmbedUrl(src);
    let embedUrl = rawEmbedUrl;
    try {
      const parsed = new URL(rawEmbedUrl);
      parsed.searchParams.set("autoplay", "0"); // controlamos play vía API
      parsed.searchParams.set("controls", "0");
      parsed.searchParams.set("title", "0");
      parsed.searchParams.set("byline", "0");
      parsed.searchParams.set("portrait", "0");
      parsed.searchParams.set("pip", "0");
      parsed.searchParams.set("dnt", "1");
      parsed.searchParams.set("playsinline", "1");
      parsed.searchParams.set("autopause", "0");
      parsed.searchParams.set("transparent", "0");
      parsed.searchParams.set("muted", muted ? "1" : "0");
      embedUrl = parsed.toString();
    } catch {
      embedUrl = rawEmbedUrl;
    }

    return (
      <div className="relative h-full w-full bg-black vimeo-player-wrapper flex items-center justify-center">
        <iframe
          ref={iframeRef}
          title={`video-${id}`}
          src={embedUrl}
          className="w-full h-full pointer-events-none select-none"
          allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
          allowFullScreen
        />

        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onToggleMute();
          }}
          className="absolute left-4 top-4 z-40 rounded-full bg-black/70 p-3 text-white shadow"
          aria-label={muted ? "Activar sonido" : "Silenciar video"}
        >
          <ControlIcon name={muted ? "muted" : "sound"} />
        </button>

        <div
          className="absolute inset-0 z-20 cursor-pointer"
          role="button"
          tabIndex={0}
          aria-label={isPlaying ? "Pausar video" : "Reproducir video"}
          onClick={handleVimeoToggle}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
              e.preventDefault();
              handleVimeoToggle();
            }
          }}
          onContextMenu={(e) => e.preventDefault()}
        />

        {!isPlaying ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-black/60 text-white">
              <ControlIcon name="play" />
            </div>
          </div>
        ) : null}

        {/* Barra de progreso personalizada estilo TikTok */}
        <div className="absolute bottom-0 left-0 right-0 px-4 pb-3 pointer-events-none z-30">
          <div className="h-1 w-full rounded-full bg-white/20">
            <div
              className="h-1 rounded-full bg-red-500"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>

        <style jsx>{`
          .vimeo-player-wrapper iframe {
            position: relative;
          }

          /* Desactivar por completo los controles nativos de Vimeo */
          .vimeo-player-wrapper :global(.vp-controls),
          .vimeo-player-wrapper :global(.vp-title),
          .vimeo-player-wrapper :global(.vp-share),
          .vimeo-player-wrapper :global(.vp-settings),
          .vimeo-player-wrapper :global(.vp-big-play-button) {
            display: none !important;
            opacity: 0 !important;
            pointer-events: none !important;
          }
        `}</style>
      </div>
    );
  }

  // YouTube u otros embeds: contenedor con iframe, sin controles nativos
  if (isYouTube) {
    const embedSrc = toEmbedUrl(src);
    return (
      <div className="relative h-full w-full bg-black flex items-center justify-center">
        <iframe
          ref={iframeRef}
          title={`video-${id}`}
          src={embedSrc}
          className="w-full h-full rounded-none"
          allow="autoplay; encrypted-media; picture-in-picture"
          allowFullScreen
        />
      </div>
    );
  }

  useEffect(() => {
    registerRef(videoRef.current);
  }, [registerRef]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = muted;
    if (isActive) {
      video
        .play()
        .then(() => setIsPlaying(true))
        .catch(() => setIsPlaying(false));
    } else {
      video.pause();
      setIsPlaying(false);
    }
  }, [isActive, muted]);

  const togglePlay = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      video.play().then(() => setIsPlaying(true)).catch(() => {});
    } else {
      video.pause();
      setIsPlaying(false);
    }
  };

  const handleTimeUpdate = () => {
    const video = videoRef.current;
    if (!video || !video.duration) return;
    const pct = (video.currentTime / video.duration) * 100;
    const currentProgress = progress;
    const maxProgress = Math.max(pct, currentProgress, initialProgress);
    setProgress(maxProgress);
    onProgress?.(pct);
  };

  return (
    <div className="relative w-full h-full bg-black flex items-center justify-center">
      <video
        ref={videoRef}
        src={src}
        className="max-h-full max-w-full w-auto h-auto cursor-pointer object-contain"
        playsInline
        muted={muted}
        onTimeUpdate={handleTimeUpdate}
        onLoadedMetadata={() => {
          const v = videoRef.current;
          if (v && isActive) {
            v.muted = muted;
            v.play().catch(() => {});
          }
        }}
        onClick={togglePlay}
      />

      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onToggleMute();
        }}
        className="absolute left-4 top-4 rounded-full bg-black/70 p-3 text-white shadow"
      >
        <ControlIcon name={muted ? "muted" : "sound"} />
      </button>

      {!isPlaying ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-black/60 text-white">
            <ControlIcon name="play" />
          </div>
        </div>
      ) : null}

      <div className="absolute bottom-0 left-0 right-0 px-4 pb-3">
        <div className="h-1 w-full rounded-full bg-white/20">
          <div
            className="h-1 rounded-full bg-red-500"
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>
    </div>
  );
}, (prevProps, nextProps) => {
  // Comparación personalizada: solo re-renderizar si cambian estas props importantes
  return (
    prevProps.id === nextProps.id &&
    prevProps.src === nextProps.src &&
    prevProps.isActive === nextProps.isActive &&
    prevProps.muted === nextProps.muted &&
    prevProps.initialProgress === nextProps.initialProgress &&
    prevProps.onProgress === nextProps.onProgress &&
    prevProps.hasAssignment === nextProps.hasAssignment &&
    prevProps.assignmentTemplateUrl === nextProps.assignmentTemplateUrl
  );
});

type MobileSafeMetaProps = {
  title: string;
  description: string;
};

function MobileSafeMeta({ title, description }: MobileSafeMetaProps) {
  const topSafePadding = "calc(env(safe-area-inset-top) + 64px)";
  return (
    <div
      className="pointer-events-none absolute inset-0 z-10 flex flex-col justify-between p-4 lg:hidden"
      style={{ paddingTop: topSafePadding }}
    >
      <div className="flex-1">
        <div className="flex h-full w-full flex-col justify-end rounded-2xl border-2 border-dashed border-white/15 bg-gradient-to-b from-white/5 via-transparent to-black/40 px-4 py-3">
          <div className="max-w-[82%] space-y-1 drop-shadow">
            <h2 className="text-lg font-bold leading-tight text-white line-clamp-2">
              {title}
            </h2>
            <p className="text-sm text-white/80 leading-snug line-clamp-3">
              {description}
            </p>
          </div>
        </div>
      </div>
      <div className="mt-3 inline-flex w-fit items-center gap-2 rounded-full border border-white/15 bg-black/60 px-3 py-2 text-[11px] font-semibold text-white/80 backdrop-blur">
        <span className="h-2 w-2 rounded-full bg-emerald-400" aria-hidden />
        Espacio libre de overlays
      </div>
    </div>
  );
}

type ActionStackProps = {
  logoSrc?: string;
  likes?: number;
  comments?: number;
  positionClass?: string;
  isLiked?: boolean;
  onLike?: () => void;
  likeDisabled?: boolean;
  hasAssignment?: boolean;
  onAssignment?: () => void;
};

function ActionStack({ logoSrc = UNIVERSITY_LOGO_SRC, likes = 0, comments = 0, positionClass, isLiked = false, onLike, likeDisabled = false, hasAssignment = false, onAssignment }: ActionStackProps) {
  return (
    <div className={`pointer-events-auto z-30 flex flex-col items-center gap-4 text-white ${positionClass ?? ""}`}>
      <div className="flex flex-col items-center gap-2">
        <div className="h-12 w-12 overflow-hidden rounded-full border-2 border-white/50 bg-white/10">
          <img
            src={logoSrc || UNIVERSITY_LOGO_SRC}
            alt="Logotipo de la universidad"
            className="h-full w-full object-cover"
          />
        </div>
      </div>

      <ActionButton
        icon="heart"
        label={likes.toLocaleString("es-MX")}
        onClick={onLike}
        isActive={isLiked}
        disabled={likeDisabled}
      />
      {hasAssignment ? (
        <ActionButton icon="assignment" label="Tarea" onClick={onAssignment} />
      ) : null}
      <ActionButton icon="comment" label={comments.toLocaleString("es-MX")} onClick={() => {
        const evt = new CustomEvent("open-comments", { detail: null });
        window.dispatchEvent(evt);
      }} />
    </div>
  );
}

function ActionButton({ icon, label, onClick, isActive = false, disabled = false }: { icon: ControlIconName; label: string; onClick?: () => void; isActive?: boolean; disabled?: boolean }) {
  return (
    <div className="flex flex-col items-center gap-1 text-xs text-white/90">
      <button
        type="button"
        disabled={disabled}
        className={`flex h-12 w-12 items-center justify-center rounded-full backdrop-blur transition ${
          isActive ? "bg-pink-600 text-white shadow-lg" : "bg-black/60"
        } ${disabled ? "cursor-not-allowed opacity-50" : "hover:scale-105"}`}
        onClick={onClick}
      >
        <ControlIcon name={icon} />
      </button>
      <span>{label}</span>
    </div>
  );
}

type ControlIconName =
  | "muted"
  | "sound"
  | "play"
  | "heart"
  | "comment"
  | "plus"
  | "assignment"
  | "audio"
  | "arrowUp"
  | "arrowDown"
  | "check";

function ControlIcon({ name }: { name: ControlIconName }) {
  const common = "h-5 w-5 fill-current";
  switch (name) {
    case "muted":
      return (
        <svg viewBox="0 0 24 24" className={common}>
          <path d="M4 9v6h4l5 5V4L8 9H4zM19 9l-4 4m0-4l4 4" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "sound":
      return (
        <svg viewBox="0 0 24 24" className={common}>
          <path d="M4 9v6h4l5 5V4L8 9H4z" />
          <path d="M17.5 8a6 6 0 010 8M15 10.5a3 3 0 010 3" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "play":
      return (
        <svg viewBox="0 0 24 24" className={common}>
          <path d="M8 5v14l11-7z" />
        </svg>
      );
    case "heart":
      return (
        <svg viewBox="0 0 24 24" className={common}>
          <path d="M12 21s-6.5-3.7-9-8a5.2 5.2 0 019-4 5.2 5.2 0 019 4c-2.5 4.3-9 8-9 8z" />
        </svg>
      );
    case "comment":
      return (
        <svg viewBox="0 0 24 24" className={common}>
          <path d="M4 5h16v10H7l-3 4V5z" />
        </svg>
      );
    case "assignment":
      return (
        <svg viewBox="0 0 24 24" className={common}>
          <path d="M7 4h10a2 2 0 012 2v12a2 2 0 01-2 2H7a2 2 0 01-2-2V6a2 2 0 012-2z" />
          <path d="M9 4V3a1 1 0 011-1h4a1 1 0 011 1v1" />
          <path d="M9 10h6M9 14h6M9 18h3" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round" />
        </svg>
      );
    case "plus":
      return (
        <svg viewBox="0 0 24 24" className={common}>
          <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "audio":
      return (
        <svg viewBox="0 0 24 24" className={common}>
          <path d="M9 18V6l8-2v12a3 3 0 11-6 0 3 3 0 116 0" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "arrowUp":
      return (
        <svg viewBox="0 0 24 24" className={common}>
          <path d="M12 6l6 6H6l6-6z" />
        </svg>
      );
    case "arrowDown":
      return (
        <svg viewBox="0 0 24 24" className={common}>
          <path d="M12 18l-6-6h12l-6 6z" />
        </svg>
      );
    case "check":
      return (
        <svg viewBox="0 0 24 24" className={common}>
          <path d="M20 6L9 17l-5-5" stroke="currentColor" strokeWidth="2.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    default:
      return null;
  }
}

type QuizContentProps = {
  classId: string;
  classDocId?: string;
  courseId?: string;
  courseTitle?: string;
  lessonId?: string;
  enrollmentId?: string;
  groupId?: string;
  classTitle?: string;
  studentName?: string;
  studentId?: string;
  isActive?: boolean;
  onProgress?: (pct: number) => void;
};

function QuizContent({ classId, classDocId, courseId, courseTitle, lessonId, enrollmentId, groupId, classTitle, studentName, studentId, isActive = true, onProgress }: QuizContentProps) {
  const [questions, setQuestions] = useState<
    Array<{
      id: string;
      text?: string;
      order?: number;
      options?: Array<{ id: string; text?: string; isCorrect?: boolean }>;
    }>
  >([]);
  const [currentIdx, setCurrentIdx] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [textInputs, setTextInputs] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const onProgressRef = useRef(onProgress);
  const savedRef = useRef(false);

  useEffect(() => {
    onProgressRef.current = onProgress;
  }, [onProgress]);

  useEffect(() => {
    setQuestions([]);
    setCurrentIdx(0);
    setAnswers({});
    setTextInputs({});
    setSubmitting(false);
    setSubmitted(false);
    savedRef.current = false;
    const loadQuestions = async () => {
      const targetClassId = classDocId ?? classId;
      if (!courseId || !lessonId || !targetClassId) {
        console.log('Missing IDs:', { courseId, lessonId, classId: targetClassId });
        return;
      }
      try {
        console.log('Loading questions for:', { courseId, lessonId, classId: targetClassId });
        const qSnap = await getDocs(
          query(
            collection(db, "courses", courseId, "lessons", lessonId, "classes", targetClassId, "questions"),
            orderBy("order", "asc"),
          ),
        );
        console.log('Questions snapshot size:', qSnap.size);
        const data = qSnap.docs.map((d) => {
          const qd = d.data();
          console.log('Question data:', { id: d.id, data: qd });
          return {
            id: d.id,
            text: qd.text ?? qd.question ?? "",
            order: qd.order ?? 0,
            options: Array.isArray(qd.options) ? qd.options : [],
          };
        });
        console.log('Processed questions:', data);
        setQuestions(data);
      } catch (err) {
        console.error("No se pudieron cargar las preguntas del quiz:", err);
      }
    };
    loadQuestions();
  }, [classDocId, classId, courseId, lessonId]);

  const answeredCount = useMemo(
    () => questions.filter((q) => answers[q.id]).length,
    [questions, answers],
  );

  useEffect(() => {
    if (!onProgressRef.current) return;
    const total = Math.max(questions.length, 1);
    const pct = submitted ? 100 : (answeredCount / total) * 100;
    onProgressRef.current(Math.min(100, Math.max(0, pct)));
  }, [answeredCount, questions.length, submitted]);

  useEffect(() => {
    setCurrentIdx((prev) => Math.min(prev, Math.max(questions.length - 1, 0)));
  }, [questions.length]);

  const handleSelect = (questionId: string, optionId: string) => {
    setAnswers((prev) => ({ ...prev, [questionId]: optionId }));
    const idx = questions.findIndex((q) => q.id === questionId);
    if (idx !== -1 && idx < questions.length - 1) {
      setCurrentIdx(idx + 1);
    }
  };

  const currentQuestion = questions[currentIdx];
  const allAnswered = answeredCount === questions.length && questions.length > 0;

  // Debug log
  useEffect(() => {
    console.log('Quiz Debug:', {
      questionsLength: questions.length,
      currentIdx,
      currentQuestion,
      hasCurrentQuestion: !!currentQuestion
    });
  }, [questions, currentIdx, currentQuestion]);

  const handleSubmit = useCallback(async () => {
    if (
      !allAnswered ||
      !enrollmentId ||
      !studentId ||
      !groupId ||
      submitting ||
      savedRef.current
    ) {
      return;
    }
    setSubmitting(true);
    const answerPayload = questions.map((q) => ({
      questionId: q.id,
      question: q.text ?? "",
      selectedOptionId: answers[q.id] ?? "",
      selectedOptionText:
        (q.options ?? []).find((o) => o.id === answers[q.id])?.text ??
        answers[q.id] ??
        "",
    }));
    const friendlyContent = answerPayload
      .map((a, idx) => `P${idx + 1}: ${a.question || "Pregunta"} -> ${a.selectedOptionText || "Sin respuesta"}`)
      .join("\n");
    const autogradable = answerPayload.every(
      (a) =>
        (questions.find((q) => q.id === a.questionId)?.options ?? []).some((o) => typeof o.isCorrect === "boolean"),
    );
    const correctCount = autogradable
      ? answerPayload.filter((a) => {
          const q = questions.find((qq) => qq.id === a.questionId);
          const opt = (q?.options ?? []).find((o) => o.id === a.selectedOptionId);
          return opt?.isCorrect === true;
        }).length
      : 0;
    const total = Math.max(questions.length, 1);
    const gradeValue = autogradable ? Math.round((correctCount / total) * 100) : null;
    const statusValue = autogradable ? "graded" : "pending";
    try {
      const progressDoc = doc(db, "studentEnrollments", enrollmentId, "classProgress", classId);
      await setDoc(
        progressDoc,
        {
          quizCompleted: true,
          quizAnswers: answers,
          quizAnswersDetailed: answerPayload,
          lastUpdated: new Date(),
          ...(gradeValue !== null ? { grade: gradeValue } : {}),
          ...(autogradable ? { status: "graded" } : {}),
        },
        { merge: true },
      );

      const subRef = collection(db, "groups", groupId, "submissions");
      const baseClassId = classDocId ?? classId;
      const existingSnap = await getDocs(
        query(
          subRef,
          where("classId", "==", baseClassId),
          where("studentId", "==", studentId),
          limit(1),
        ),
      );
      const submissionData = {
        classId: baseClassId,
        classDocId: baseClassId,
        className: classTitle ?? "Quiz",
        courseId: courseId ?? "",
        courseTitle: courseTitle ?? "",
        classType: "quiz",
        studentId,
        studentName: studentName ?? "Estudiante",
        submittedAt: new Date(),
        content: friendlyContent,
        answers: answerPayload,
        enrollmentId,
        groupId,
        status: statusValue,
        ...(gradeValue !== null ? { grade: gradeValue } : {}),
      };

      if (!existingSnap.empty) {
        await updateDoc(existingSnap.docs[0].ref, submissionData);
      } else {
        await createSubmission(groupId, submissionData);
      }

      savedRef.current = true;
      setSubmitted(true);
      onProgressRef.current?.(100);
    } catch (err) {
      console.warn("No se pudo enviar el quiz:", err);
      savedRef.current = false;
    } finally {
      setSubmitting(false);
    }
  }, [allAnswered, enrollmentId, studentId, groupId, submitting, questions, answers, classId, classTitle, studentName, courseId, classDocId, courseTitle]);

  return (
    <div className="flex h-full w-full items-center justify-center px-4 lg:px-10 lg:pr-[140px]">
      <div
        ref={containerRef}
        className="w-full max-w-3xl max-h-[88vh] overflow-auto px-1 sm:px-2 py-8 space-y-4"
      >
        <div className="flex items-center justify-between text-xs text-neutral-300">
          <span>
            Pregunta {currentIdx + 1} de {Math.max(questions.length, 1)}
          </span>
          <span>{answeredCount}/{questions.length} respondidas</span>
        </div>

        {questions.length === 0 ? (
          <p className="text-sm text-neutral-300">No hay preguntas cargadas para este quiz.</p>
        ) : questions.length > 0 && currentQuestion ? (
          <div className="space-y-3 rounded-lg border border-white/10 bg-white/5 p-4">
            <div className="flex items-start gap-2 text-neutral-100">
              <span className="mt-[2px] inline-flex h-6 w-6 items-center justify-center rounded-full bg-white/10 text-xs font-semibold">{currentIdx + 1}</span>
              <p className="text-sm font-semibold leading-snug">{currentQuestion.text || `Pregunta ${currentIdx + 1}`}</p>
            </div>
            <div className="space-y-2 pl-8">
              {(currentQuestion.options ?? []).length > 0 ? (
                (currentQuestion.options ?? []).map((opt) => {
                  const selected = answers[currentQuestion.id] === opt.id;
                  return (
                    <label
                      key={opt.id ?? opt.text}
                      className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm ${
                        selected ? "border-blue-500 bg-blue-500/20 text-white" : "border-white/10 bg-white/5 text-neutral-100"
                      }`}
                      onClick={() => handleSelect(currentQuestion.id, opt.id ?? String(opt.text ?? ""))}
                    >
                      <span
                        className={`inline-flex h-4 w-4 items-center justify-center rounded-full border ${
                          selected ? "border-blue-400 bg-blue-500" : "border-white/40 bg-transparent"
                        }`}
                      />
                      <span className="flex-1">{opt.text ?? "Opción"}</span>
                    </label>
                  );
                })
              ) : (
                <div className="space-y-2">
                  <textarea
                    value={textInputs[currentQuestion.id] ?? answers[currentQuestion.id] ?? ""}
                    onChange={(e) =>
                      setTextInputs((prev) => ({ ...prev, [currentQuestion.id]: e.target.value }))
                    }
                    className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-400 focus:border-blue-500 focus:outline-none"
                    placeholder="Escribe tu respuesta..."
                    rows={3}
                  />
                  <div className="flex justify-end">
                    <button
                      type="button"
                      disabled={!(textInputs[currentQuestion.id] ?? answers[currentQuestion.id])?.trim()}
                      onClick={() => {
                        const val = (textInputs[currentQuestion.id] ?? answers[currentQuestion.id] ?? "").trim();
                        if (!val) return;
                        handleSelect(currentQuestion.id, val);
                      }}
                      className="rounded-full bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow disabled:opacity-50"
                    >
                      Guardar y seguir
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        ) : questions.length > 0 ? (
          <p className="text-sm text-neutral-300">Error: No se pudo cargar la pregunta actual. Index: {currentIdx}, Total: {questions.length}</p>
        ) : null}

        {questions.length > 0 ? (
          <div className="flex items-center justify-end gap-2 pt-2">
            {!submitted ? (
              <button
                type="button"
                disabled={!allAnswered || submitting}
                onClick={handleSubmit}
                className="rounded-full bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow disabled:opacity-50"
              >
                {submitting ? "Enviando..." : allAnswered ? "Enviar quiz" : "Contesta todas las preguntas"}
              </button>
            ) : (
              <span className="rounded-full bg-green-600/20 px-4 py-2 text-sm font-semibold text-green-200">
                Quiz enviado
              </span>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}

type TextContentProps = {
  title?: string;
  content: string;
  onProgress?: (pct: number) => void;
  isActive?: boolean;
  onReachEnd?: () => void;
};

function TextContent({
  title,
  content,
  onProgress,
  isActive = true,
  onReachEnd,
}: TextContentProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const onProgressRef = useRef(onProgress);
  const onReachEndRef = useRef(onReachEnd);
  const endNotifiedRef = useRef(false);
  const hasInteractedRef = useRef(false);
  const reachedEndRef = useRef(false);
  const lastScrollTopRef = useRef(0);

  useEffect(() => {
    onProgressRef.current = onProgress;
  }, [onProgress]);

  useEffect(() => {
    onReachEndRef.current = onReachEnd;
  }, [onReachEnd]);

  useEffect(() => {
    endNotifiedRef.current = false;
    hasInteractedRef.current = false;
    reachedEndRef.current = false;
  }, [content, isActive]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || !onProgressRef.current || !isActive) return;

    lastScrollTopRef.current = el.scrollTop;

    const report = (allowReachEnd: boolean) => {
      const cb = onProgressRef.current;
      if (!el || !cb) return;
      const scrollable = el.scrollHeight - el.clientHeight;
      const pct = scrollable > 0 ? (el.scrollTop / scrollable) * 100 : 100;
      cb(Math.min(100, Math.max(0, pct)));
      if (pct < 95) {
        reachedEndRef.current = false;
      }

      if (
        allowReachEnd &&
        pct >= 99 &&
        hasInteractedRef.current &&
        el.scrollTop >= lastScrollTopRef.current
      ) {
        if (reachedEndRef.current && !endNotifiedRef.current) {
          endNotifiedRef.current = true;
          onReachEndRef.current?.();
        } else if (!reachedEndRef.current) {
          reachedEndRef.current = true;
        }
      }
    };

    // Primer reporte: solo progreso, sin disparar avance
    report(false);

    const handleScroll = () => {
      if (!el) return;
      hasInteractedRef.current = true;
      const nextTop = el.scrollTop;
      const isScrollingDown = nextTop >= lastScrollTopRef.current;
      lastScrollTopRef.current = nextTop;
      report(isScrollingDown);
    };

    el.addEventListener("scroll", handleScroll);
    return () => el.removeEventListener("scroll", handleScroll);
  }, [content, isActive]);

  return (
    <div className="flex h-full w-full items-stretch justify-center px-4 lg:px-10 lg:pr-[140px]">
      <div
        ref={containerRef}
        className="w-[80%] lg:w-[80%] max-w-4xl h-full max-h-[88vh] overflow-y-auto overscroll-contain px-2 sm:px-4 lg:px-4 py-8 pb-[calc(env(safe-area-inset-bottom)+120px)] rounded-2xl lg:rounded-none border-0 bg-transparent shadow-none backdrop-blur-none"
        style={{
          WebkitOverflowScrolling: "touch",
          paddingTop: "calc(env(safe-area-inset-top) + 16px)",
        }}
      data-scrollable="true"
    >
      {title ? (
        <h2 className="mb-4 text-xl font-semibold text-white">
          {title}
        </h2>
      ) : null}
      <p className="whitespace-pre-wrap text-base lg:text-lg leading-relaxed text-neutral-50">
        {content || "Contenido no disponible"}
      </p>
      </div>
    </div>
  );
}

type CommentsPanelComment = {
  id: string;
  author: string;
  authorId?: string;
  role?: "professor" | "student";
  text: string;
  createdAt: number;
  parentId?: string | null;
};

type CommentsPanelProps = {
  classId: string;
  comments: Array<CommentsPanelComment>;
  loading?: boolean;
  onAdd: (text: string, parentId?: string | null) => void;
  onClose: () => void;
};

function CommentsPanel({ classId, comments, onAdd, onClose, loading = false }: CommentsPanelProps) {
  const [text, setText] = useState("");
  const [replyTo, setReplyTo] = useState<{ id: string; author: string } | null>(null);
  const commentsByParent = comments.reduce<Record<string, Array<typeof comments[number]>>>((acc, c) => {
    const key = c.parentId ?? "__root__";
    acc[key] = acc[key] ? [...acc[key], c] : [c];
    return acc;
  }, {});

  const renderComment = (c: CommentsPanelProps["comments"][number], depth = 0) => {
    const children = (commentsByParent[c.id] ?? []).sort((a, b) => a.createdAt - b.createdAt);
    const palette = ["bg-sky-900/40", "bg-blue-900/30", "bg-indigo-900/30"];
    const bubble = palette[depth % palette.length];
    const indent = Math.min(depth, 4) * 14; // px
    const initials = (c.author || "U").slice(0, 2).toUpperCase();
    const isProfessor = c.role === "professor";

    return (
      <div key={c.id} className="relative">
        <div className="flex gap-2">
          <div className="flex-shrink-0">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-white/15 text-xs font-bold text-white">
              {initials}
            </div>
          </div>
          <div
            className={`flex-1 rounded-2xl ${bubble} px-3 py-2 shadow`}
            style={{ marginLeft: indent ? `${indent}px` : undefined }}
          >
            <div className="flex items-center gap-2">
              <p className="text-xs font-semibold text-white">{c.author}</p>
              {isProfessor ? (
                <span className="rounded-full bg-amber-500/30 px-2 py-[1px] text-[10px] font-semibold uppercase tracking-wide text-amber-100">
                  Profesor
                </span>
              ) : null}
            </div>
            <p className="text-sm text-white/90 whitespace-pre-wrap">{c.text}</p>
            <div className="mt-1 flex items-center gap-3 text-[11px] text-white/60">
              <span>{new Date(c.createdAt).toLocaleString()}</span>
              <button
                type="button"
                onClick={() => setReplyTo({ id: c.id, author: c.author })}
                className="font-semibold text-blue-300 hover:text-blue-200"
              >
                Responder
              </button>
            </div>
          </div>
        </div>
        {children.length ? (
          <div className="mt-2 space-y-3 border-l border-white/10 pl-4 ml-4">
            {children.map((child) => renderComment(child, depth + 1))}
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <div className="fixed inset-y-0 right-0 z-40 w-full max-w-md bg-neutral-900/95 backdrop-blur-lg text-white shadow-2xl lg:top-0 lg:right-0">
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
        <div>
          <p className="text-sm font-semibold">Comentarios</p>
          <p className="text-xs text-white/60">Clase {classId.slice(0, 6)}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-full bg-white/10 px-3 py-1 text-xs hover:bg-white/20"
        >
          Cerrar
        </button>
      </div>

      <div className="flex h-[70vh] flex-col gap-3 overflow-y-auto px-4 py-3">
        {loading ? (
          <p className="text-sm text-white/60">Cargando comentarios...</p>
        ) : comments.length === 0 ? (
          <p className="text-sm text-white/60">Sé el primero en comentar.</p>
        ) : (
          (commentsByParent["__root__"] ?? [])
            .sort((a, b) => b.createdAt - a.createdAt)
            .map((c) => renderComment(c, 0))
        )}
      </div>

      <div className="absolute bottom-0 left-0 right-0 border-t border-white/10 bg-neutral-900/95 p-3">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!text.trim()) return;
            onAdd(text.trim(), replyTo?.id ?? null);
            setText("");
            setReplyTo(null);
          }}
          className="flex items-center gap-2"
        >
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={
              replyTo ? `Responder a ${replyTo.author}` : "Escribe un comentario..."
            }
            className="w-full rounded-full border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder:text-white/50 focus:border-blue-500 focus:outline-none"
          />
          {replyTo ? (
            <button
              type="button"
              onClick={() => setReplyTo(null)}
              className="rounded-full bg-white/10 px-3 py-2 text-xs text-white hover:bg-white/20"
            >
              Cancelar
            </button>
          ) : null}
          <button
            type="submit"
            className="rounded-full bg-blue-600 px-3 py-2 text-sm font-semibold text-white hover:bg-blue-500"
          >
            Enviar
          </button>
        </form>
      </div>
    </div>
  );
}

type AssignmentPanelProps = {
  classId: string;
  classTitle?: string;
  templateUrl?: string;
  note: string;
  onChangeNote: (val: string) => void;
  onSubmit: () => void | Promise<void>;
  onClose: () => void;
  selectedFile: File | null;
  onFileChange: (file: File | null) => void;
  uploading: boolean;
  submitted: boolean;
};

function AssignmentPanel({ classId, classTitle, templateUrl, note, onChangeNote, onSubmit, onClose, selectedFile, onFileChange, uploading, submitted }: AssignmentPanelProps) {
  const [dragOver, setDragOver] = useState(false);

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) onFileChange(file);
  };

  return (
    <div className="fixed inset-y-0 right-0 z-40 w-full max-w-md bg-neutral-900/95 backdrop-blur-lg text-white shadow-2xl lg:top-0 lg:right-0">
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
        <div>
          <p className="text-sm font-semibold">Tarea</p>
          <p className="text-xs text-white/60">Clase {classTitle ?? classId.slice(0, 6)}</p>
        </div>
        {submitted ? (
          <span className="rounded-full bg-green-600/20 px-3 py-1 text-xs font-semibold text-green-200">
            Tarea enviada
          </span>
        ) : null}
        <button
          type="button"
          onClick={onClose}
          className="rounded-full bg-white/10 px-3 py-1 text-xs hover:bg-white/20"
        >
          Cerrar
        </button>
      </div>

      <div className="flex h-[70vh] flex-col gap-4 overflow-y-auto px-4 py-4">
        <div className="rounded-2xl bg-white/5 p-3 text-sm text-white/90">
          {templateUrl ? (
            <a
              href={templateUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-2 rounded-full bg-blue-600 px-3 py-2 text-sm font-semibold text-white hover:bg-blue-500"
            >
              <ControlIcon name="assignment" />
              Descargar plantilla
            </a>
          ) : (
            <p className="text-white/60">No hay plantilla adjunta.</p>
          )}
        </div>

        {submitted ? (
          <div className="flex flex-col items-center justify-center gap-3 rounded-2xl bg-white/5 p-4 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-green-500/20 text-green-200">
              <ControlIcon name="check" />
            </div>
            <p className="text-sm font-semibold text-white">Tarea enviada</p>
            <p className="text-xs text-white/60">Ya registramos tu entrega para esta clase.</p>
          </div>
        ) : (
          <div className="rounded-2xl bg-white/5 p-3">
            <p className="mb-2 text-sm font-semibold text-white">Enlace o notas de la tarea</p>
            <textarea
              value={note}
              onChange={(e) => onChangeNote(e.target.value)}
              placeholder="Pega aquí el enlace de tu entrega o notas para el profesor"
              className="h-32 w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white placeholder:text-white/50 focus:border-blue-500 focus:outline-none"
            />
            <div className="mt-3 space-y-2 text-sm text-white/90">
              <p className="font-semibold text-white">Adjuntar archivo (PDF o DOC)</p>
              <div
                onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={handleDrop}
                className={`relative flex min-h-[120px] cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed ${
                  dragOver ? "border-blue-400 bg-blue-500/10" : "border-white/20 bg-white/5"
                } px-4 py-3 text-center transition`}
                onClick={() => document.getElementById(`assignment-file-${classId}`)?.click()}
              >
                <input
                  id={`assignment-file-${classId}`}
                  type="file"
                  accept=".pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                  className="hidden"
                  onChange={(e) => onFileChange(e.target.files?.[0] ?? null)}
                />
                <ControlIcon name="assignment" />
                <p className="mt-2 text-sm font-semibold text-white">Arrastra aquí o haz clic para subir</p>
                <p className="text-xs text-white/60">Formatos: PDF, DOC, DOCX</p>
                {selectedFile ? (
                  <p className="mt-2 text-xs text-white/80">Seleccionado: {selectedFile.name}</p>
                ) : (
                  <p className="mt-2 text-xs text-white/50">Máx. 1 archivo</p>
                )}
              </div>
            </div>
            <button
              type="button"
              onClick={onSubmit}
              disabled={uploading}
              className={`mt-3 inline-flex items-center justify-center rounded-full px-4 py-2 text-sm font-semibold text-white ${
                uploading ? "bg-green-600/60 cursor-wait" : "bg-green-600 hover:bg-green-500"
              }`}
            >
              {uploading ? "Enviando..." : "Enviar tarea"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function ImageCarousel({
  images,
  title,
  activeIndex = 0,
  isActive = true,
  onIndexChange,
  onProgress,
}: {
  images: string[];
  title: string;
  activeIndex?: number;
  isActive?: boolean;
  onIndexChange?: (idx: number) => void;
  onProgress?: (pct: number) => void;
}) {
  const [currentIndex, setCurrentIndex] = useState(activeIndex);
  const containerRef = useRef<HTMLDivElement>(null);
  const startXRef = useRef<number>(0);
  const isDraggingRef = useRef(false);
  const onProgressRef = useRef(onProgress);

  useEffect(() => {
    onProgressRef.current = onProgress;
  }, [onProgress]);

  useEffect(() => {
    setCurrentIndex(activeIndex);
    if (onProgressRef.current && isActive) {
      const pct = images.length > 0 ? ((activeIndex + 1) / images.length) * 100 : 0;
      onProgressRef.current(Math.min(100, Math.max(0, pct)));
    }
  }, [activeIndex, images.length, isActive]);

  // Mantener scroll en sync cuando cambia activeIndex externamente
  useEffect(() => {
    if (!containerRef.current) return;
    const slideWidth = containerRef.current.offsetWidth;
    containerRef.current.scrollTo({ left: slideWidth * (activeIndex ?? 0), behavior: "smooth" });
  }, [activeIndex]);

  const reportProgress = useCallback((index: number) => {
    if (!onProgressRef.current || !isActive) return;
    const isLast = images.length > 0 && index >= images.length - 1;
    const pct = images.length > 0 ? ((index + 1) / images.length) * 100 : 0;
    onProgressRef.current(isLast ? 100 : Math.min(100, Math.max(0, pct)));
  }, [images.length, isActive]);

  const scrollToIndex = (index: number) => {
    const newIndex = Math.max(0, Math.min(index, images.length - 1));
    setCurrentIndex(newIndex);
    onIndexChange?.(newIndex);
    reportProgress(newIndex);

    if (containerRef.current) {
      const slideWidth = containerRef.current.offsetWidth;
      containerRef.current.scrollTo({
        left: slideWidth * newIndex,
        behavior: 'smooth'
      });
    }
  };

  const handleTouchStart = (e: React.TouchEvent) => {
    startXRef.current = e.touches[0].clientX;
    isDraggingRef.current = true;
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    if (!isDraggingRef.current) return;

    const endX = e.changedTouches[0].clientX;
    const diffX = startXRef.current - endX;
    const threshold = 50; // mínimo swipe para cambiar

    if (Math.abs(diffX) > threshold) {
      if (diffX > 0 && currentIndex < images.length - 1) {
        // Swipe left -> siguiente
        scrollToIndex(currentIndex + 1);
      } else if (diffX < 0 && currentIndex > 0) {
        // Swipe right -> anterior
        scrollToIndex(currentIndex - 1);
      }
    }

    isDraggingRef.current = false;
  };

  const handleScroll = useCallback(() => {
    const container = containerRef.current;
    if (!container || !isActive) return;
    const width = container.offsetWidth || 1;
    const raw = container.scrollLeft / width;
    let idx = Math.round(raw);
    // Clamp to last slide when near the end to evitar quedarse en 99%
    if (container.scrollLeft + width >= container.scrollWidth - width * 0.2) {
      idx = images.length - 1;
    }
    idx = Math.max(0, Math.min(idx, images.length - 1));
    if (idx !== currentIndex) {
      setCurrentIndex(idx);
      onIndexChange?.(idx);
    }
    reportProgress(idx);
  }, [currentIndex, images.length, isActive, onIndexChange, reportProgress]);

  const handleMouseDown = (e: React.MouseEvent) => {
    startXRef.current = e.clientX;
    isDraggingRef.current = true;
  };

  const handleMouseUp = (e: React.MouseEvent) => {
    if (!isDraggingRef.current) return;

    const endX = e.clientX;
    const diffX = startXRef.current - endX;
    const threshold = 50;

    if (Math.abs(diffX) > threshold) {
      if (diffX > 0 && currentIndex < images.length - 1) {
        scrollToIndex(currentIndex + 1);
      } else if (diffX < 0 && currentIndex > 0) {
        scrollToIndex(currentIndex - 1);
      }
    }

    isDraggingRef.current = false;
  };

  return (
    <div className="relative w-full h-full bg-black overflow-hidden flex items-center justify-center">
      {/* Contenedor con scroll horizontal */}
      <div
        ref={containerRef}
        className="flex h-full w-full overflow-x-scroll snap-x snap-mandatory scroll-smooth no-scrollbar"
        style={{
          scrollbarWidth: 'none',
          msOverflowStyle: 'none',
          WebkitOverflowScrolling: 'touch'
        }}
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
        onMouseDown={handleMouseDown}
        onMouseUp={handleMouseUp}
        onScroll={handleScroll}
      >
        {images.map((src, idx) => (
          <div
            key={idx}
            className="flex-shrink-0 w-full h-full flex items-center justify-center snap-center snap-always"
          >
            <img
              src={src}
              alt={`${title} - ${idx + 1}/${images.length}`}
              className="max-w-full max-h-full w-auto h-auto object-contain select-none"
              draggable={false}
            />
          </div>
        ))}
      </div>

      {/* Botones de navegación */}
      {images.length > 1 && (
        <>
          <button
            type="button"
            onClick={() => scrollToIndex(currentIndex - 1)}
            disabled={currentIndex === 0}
            className="absolute left-4 top-1/2 -translate-y-1/2 rounded-full bg-black/60 p-3 text-white shadow-lg hover:bg-black/80 disabled:opacity-30 disabled:cursor-not-allowed z-10"
            aria-label="Imagen anterior"
          >
            <svg className="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <button
            type="button"
            onClick={() => scrollToIndex(currentIndex + 1)}
            disabled={currentIndex === images.length - 1}
            className="absolute right-4 top-1/2 -translate-y-1/2 rounded-full bg-black/60 p-3 text-white shadow-lg hover:bg-black/80 disabled:opacity-30 disabled:cursor-not-allowed z-10"
            aria-label="Imagen siguiente"
          >
            <svg className="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </button>
        </>
      )}

      {/* Indicadores */}
      {images.length > 1 && (
        <div className="absolute bottom-8 left-1/2 -translate-x-1/2 flex gap-2 z-10">
          {images.map((_, idx) => (
            <button
              key={idx}
              onClick={() => scrollToIndex(idx)}
              className={`h-2 rounded-full transition-all duration-300 ${
                idx === currentIndex
                  ? 'bg-white w-8'
                  : 'bg-white/50 w-2 hover:bg-white/70'
              }`}
              aria-label={`Ir a imagen ${idx + 1}`}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function isEmbedUrl(url: string) {
  return /youtube\.com|youtu\.be|vimeo\.com/.test(url);
}

function toEmbedUrl(url: string) {
  const safe = url.trim();
  if (safe.includes("youtu.be")) {
    const id = safe.split("youtu.be/")[1]?.split(/[?&]/)[0];
    return `https://www.youtube.com/embed/${id ?? ""}`;
  }
  if (safe.includes("youtube.com/watch")) {
    const params = new URL(safe).searchParams;
    const id = params.get("v") ?? "";
    return `https://www.youtube.com/embed/${id}`;
  }
  if (safe.includes("vimeo.com")) {
    try {
      const u = new URL(safe);
      const parts = u.pathname.split("/").filter(Boolean);
      const id = parts[0] ?? "";
      const hash = parts[1] ?? "";
      const hParam = hash ? `?h=${hash}` : "";
      return `https://player.vimeo.com/video/${id}${hParam}`;
    } catch {
      const raw = safe.split("vimeo.com/")[1] ?? "";
      const [idRaw, hashRaw] = raw.split("/");
      const hParam = hashRaw ? `?h=${hashRaw}` : "";
      return `https://player.vimeo.com/video/${idRaw ?? ""}${hParam}`;
    }
  }
  return safe;
}
