"use client";

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useRouter } from "next/navigation";
import { onAuthStateChanged, signOut, type User } from "firebase/auth";
import { doc, onSnapshot } from "firebase/firestore";
import { auth } from "@/lib/firebase/client";
import { db } from "@/lib/firebase/firestore";
import { isStudentStatusBlocked } from "@/lib/students/status";
import { validateBillingStatus } from "./billing";
import { buildCurriculum, loadForumStatuses } from "./curriculum";
import { loadCachedAula, saveCachedAula } from "./feed-cache";
import {
  courseClosureKey,
  loadStudentCourses,
  loadStudentEnrollments,
  NO_ENROLLMENTS_MESSAGE,
  type StudentFeed,
} from "./feed-loader";
import {
  filterVisibleClasses,
  getRequiredPct,
  isClassComplete,
  isClassLocked,
} from "./gating";
import {
  loadLocalProgress,
  loadProgressFromFirestore,
  markClassCompletedManually,
  saveProgressToFirestore,
} from "./progress";
import type {
  BillingBlockedState,
  CurriculumCourse,
  FeedClass,
  ProgressSnapshot,
} from "./types";

type AulaDataValue = {
  loading: boolean;
  error: string | null;
  billingBlocked: BillingBlockedState | null;
  currentUser: User | null;
  studentName: string;
  classes: FeedClass[];
  curriculum: CurriculumCourse[];
  courseCovers: Record<string, string>;
  courseTitles: Record<string, string>;
  progress: ProgressSnapshot;
  forumDone: Record<string, boolean>;
  isComplete: (cls: FeedClass) => boolean;
  isLockedAt: (index: number) => boolean;
  indexOfClass: (classId: string) => number;
  isCourseClosed: (cls: FeedClass) => boolean;
  reportProgress: (cls: FeedClass, pct: number) => void;
  markComplete: (cls: FeedClass) => Promise<boolean>;
  refreshForumStatus: () => Promise<void>;
};

const AulaDataContext = createContext<AulaDataValue | null>(null);

export const useAulaData = () => {
  const value = useContext(AulaDataContext);
  if (!value) throw new Error("useAulaData debe usarse dentro de AulaDataProvider");
  return value;
};

const emptyProgress: ProgressSnapshot = { progress: {}, completed: {}, seen: {} };

/** Umbral de escritura: evita un write por cada tick del reproductor. */
const PROGRESS_WRITE_STEP = 2;

