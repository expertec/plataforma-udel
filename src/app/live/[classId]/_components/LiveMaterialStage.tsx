"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Loader2, Pause, Play, RotateCcw, Volume2, VolumeX, X } from "lucide-react";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import { presentationPosition, type LiveMaterial, type MaterialPresentation } from "@/lib/live-classes/materials";
import { MATERIAL_KIND_LABEL, type LiveMaterialsModel } from "./LiveMaterialsPanel";
import { PowerPointMaterial } from "./PowerPointMaterial";
import { GoogleMaterial } from "./GoogleMaterial";

type Control = (changes: Record<string, unknown>) => Promise<boolean>;

function DocumentControls({ page, count, teacher, busy, onControl }: {
  page: number; count: number; teacher: boolean; busy: boolean; onControl: Control;
}) {
  return <div className="flex shrink-0 items-center justify-center gap-3 border-t border-white/10 bg-slate-900 px-3 py-2 text-sm">
    {teacher ? <button type="button" aria-label="Página anterior" disabled={busy || page <= 1} onClick={() => { void onControl({ page: page - 1 }); }} className="rounded-lg p-2 hover:bg-white/10 disabled:opacity-30"><ChevronLeft className="h-4 w-4" /></button> : null}
    <span>{page} / {count || "…"}</span>
    {teacher ? <button type="button" aria-label="Página siguiente" disabled={busy || !count || page >= count} onClick={() => { void onControl({ page: page + 1 }); }} className="rounded-lg p-2 hover:bg-white/10 disabled:opacity-30"><ChevronRight className="h-4 w-4" /></button> : null}
    {!teacher ? <span className="text-xs text-slate-400">El profesor controla la página</span> : null}
  </div>;
}

function PdfMaterial({ material, state, teacher, busy, onControl }: {
  material: LiveMaterial; state: MaterialPresentation; teacher: boolean; busy: boolean; onControl: Control;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [size, setSize] = useState({ width: 800, height: 600 });
  const [error, setError] = useState<string | null>(null);
  const [rendering, setRendering] = useState(true);
  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setSize({
      width: Math.max(1, Math.floor(entry.contentRect.width - 24)),
      height: Math.max(1, Math.floor(entry.contentRect.height - 24)),
    }));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let disposed = false;
    let task: ReturnType<typeof import("pdfjs-dist").getDocument> | undefined;
    void (async () => {
      const pdfjs = await import("pdfjs-dist");
      if (disposed) return;
      pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
      task = pdfjs.getDocument({ url: material.url, useSystemFonts: true, isEvalSupported: false });
      const document = await task.promise;
      if (!disposed) setPdf(document);
    })().catch(() => { if (!disposed) setError("No se pudo abrir este PDF. Comprueba que no esté dañado o protegido con contraseña."); });
    return () => { disposed = true; void task?.destroy().catch(() => {}); };
  }, [material.url]);

  useEffect(() => {
    if (!pdf || !canvasRef.current) return;
    let disposed = false;
    let renderTask: RenderTask | undefined;
    setRendering(true);
    const canvas = canvasRef.current;
    void (async () => {
      const page = await pdf.getPage(Math.min(state.page, pdf.numPages));
      if (disposed) return;
      const natural = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: Math.max(0.01, Math.min(size.width / natural.width, size.height / natural.height, 2)) });
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(viewport.width * ratio);
      canvas.height = Math.floor(viewport.height * ratio);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Canvas unavailable");
      renderTask = page.render({ canvas, canvasContext: context, viewport, transform: [ratio, 0, 0, ratio, 0, 0] });
      await renderTask.promise;
    })().catch(() => { if (!disposed) setError("No se pudo mostrar esta página del PDF."); })
      .finally(() => { if (!disposed) setRendering(false); });
    return () => { disposed = true; renderTask?.cancel(); };
  }, [pdf, state.page, size]);

  return <>
    <div ref={containerRef} className="relative min-h-0 flex-1 overflow-auto bg-slate-800 p-3">
      {error ? <p role="alert" className="p-6 text-center text-sm text-red-200">{error}</p> : <>
        {rendering ? <div role="status" className="absolute inset-x-0 top-6 flex justify-center"><Loader2 className="h-6 w-6 animate-spin text-sky-300" /></div> : null}
        <canvas ref={canvasRef} aria-label={`PDF: ${material.name}, página ${state.page}`} className={`mx-auto bg-white shadow-lg ${rendering ? "invisible" : ""}`} />
      </>}
    </div>
    <DocumentControls page={state.page} count={pdf?.numPages ?? 0} teacher={teacher} busy={busy} onControl={onControl} />
  </>;
}

