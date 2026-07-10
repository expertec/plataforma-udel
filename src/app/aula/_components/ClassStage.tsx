"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
  const status = cls.liveSession?.status;
  const isLive = status === "live";

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
  if (cls.type === "quiz") return <QuizStage cls={cls} />;
  if (cls.type === "live") return <LiveStage cls={cls} />;
  if (cls.type === "audio" && cls.audioUrl) return <AudioStage cls={cls} />;
  if (cls.type === "image") return <ImageStage cls={cls} />;
  if (cls.type === "text") return <TextStage cls={cls} html={contentHtml} />;
  if (cls.videoUrl) return <VideoStage cls={cls} />;

  return (
    <div className="rounded-2xl border border-[var(--aula-border)] bg-[var(--aula-surface)] p-8 text-center text-[var(--aula-text-muted)]">
      Esta clase todavía no tiene contenido para mostrar.
    </div>
  );
}