export function AulaDataProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [currentUser, setCurrentUser] = useState<User | null>(auth.currentUser);
  const [authLoading, setAuthLoading] = useState(!auth.currentUser);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [billingBlocked, setBillingBlocked] = useState<BillingBlockedState | null>(null);
  const [feed, setFeed] = useState<StudentFeed | null>(null);
  const [progress, setProgress] = useState<ProgressSnapshot>(emptyProgress);
  const [forumDone, setForumDone] = useState<Record<string, boolean>>({});

  const progressRef = useRef<ProgressSnapshot>(emptyProgress);
  const lastWrittenRef = useRef<Record<string, number>>({});

  useEffect(() => {
    progressRef.current = progress;
  }, [progress]);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      setCurrentUser(user);
      setAuthLoading(false);
    });
    return () => unsubscribe();
  }, []);

  // Estado de la cuenta: archivado expulsa; contraseña temporal se resuelve en /feed.
  useEffect(() => {
    if (!currentUser?.uid) return;
    const unsubscribe = onSnapshot(doc(db, "users", currentUser.uid), (snap) => {
      const userData = snap.data();
      if (isStudentStatusBlocked(userData?.estado ?? userData?.status)) {
        void signOut(auth).finally(() => router.replace("/"));
        return;
      }
      if (userData?.mustChangePassword === true) {
        router.replace("/feed");
      }
    });
    return () => unsubscribe();
  }, [currentUser?.uid, router]);

  useEffect(() => {
    if (authLoading) return;
    if (!currentUser) {
      router.replace("/");
      return;
    }

    let cancelled = false;

    const load = async () => {
      setError(null);

      // El contenido cacheado pinta de inmediato; abajo se revalida igualmente.
      // El progreso se siembra de localStorage para no mostrar candados de más.
      const cached = loadCachedAula(currentUser.uid);
      if (cached) {
        const localProgress = loadLocalProgress(currentUser.uid);
        setFeed(cached.feed);
        setForumDone(cached.forumDone);
        setProgress(localProgress);
        progressRef.current = localProgress;
        setLoading(false);
      } else {
        setLoading(true);
      }

      try {
        // El estado de pagos y las inscripciones no dependen entre sí.
        const [billing, enrollments] = await Promise.all([
          validateBillingStatus(currentUser),
          loadStudentEnrollments(currentUser),
        ]);
        if (cancelled) return;

        if (billing.status === "error") {
          setError(billing.message);
          setLoading(false);
          return;
        }
        if (billing.status === "blocked") {
          setBillingBlocked(billing.blocked);
          setLoading(false);
          return;
        }
        setBillingBlocked(null);

        if (!enrollments) {
          setError(NO_ENROLLMENTS_MESSAGE);
          setLoading(false);
          return;
        }

        // El progreso solo necesita los enrollmentIds, así que no espera al contenido.
        const [coursesResult, progressSnapshot] = await Promise.all([
          loadStudentCourses(currentUser, enrollments),
          loadProgressFromFirestore(currentUser.uid, enrollments.enrollmentIds),
        ]);
        if (cancelled) return;

        if (coursesResult.status === "empty") {
          setError(coursesResult.message);
          setLoading(false);
          return;
        }

        setProgress(progressSnapshot);
        progressRef.current = progressSnapshot;
        setFeed(coursesResult.feed);

        const forumStatuses = await loadForumStatuses(
          currentUser.uid,
          coursesResult.feed.classes,
        );
        if (cancelled) return;
        setForumDone(forumStatuses);
        saveCachedAula(currentUser.uid, {
          feed: coursesResult.feed,
          forumDone: forumStatuses,
        });
      } catch (err) {
        console.error(err);
        // Con contenido cacheado en pantalla, un fallo de red no debe borrarlo.
        if (!cancelled && !cached) setError("No se pudieron cargar tus clases");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [authLoading, currentUser, router]);

  const visibleClasses = useMemo(() => {
    if (!feed) return [];
    const closed = feed.courseClosures;
    return filterVisibleClasses(feed.classes).filter((cls) => {
      const closure = closed[courseClosureKey(cls.enrollmentId, cls.courseId)];
      if (closure?.status === "closed") return cls.studyOnly === true;
      return true;
    });
  }, [feed]);

  // Estables entre renders: los consumidores los usan como dependencias de efectos.
  const courseTitles = useMemo(() => feed?.courseTitles ?? {}, [feed]);
  const courseCovers = useMemo(() => feed?.courseCovers ?? {}, [feed]);

  const curriculum = useMemo(
    () => buildCurriculum(visibleClasses, courseTitles),
    [visibleClasses, courseTitles],
  );

  const isComplete = useCallback(
    (cls: FeedClass) => isClassComplete(cls, progress, forumDone),
    [progress, forumDone],
  );

  const isLockedAt = useCallback(
    (index: number) => isClassLocked(visibleClasses, index, progress, forumDone),
    [visibleClasses, progress, forumDone],
  );

  const indexOfClass = useCallback(
    (classId: string) => visibleClasses.findIndex((cls) => cls.id === classId),
    [visibleClasses],
  );

  const isCourseClosed = useCallback(
    (cls: FeedClass) =>
      feed?.courseClosures[courseClosureKey(cls.enrollmentId, cls.courseId)]?.status === "closed",
    [feed],
  );

  const reportProgress = useCallback(
    (cls: FeedClass, pct: number) => {
      if (!currentUser?.uid || !cls.enrollmentId) return;
      const bounded = Math.max(0, Math.min(100, Math.round(pct)));
      const previous = progressRef.current.progress[cls.id] ?? 0;
      if (bounded <= previous) return;

      const requiredPct = getRequiredPct(cls.type);
      const nowComplete = bounded >= requiredPct;

      setProgress((prev) => ({
        progress: { ...prev.progress, [cls.id]: bounded },
        completed: nowComplete ? { ...prev.completed, [cls.id]: true } : prev.completed,
        seen: nowComplete ? { ...prev.seen, [cls.id]: true } : prev.seen,
      }));

      const lastWritten = lastWrittenRef.current[cls.id] ?? -1;
      const crossedThreshold = previous < requiredPct && nowComplete;
      if (!crossedThreshold && bounded - lastWritten < PROGRESS_WRITE_STEP) return;
      lastWrittenRef.current[cls.id] = bounded;

      void saveProgressToFirestore({
        uid: currentUser.uid,
        enrollmentId: cls.enrollmentId,
        classId: cls.id,
        progress: bounded,
        previousProgress: previous,
        requiredPct,
        alreadySeen: progressRef.current.seen[cls.id] === true,
      });
    },
    [currentUser?.uid],
  );

  const markComplete = useCallback(
    async (cls: FeedClass) => {
      if (!currentUser?.uid || !cls.enrollmentId) return false;
      const ok = await markClassCompletedManually({
        uid: currentUser.uid,
        enrollmentId: cls.enrollmentId,
        classId: cls.id,
      });
      if (!ok) return false;
      setProgress((prev) => ({
        progress: { ...prev.progress, [cls.id]: 100 },
        completed: { ...prev.completed, [cls.id]: true },
        seen: { ...prev.seen, [cls.id]: true },
      }));
      return true;
    },
    [currentUser?.uid],
  );

  const refreshForumStatus = useCallback(async () => {
    if (!currentUser?.uid || !feed) return;
    const statuses = await loadForumStatuses(currentUser.uid, feed.classes);
    setForumDone(statuses);
    saveCachedAula(currentUser.uid, { feed, forumDone: statuses });
  }, [currentUser?.uid, feed]);

  const value = useMemo<AulaDataValue>(
    () => ({
      loading: loading || authLoading,
      error,
      billingBlocked,
      currentUser,
      studentName: feed?.studentName ?? "",
      classes: visibleClasses,
      curriculum,
      courseCovers,
      courseTitles,
      progress,
      forumDone,
      isComplete,
      isLockedAt,
      indexOfClass,
      isCourseClosed,
      reportProgress,
      markComplete,
      refreshForumStatus,
    }),
    [
      loading,
      authLoading,
      error,
      billingBlocked,
      currentUser,
      feed,
      visibleClasses,
      curriculum,
      courseCovers,
      courseTitles,
      progress,
      forumDone,
      isComplete,
      isLockedAt,
      indexOfClass,
      isCourseClosed,
      reportProgress,
      markComplete,
      refreshForumStatus,
    ],
  );

  return <AulaDataContext.Provider value={value}>{children}</AulaDataContext.Provider>;
}