type YouTubePlayer = {
  playVideo(): void; pauseVideo(): void; seekTo(seconds: number, allowSeekAhead: boolean): void;
  getCurrentTime(): number; getDuration(): number; getPlayerState(): number;
  mute(): void; unMute(): void; destroy(): void;
};
type YouTubeApi = { Player: new (element: HTMLElement, options: Record<string, unknown>) => YouTubePlayer };
type YouTubeWindow = Window & { YT?: YouTubeApi; onYouTubeIframeAPIReady?: () => void };
let youtubePromise: Promise<YouTubeApi> | undefined;

function loadYouTube(): Promise<YouTubeApi> {
  const target = window as YouTubeWindow;
  if (target.YT?.Player) return Promise.resolve(target.YT);
  if (youtubePromise) return youtubePromise;
  youtubePromise = new Promise((resolve, reject) => {
    const previous = target.onYouTubeIframeAPIReady;
    const timeout = window.setTimeout(() => { youtubePromise = undefined; reject(new Error("YouTube no respondió. Revisa tu conexión.")); }, 20000);
    target.onYouTubeIframeAPIReady = () => {
      previous?.();
      window.clearTimeout(timeout);
      if (target.YT) resolve(target.YT);
    };
    const script = document.createElement("script");
    script.src = "https://www.youtube.com/iframe_api";
    script.onerror = () => { window.clearTimeout(timeout); youtubePromise = undefined; reject(new Error("No se pudo conectar con YouTube.")); };
    document.head.appendChild(script);
  });
  return youtubePromise;
}

type VideoAdapter = {
  play(): Promise<void>;
  pause(): void;
  seek(seconds: number): void;
  current(): number;
  duration(): number;
  mute(muted: boolean): void;
};

