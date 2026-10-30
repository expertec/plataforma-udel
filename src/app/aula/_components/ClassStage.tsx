"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import Image from "next/image";
import Link from "next/link";
import { ChevronLeft, ChevronRight, Radio } from "lucide-react";
import { AudioPlayer, QuizContent, VideoPlayer } from "@/app/student/StudentFeedPageClient";
import { useAulaData } from "../_lib/AulaDataContext";
import { buildLiveClassHref } from "../_lib/gating";
import type { FeedClass } from "../_lib/types";

function StageFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative aspect-video w-full overflow-hidden rounded-2xl bg-black">
      {children}
    </div>
  );
}

function VideoStage({ cls }: { cls: FeedClass }) {
  const { reportProgress, progress } = useAulaData();
  const [muted, setMuted] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const handleProgress = useCallback(
    (pct: number) => reportProgress(cls, pct),
    [reportProgress, cls],
  );

  return (
    <StageFrame>
      <VideoPlayer
        id={cls.id}
        src={cls.videoUrl ?? ""}
        isActive
        muted={muted}
        onToggleMute={() => setMuted((prev) => !prev)}
        registerRef={(el) => {
          videoRef.current = el;
        }}
        onProgress={handleProgress}
        initialProgress={progress.progress[cls.id] ?? 0}
      />
    </StageFrame>
  );
}

function AudioStage({ cls }: { cls: FeedClass }) {
  const { reportProgress } = useAulaData();
  return (
    <div className="rounded-2xl border border-[var(--aula-border)] bg-[var(--aula-surface)] p-6">
      <AudioPlayer
        src={cls.audioUrl ?? ""}
        title={cls.title}
        onProgress={(pct: number) => reportProgress(cls, pct)}
        onComplete={() => reportProgress(cls, 100)}
      />
    </div>
  );
}

function ImageStage({ cls }: { cls: FeedClass }) {
  const { reportProgress } = useAulaData();
  const images = cls.images ?? [];
  const [index, setIndex] = useState(0);
  const maxSeenRef = useRef(0);

  useEffect(() => {
    maxSeenRef.current = Math.max(maxSeenRef.current, index);
    if (images.length === 0) return;
    // Solo al recorrer la última imagen se considera vista por completo.
    reportProgress(cls, Math.round(((maxSeenRef.current + 1) / images.length) * 100));
  }, [index, images.length, cls, reportProgress]);

  if (images.length === 0) {
    return <p className="text-[var(--aula-text-muted)]">Esta clase no tiene imágenes.</p>;
  }

  return (
    <div className="space-y-3">
      <StageFrame>
        <Image
          src={images[index]}
          alt={`${cls.title} — imagen ${index + 1}`}
          fill
          unoptimized
          className="object-contain"
        />
      </StageFrame>
      {images.length > 1 && (
        <div className="flex items-center justify-center gap-4">
          <button
            type="button"
            onClick={() => setIndex((prev) => Math.max(0, prev - 1))}
            disabled={index === 0}
            className="rounded-lg border border-[var(--aula-border)] p-2 text-[var(--aula-text)] disabled:opacity-40"
            aria-label="Imagen anterior"
          >
            <ChevronLeft size={18} />
          </button>
          <span className="text-sm text-[var(--aula-text-muted)]">
            {index + 1} / {images.length}
          </span>
          <button
            type="button"
            onClick={() => setIndex((prev) => Math.min(images.length - 1, prev + 1))}
            disabled={index === images.length - 1}
            className="rounded-lg border border-[var(--aula-border)] p-2 text-[var(--aula-text)] disabled:opacity-40"
            aria-label="Imagen siguiente"
          >
            <ChevronRight size={18} />
          </button>
        </div>
      )}
    </div>
  );
}

