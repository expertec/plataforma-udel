"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePreviewTracks, type LocalUserChoices } from "@livekit/components-react";
import { Track, type LocalAudioTrack, type LocalVideoTrack } from "livekit-client";
import { formatEsMxDateTime } from "@/lib/utils/date-format";

export function TeacherPreparationRoom({
  classTitle,
  scheduledStartAt,
  timezone,
  starting,
  errorMessage,
  onStart,
  onLeave,
}: {
  classTitle: string;
  scheduledStartAt: string | null;
  timezone: string;
  starting: boolean;
  errorMessage: string | null;
  onStart: (choices: LocalUserChoices) => void | Promise<void>;
  onLeave: () => void;
}) {
  const [videoEnabled, setVideoEnabled] = useState(true);
  const [audioEnabled, setAudioEnabled] = useState(true);
  const [videoDeviceId, setVideoDeviceId] = useState("");
  const [audioDeviceId, setAudioDeviceId] = useState("");
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const [microphones, setMicrophones] = useState<MediaDeviceInfo[]>([]);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [micLevel, setMicLevel] = useState(0);
  const videoElementRef = useRef<HTMLVideoElement>(null);

  const handlePreviewError = useCallback((previewTrackError: Error) => {
    console.error("No se pudo abrir la vista previa de dispositivos", previewTrackError);
    setPreviewError(
      "No pudimos acceder a tu cámara o micrófono. Revisa los permisos del navegador.",
    );
  }, []);

  const previewTracks = usePreviewTracks(
    {
      audio: audioEnabled ? { deviceId: audioDeviceId || undefined } : false,
      video: videoEnabled ? { deviceId: videoDeviceId || undefined } : false,
    },
    handlePreviewError,
  );

  const videoPreviewTrack = useMemo(
    () =>
      (previewTracks?.find((track) => track.kind === Track.Kind.Video) as
        | LocalVideoTrack
        | undefined) ?? undefined,
    [previewTracks],
  );
  const audioPreviewTrack = useMemo(
    () =>
      (previewTracks?.find((track) => track.kind === Track.Kind.Audio) as
        | LocalAudioTrack
        | undefined) ?? undefined,
    [previewTracks],
  );

  const hasPreviewTracks = Boolean(previewTracks && previewTracks.length > 0);
  const showPreviewError = Boolean(previewError) && !hasPreviewTracks;

  useEffect(() => {
    const element = videoElementRef.current;
    if (!element || !videoPreviewTrack) return;
    videoPreviewTrack.attach(element);
    return () => {
      videoPreviewTrack.detach(element);
    };
  }, [videoPreviewTrack]);

  useEffect(() => {
    let cancelled = false;
    const loadDevices = async () => {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        if (cancelled) return;
        setCameras(devices.filter((device) => device.kind === "videoinput"));
        setMicrophones(devices.filter((device) => device.kind === "audioinput"));
      } catch {
        // ignore enumeration errors
      }
    };
    void loadDevices();
    navigator.mediaDevices.addEventListener?.("devicechange", loadDevices);
    return () => {
      cancelled = true;
      navigator.mediaDevices.removeEventListener?.("devicechange", loadDevices);
    };
  }, [previewTracks]);

  useEffect(() => {
    if (!audioEnabled || !audioPreviewTrack) {
      return;
    }
    const mediaStreamTrack = audioPreviewTrack.mediaStreamTrack;
    if (!mediaStreamTrack) return;
    const AudioContextImpl =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextImpl) return;

    const audioContext = new AudioContextImpl();
    const sourceStream = new MediaStream([mediaStreamTrack]);
    const source = audioContext.createMediaStreamSource(sourceStream);
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);
    const buffer = new Uint8Array(analyser.frequencyBinCount);
    let frame = 0;
    const measure = () => {
      analyser.getByteTimeDomainData(buffer);
      let peak = 0;
      for (let index = 0; index < buffer.length; index += 1) {
        const deviation = Math.abs(buffer[index] - 128) / 128;
        if (deviation > peak) peak = deviation;
      }
      setMicLevel(peak);
      frame = requestAnimationFrame(measure);
    };
    measure();
    return () => {
      cancelAnimationFrame(frame);
      source.disconnect();
      analyser.disconnect();
      void audioContext.close().catch(() => {});
    };
  }, [audioEnabled, audioPreviewTrack]);

  const handleStart = useCallback(() => {
    void onStart({
      videoEnabled,
      audioEnabled,
      videoDeviceId,
      audioDeviceId,
      username: "",
    });
  }, [audioDeviceId, audioEnabled, onStart, videoDeviceId, videoEnabled]);

  const micLevelPercent =
    audioEnabled && audioPreviewTrack ? Math.min(100, Math.round(micLevel * 140)) : 0;

  return (
    <div className="w-full bg-slate-950 px-4 py-4 text-white sm:py-6">
      <div className="mx-auto w-full max-w-3xl rounded-3xl border border-slate-800 bg-slate-900/70 p-6 shadow-2xl">
        <div className="text-center">
          <p className="text-xs font-semibold uppercase tracking-[0.22em] text-emerald-300">
            Sala de preparación
          </p>
          <h1 className="mt-1 text-2xl font-semibold">{classTitle}</h1>
          <p className="mx-auto mt-2 max-w-lg text-sm text-slate-300">
            Prueba tu cámara y micrófono antes de iniciar. Solo tú ves esta pantalla; los alumnos no
            podrán entrar hasta que inicies la clase.
          </p>
          {scheduledStartAt ? (
            <p className="mt-2 text-xs text-slate-400">
              Inicio programado: {formatEsMxDateTime(scheduledStartAt, { timeZone: timezone })} (
              {timezone})
            </p>
          ) : null}
        </div>

        <div className="mt-5 overflow-hidden rounded-2xl border border-slate-800 bg-black">
          <div className="relative mx-auto aspect-video w-full max-w-[80dvh]">
            {videoEnabled ? (
              <video
                ref={videoElementRef}
                className="h-full w-full -scale-x-100 object-cover"
                muted
                playsInline
              />
            ) : (
              <div className="flex h-full w-full items-center justify-center text-sm text-slate-400">
                Cámara desactivada
              </div>
            )}
          </div>
        </div>

        <div className="mt-3 flex items-center gap-3">
          <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">
            Nivel de micrófono
          </span>
          <div className="h-2 flex-1 overflow-hidden rounded-full bg-slate-800">
            <div
              className="h-full rounded-full bg-emerald-500 transition-[width] duration-75"
              style={{ width: `${micLevelPercent}%` }}
            />
          </div>
        </div>

        {showPreviewError ? (
          <p className="mt-3 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-100">
            {previewError}
          </p>
        ) : null}
        {errorMessage ? (
          <p className="mt-3 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-100">
            {errorMessage}
          </p>
        ) : null}

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div>
            <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-400">
              Cámara
            </label>
            <div className="flex items-center gap-2">
              <select
                value={videoDeviceId}
                onChange={(event) => setVideoDeviceId(event.target.value)}
                disabled={!videoEnabled}
                className="min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white disabled:opacity-50"
              >
                <option value="">Predeterminada</option>
                {cameras.map((camera, index) => (
                  <option key={camera.deviceId || index} value={camera.deviceId}>
                    {camera.label || `Cámara ${index + 1}`}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => setVideoEnabled((current) => !current)}
                className={`shrink-0 rounded-lg border px-3 py-2 text-xs font-semibold ${
                  videoEnabled
                    ? "border-emerald-500 bg-emerald-600/20 text-emerald-200 hover:bg-emerald-600/30"
                    : "border-slate-600 bg-slate-800 text-slate-300 hover:bg-slate-700"
                }`}
              >
                {videoEnabled ? "Activada" : "Activar"}
              </button>
            </div>
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-400">
              Micrófono
            </label>
            <div className="flex items-center gap-2">
              <select
                value={audioDeviceId}
                onChange={(event) => setAudioDeviceId(event.target.value)}
                disabled={!audioEnabled}
                className="min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white disabled:opacity-50"
              >
                <option value="">Predeterminado</option>
                {microphones.map((microphone, index) => (
                  <option key={microphone.deviceId || index} value={microphone.deviceId}>
                    {microphone.label || `Micrófono ${index + 1}`}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => setAudioEnabled((current) => !current)}
                className={`shrink-0 rounded-lg border px-3 py-2 text-xs font-semibold ${
                  audioEnabled
                    ? "border-emerald-500 bg-emerald-600/20 text-emerald-200 hover:bg-emerald-600/30"
                    : "border-slate-600 bg-slate-800 text-slate-300 hover:bg-slate-700"
                }`}
              >
                {audioEnabled ? "Activado" : "Activar"}
              </button>
            </div>
          </div>
        </div>

        <div className="mt-6 flex flex-col-reverse items-stretch gap-2 sm:flex-row sm:items-center sm:justify-between">
          <button
            type="button"
            onClick={onLeave}
            className="rounded-lg border border-slate-600 px-4 py-2 text-sm font-semibold text-slate-200 hover:bg-slate-800"
          >
            Salir
          </button>
          <button
            type="button"
            disabled={starting}
            onClick={handleStart}
            className="rounded-lg bg-emerald-600 px-6 py-2.5 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-60"
          >
            {starting ? "Iniciando..." : "Iniciar clase en vivo"}
          </button>
        </div>
      </div>
    </div>
  );
}