function timeLabel(seconds: number) {
  const safe = Math.max(0, Math.floor(seconds || 0));
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, "0")}`;
}

function VideoMaterial({ material, state, teacher, busy, clockOffset, onControl }: {
  material: LiveMaterial; state: MaterialPresentation; teacher: boolean; busy: boolean; clockOffset: number; onControl: Control;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const youtubeRef = useRef<HTMLDivElement>(null);
  const [adapter, setAdapter] = useState<VideoAdapter | null>(null);
  const [blocked, setBlocked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [seekDraft, setSeekDraft] = useState<number | null>(null);
  const stateRef = useRef(state);
  const controlRef = useRef(onControl);
  useEffect(() => { stateRef.current = state; }, [state]);
  useEffect(() => { controlRef.current = onControl; }, [onControl]);

  useEffect(() => {
    if (material.kind !== "youtube") {
      const video = videoRef.current;
      if (!video) return;
      setAdapter({ play: () => video.play(), pause: () => video.pause(), seek: (seconds) => { video.currentTime = seconds; }, current: () => video.currentTime, duration: () => video.duration || 0, mute: (value) => { video.muted = value; } });
      return;
    }
    let disposed = false;
    let player: YouTubePlayer | undefined;
    const host = document.createElement("div");
    youtubeRef.current?.appendChild(host);
    void loadYouTube().then((api) => {
      if (disposed) return;
      player = new api.Player(host, {
        videoId: material.youtubeId, width: "100%", height: "100%",
        playerVars: { origin: window.location.origin, playsinline: 1, controls: 0, disablekb: 1, rel: 0 },
        events: {
          onReady: () => {
            if (disposed || !player) return;
            const ready = player;
            setAdapter({ play: async () => ready.playVideo(), pause: () => ready.pauseVideo(), seek: (seconds) => ready.seekTo(seconds, true), current: () => ready.getCurrentTime() || 0, duration: () => ready.getDuration() || 0, mute: (value) => value ? ready.mute() : ready.unMute() });
          },
          onAutoplayBlocked: () => { if (!disposed) setBlocked(true); },
          onStateChange: (event: { data: number }) => {
            if (!disposed && teacher && event.data === 0 && player) void controlRef.current({ playing: false, position: player.getDuration() });
          },
          onError: () => { if (!disposed) setError("Este video no se puede reproducir aquí. Comprueba si el propietario permite insertarlo en otras páginas."); },
        },
      });
    }).catch((cause) => { if (!disposed) setError(cause instanceof Error ? cause.message : "No se pudo abrir YouTube."); });
    return () => { disposed = true; player?.destroy(); host.remove(); };
  }, [material.kind, material.youtubeId, teacher]);

  const synchronize = useCallback(() => {
    if (!adapter) return;
    const currentState = stateRef.current;
    const length = adapter.duration();
    const target = Math.min(length || Infinity, presentationPosition(currentState, Date.now() + clockOffset));
    if (Math.abs(adapter.current() - target) > 1.5) adapter.seek(target);
    if (currentState.playing && !blocked && (!length || target < length - 0.1)) void adapter.play().catch(() => setBlocked(true));
    else adapter.pause();
  }, [adapter, clockOffset, blocked]);

  useEffect(() => {
    synchronize();
    const timer = window.setInterval(() => {
      synchronize();
      if (adapter) { setPosition(adapter.current()); setDuration(adapter.duration()); }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [state, synchronize, adapter]);

  const seek = (seconds: number) => {
    const target = Math.max(0, Math.min(duration || Infinity, seconds));
    adapter?.seek(target);
    void onControl({ position: target }).finally(() => setSeekDraft(null));
  };

  return <>
    <div className="relative flex min-h-0 flex-1 items-center justify-center bg-black">
      {material.kind === "youtube" ? <div ref={youtubeRef} className="h-full min-h-[200px] w-full [&_iframe]:h-full [&_iframe]:w-full" /> : <video ref={videoRef} src={material.url} playsInline preload="metadata" className="h-full w-full object-contain" onEnded={() => { if (teacher) void onControl({ playing: false, position: videoRef.current?.duration ?? 0 }); }} onError={() => setError("No se pudo reproducir el video. Usa MP4 con H.264/AAC o WebM compatible con tu navegador.")} />}
      {error ? <p role="alert" className="absolute inset-x-3 top-4 rounded-xl bg-slate-900/95 p-4 text-center text-sm text-red-200">{error}</p> : null}
      {!adapter && !error ? <Loader2 aria-label="Cargando video" className="absolute h-6 w-6 animate-spin text-sky-300" /> : null}
      {blocked && !error ? <button type="button" className="absolute rounded-xl bg-sky-600 px-4 py-3 text-sm font-semibold text-white shadow-xl hover:bg-sky-500" onClick={() => {
        adapter?.mute(false);
        setMuted(false);
        if (state.playing) void adapter?.play().then(() => setBlocked(false)).catch(() => setBlocked(true));
        else setBlocked(false);
      }}>Activar audio y reproducción</button> : null}
    </div>
    <div className="flex shrink-0 flex-wrap items-center gap-3 border-t border-white/10 bg-slate-900 px-3 py-2 text-sm">
      {teacher ? <>
        <button type="button" disabled={busy || !adapter || !!error} aria-label={state.playing ? "Pausar video" : "Reproducir video"} className="rounded-lg p-2 hover:bg-white/10 disabled:opacity-30" onClick={() => {
          if (state.playing) adapter?.pause();
          else void adapter?.play().catch(() => setBlocked(true));
          void onControl({ playing: !state.playing, position: adapter?.current() ?? state.position });
        }}>{state.playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}</button>
        <button type="button" aria-label="Retroceder diez segundos" disabled={busy || !adapter} onClick={() => seek(position - 10)} className="rounded-lg p-2 hover:bg-white/10 disabled:opacity-30"><RotateCcw className="h-4 w-4" /></button>
        <input type="range" aria-label="Posición del video" min={0} max={Math.max(1, duration)} step={1} value={seekDraft ?? Math.min(position, duration || 1)} disabled={busy || !duration} onChange={(event) => setSeekDraft(Number(event.target.value))} onPointerUp={(event) => seek(Number(event.currentTarget.value))} onKeyUp={(event) => { if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"].includes(event.key)) seek(Number(event.currentTarget.value)); }} onPointerCancel={() => setSeekDraft(null)} className="min-w-16 flex-1 accent-sky-500" />
      </> : <p className="flex-1 text-xs text-slate-400">{state.playing ? "Reproduciendo con el profesor" : "Video en pausa"}</p>}
      <span className="text-xs tabular-nums text-slate-300">{timeLabel(position)} / {timeLabel(duration)}</span>
      <button type="button" disabled={!adapter} aria-label={muted ? "Activar audio del material" : "Silenciar material"} onClick={() => { adapter?.mute(!muted); setMuted(!muted); }} className="rounded-lg p-2 hover:bg-white/10 disabled:opacity-30">{muted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}</button>
    </div>
  </>;
}

function ImageMaterial({ material }: { material: LiveMaterial }) {
  const [failed, setFailed] = useState(false);
  return <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-black p-2">
    {failed ? <p role="alert" className="p-6 text-center text-sm text-red-200">No se pudo cargar la imagen. Revisa tu conexión o vuelve a subir el archivo.</p> :
      /* eslint-disable-next-line @next/next/no-img-element */
      <img src={material.url} alt={material.name} onError={() => setFailed(true)} className="h-full w-full object-contain" />}
  </div>;
}

export function LiveMaterialStage({ model, teacher, onAction }: {
  model: LiveMaterialsModel; teacher: boolean; onAction: (body: Record<string, unknown>) => Promise<boolean>;
}) {
  const material = model.activeMaterial;
  if (!material) return null;
  const state = model.presentation;
  const onControl: Control = (changes) => onAction({ action: "control", materialId: material.id, revision: state.revision, ...changes });
  return <section aria-label="Material presentado" className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border border-white/10 bg-slate-950 text-white">
    <div className="flex shrink-0 items-center justify-between gap-2 border-b border-white/10 px-3 py-2">
      <div className="min-w-0"><p className="truncate text-sm font-semibold" title={material.name}>{material.name}</p><p className="text-[11px] text-sky-300">{MATERIAL_KIND_LABEL[material.kind]} · Presentando a la clase</p></div>
      {teacher ? <button type="button" disabled={model.busy} onClick={() => { void onAction({ action: "stop" }); }} className="flex shrink-0 items-center gap-1 rounded-lg bg-white/10 px-2 py-2 text-xs hover:bg-white/20 disabled:opacity-50"><X className="h-3.5 w-3.5" /><span className="hidden sm:inline">Dejar de presentar</span></button> : null}
    </div>
    {model.error || model.syncError ? <p role="alert" className="shrink-0 bg-red-500/20 p-2 text-xs text-red-100">{model.error || model.syncError}</p> : null}
    {material.kind === "pdf" ? <PdfMaterial key={material.id} material={material} state={state} teacher={teacher} busy={model.busy} onControl={onControl} /> : null}
    {material.kind.startsWith("google_") ? <GoogleMaterial key={material.id} material={material} /> : null}
    {material.kind === "powerpoint" ? <>
      <PowerPointMaterial key={material.id} material={material} page={state.page} />
      <DocumentControls page={state.page} count={material.slideCount ?? 0} teacher={teacher} busy={model.busy} onControl={onControl} />
    </> : null}
    {material.kind === "word" ? <>
      <div className="min-h-0 flex-1 overflow-auto bg-slate-800 p-3 sm:p-6"><article className="mx-auto max-w-3xl whitespace-pre-wrap break-words rounded-lg bg-white p-5 text-base leading-relaxed text-slate-900 shadow-xl sm:p-10">{material.textPages?.[state.page - 1] ?? "No hay texto para esta sección."}</article></div>
      <DocumentControls page={state.page} count={material.textPages?.length ?? 1} teacher={teacher} busy={model.busy} onControl={onControl} />
    </> : null}
    {material.kind === "image" ? <ImageMaterial key={material.id} material={material} /> : null}
    {material.kind === "video" || material.kind === "youtube" ? <VideoMaterial key={material.id} material={material} state={state} teacher={teacher} busy={model.busy} clockOffset={model.clockOffset} onControl={onControl} /> : null}
  </section>;
}