function LiveStage({ cls }: { cls: FeedClass }) {
  const { currentUser } = useAulaData();
  const [recordingUrl, setRecordingUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const session = cls.liveSession;
  const status = session?.status;
  const isLive = status === "live";
  const finalized = Boolean(session?.lastEndedAt) || status === "ended" || status === "recording_ready";
  const recordingStatus = session?.recording.status ?? "idle";
  const recordingReady = status === "recording_ready" || recordingStatus === "ready";
  const canOpenRecording = finalized && recordingStatus !== "failed" && (
    recordingReady || Boolean(session?.recording.storagePath) ||
    recordingStatus === "recording" || recordingStatus === "processing"
  );

  const openRecording = async () => {
    if (loading) return;
    setLoading(true);
    setError(null);
    try {
      if (!currentUser) throw new Error("Inicia sesión para ver la grabación.");
      const classId = (cls.classDocId ?? cls.id).trim();
      if (!classId) throw new Error("No se pudo identificar la clase.");
      const token = await currentUser.getIdToken();
      const params = new URLSearchParams();
      if (cls.courseId?.trim()) params.set("courseId", cls.courseId.trim());
      if (cls.lessonId?.trim()) params.set("lessonId", cls.lessonId.trim());
      const query = params.toString();
      const response = await fetch(
        `/api/live/classes/${encodeURIComponent(classId)}/recording${query ? `?${query}` : ""}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      const payload = (await response.json().catch(() => null)) as
        | { success?: boolean; data?: { url?: string }; error?: string }
        | null;
      if (!response.ok || !payload?.success || !payload.data?.url) {
        throw new Error(payload?.error || "La grabación no está disponible");
      }
      setRecordingUrl(payload.data.url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo abrir la grabación");
    } finally {
      setLoading(false);
    }
  };

  if (recordingUrl) {
    return (
      <div className="space-y-3">
        <StageFrame>
          <video
            key={recordingUrl}
            src={recordingUrl}
            controls
            playsInline
            preload="metadata"
            aria-label={`Grabación de ${cls.title}`}
            className="absolute inset-0 h-full w-full object-contain"
            onError={(event) => {
              const code = event.currentTarget.error?.code;
              const message = code === 2
                ? "No se pudo descargar la grabación. Reintenta para renovar el acceso al archivo."
                : code === 3
                  ? "El navegador no pudo decodificar la grabación."
                  : code === 4
                    ? "No se pudo cargar la grabación: el archivo no está accesible o su formato no es compatible."
                    : "No se pudo reproducir la grabación.";
              setError(message);
            }}
          />
        </StageFrame>
        {error && (
          <div role="alert" className="text-sm text-[var(--aula-text-muted)]">
            <p>{error}</p>
            <button
              type="button"
              disabled={loading}
              onClick={() => {
                setRecordingUrl(null);
                void openRecording();
              }}
              className="mt-2 rounded-xl bg-[var(--aula-accent)] px-4 py-2 font-semibold text-white disabled:opacity-50"
            >
              {loading ? "Verificando..." : "Reintentar grabación"}
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-[var(--aula-border)] bg-[var(--aula-surface)] p-8 text-center">
      <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-red-500/15 text-red-400">
        <Radio size={26} />
      </div>
      <h2 className="mt-4 text-xl font-semibold text-[var(--aula-text)]">{cls.title}</h2>
      <p className="mt-2 text-[var(--aula-text-muted)]">
        {isLive
          ? "La clase en vivo está transmitiendo ahora."
          : status === "ended" || status === "recording_ready"
            ? "Esta clase en vivo ya terminó."
            : "Esta clase se imparte en vivo."}
      </p>
      {canOpenRecording && (
        <button
          type="button"
          onClick={openRecording}
          disabled={loading}
          className="mt-6 inline-flex rounded-xl bg-[var(--aula-accent)] px-5 py-2.5 text-sm font-semibold text-white disabled:opacity-50"
        >
          {loading ? "Verificando..." : recordingReady ? "Ver grabación" : "Verificar grabación"}
        </button>
      )}
      {finalized && (
        <p role={error ? "alert" : undefined} className="mt-3 text-sm text-[var(--aula-text-muted)]">
          {error || (recordingStatus === "failed"
            ? "La grabación falló y no pudo guardarse."
            : canOpenRecording
              ? recordingReady
                ? "La grabación está lista para cargarse."
                : "La grabación sigue procesándose. Puedes verificar si ya está disponible."
              : "Esta clase terminó sin grabación disponible.")}
        </p>
      )}
      <Link
        href={buildLiveClassHref({
          classId: cls.classDocId ?? cls.id,
          courseId: cls.courseId,
          lessonId: cls.lessonId,
        })}
        className="mt-6 inline-flex rounded-xl bg-[var(--aula-accent)] px-5 py-2.5 text-sm font-semibold text-white"
      >
        {isLive ? "Entrar a la clase en vivo" : "Ir a la sala de la clase"}
      </Link>
    </div>
  );
}

function QuizStage({ cls }: { cls: FeedClass }) {
  const { reportProgress, isCourseClosed, currentUser, studentName } = useAulaData();
  return (
    <div className="rounded-2xl border border-[var(--aula-border)] bg-[var(--aula-surface)] p-6">
      <QuizContent
        assessmentKind={cls.assessmentKind}
        classId={cls.id}
        classDocId={cls.classDocId}
        courseId={cls.courseId}
        courseTitle={cls.courseTitle}
        lessonId={cls.lessonId}
        lessonTitle={cls.lessonTitle}
        courseClosed={isCourseClosed(cls)}
        enrollmentId={cls.enrollmentId}
        groupId={cls.groupId}
        classTitle={cls.classTitle}
        studentName={studentName}
        studentId={currentUser?.uid}
        isActive
        onProgress={(pct: number) => reportProgress(cls, pct)}
      />
    </div>
  );
}

function InPersonStage({ cls }: { cls: FeedClass }) {
  return (
    <div className="flex aspect-video w-full items-center justify-center rounded-2xl border border-[var(--aula-border)] bg-[var(--aula-surface)] px-6 text-center">
      <div className="max-w-md">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-amber-300">
          Grupo presencial
        </p>
        <h2 className="mt-2 text-xl font-semibold text-[var(--aula-text)]">{cls.title}</h2>
        <p className="mt-2 text-sm text-[var(--aula-text-muted)]">
          Este grupo se gestiona presencialmente. Aquí solo verás y enviarás tareas.
        </p>
      </div>
    </div>
  );
}

function TextStage({ cls, html }: { cls: FeedClass; html: string }) {
  const { reportProgress } = useAulaData();
  const endRef = useRef<HTMLDivElement | null>(null);

  // Se considera leída cuando el final del texto entra en pantalla.
  useEffect(() => {
    const sentinel = endRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) reportProgress(cls, 100);
      },
      { threshold: 0.5 },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [cls, reportProgress]);

  return (
    <article className="rounded-2xl border border-[var(--aula-border)] bg-[var(--aula-surface)] p-6">
      <div
        className="aula-prose"
        dangerouslySetInnerHTML={{ __html: html }}
      />
      <div ref={endRef} aria-hidden className="h-px" />
    </article>
  );
}

export function ClassStage({ cls, contentHtml }: { cls: FeedClass; contentHtml: string }) {
  let stage: ReactNode;

  if (cls.groupIsInPerson === true && cls.assessmentKind !== "final") stage = <InPersonStage cls={cls} />;
  else if (cls.type === "quiz") stage = <QuizStage cls={cls} />;
  else if (cls.type === "live") stage = <LiveStage key={cls.id} cls={cls} />;
  else if (cls.type === "audio" && cls.audioUrl) stage = <AudioStage cls={cls} />;
  else if (cls.type === "image") stage = <ImageStage cls={cls} />;
  else if (cls.type === "text") stage = <TextStage cls={cls} html={contentHtml} />;
  else if (cls.videoUrl) stage = <VideoStage cls={cls} />;
  else {
    stage = (
      <div className="rounded-2xl border border-[var(--aula-border)] bg-[var(--aula-surface)] p-8 text-center text-[var(--aula-text-muted)]">
        Esta clase todavía no tiene contenido para mostrar.
      </div>
    );
  }

  return (
    <div data-tour="aula-class-stage">
      {stage}
    </div>
  );
}
