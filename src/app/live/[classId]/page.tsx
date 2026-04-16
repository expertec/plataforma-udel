"use client";

import "@livekit/components-styles";
import { LiveKitRoom, RoomAudioRenderer, VideoConference } from "@livekit/components-react";
import { onAuthStateChanged, type User } from "firebase/auth";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { auth } from "@/lib/firebase/client";

type LiveTokenResponse = {
  success?: boolean;
  data?: {
    token?: string;
    livekitUrl?: string;
    roomName?: string;
    classTitle?: string;
    joinAllowed?: boolean;
    waitingReason?: string;
    asRole?: "teacher" | "student";
    liveSession?: {
      status?: string;
      scheduledStartAt?: string | null;
      timezone?: string;
    } | null;
  };
  error?: string;
};

export default function LiveClassRoomPage() {
  const params = useParams<{ classId: string }>();
  const classId = useMemo(() => (params.classId ?? "").trim(), [params.classId]);

  const [user, setUser] = useState<User | null>(auth.currentUser);
  const [authLoading, setAuthLoading] = useState(!auth.currentUser);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [livekitUrl, setLivekitUrl] = useState<string | null>(null);
  const [roomName, setRoomName] = useState<string | null>(null);
  const [classTitle, setClassTitle] = useState("Clase en vivo");
  const [waitingReason, setWaitingReason] = useState<string | null>(null);
  const [scheduledStartAt, setScheduledStartAt] = useState<string | null>(null);
  const [timezone, setTimezone] = useState<string>("America/Monterrey");

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (nextUser) => {
      setUser(nextUser);
      setAuthLoading(false);
    });
    return unsub;
  }, []);

  const requestToken = useCallback(async () => {
    if (!classId) return;
    if (!user) return;

    setLoading(true);
    setError(null);
    try {
      const idToken = await user.getIdToken();
      const response = await fetch("/api/livekit/token", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify({ classId }),
      });
      const payload = (await response.json().catch(() => null)) as LiveTokenResponse | null;
      if (!response.ok || !payload?.success || !payload.data) {
        throw new Error(payload?.error || "No se pudo abrir la clase en vivo");
      }

      setClassTitle(payload.data.classTitle || "Clase en vivo");
      setRoomName(payload.data.roomName || null);
      setScheduledStartAt(payload.data.liveSession?.scheduledStartAt ?? null);
      setTimezone(payload.data.liveSession?.timezone ?? "America/Monterrey");

      if (!payload.data.joinAllowed || !payload.data.token || !payload.data.livekitUrl) {
        setToken(null);
        setLivekitUrl(null);
        setWaitingReason(payload.data.waitingReason || "waiting_teacher");
        setLoading(false);
        return;
      }

      setToken(payload.data.token);
      setLivekitUrl(payload.data.livekitUrl);
      setWaitingReason(null);
      setLoading(false);
    } catch (requestError) {
      console.error("No se pudo obtener token de LiveKit", requestError);
      setError(requestError instanceof Error ? requestError.message : "No se pudo abrir la clase");
      setLoading(false);
    }
  }, [classId, user]);

  useEffect(() => {
    if (!user || !classId) return;
    requestToken();
  }, [classId, requestToken, user]);

  useEffect(() => {
    if (!user || !classId) return;
    if (token || waitingReason !== "waiting_teacher") return;
    const timer = window.setInterval(() => {
      requestToken();
    }, 8000);
    return () => window.clearInterval(timer);
  }, [classId, requestToken, token, user, waitingReason]);

  if (authLoading) {
    return <div className="flex min-h-screen items-center justify-center bg-slate-950 text-white">Verificando sesión...</div>;
  }

  if (!user) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-slate-950 text-white">
        <p>Inicia sesión para entrar a esta clase en vivo.</p>
        <Link href="/auth/login" className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white">
          Ir a login
        </Link>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-slate-950 px-4 text-center text-white">
        <p>{error}</p>
        <button
          type="button"
          onClick={requestToken}
          className="rounded-lg border border-white/30 px-4 py-2 text-sm font-semibold text-white"
        >
          Reintentar
        </button>
      </div>
    );
  }

  if (loading) {
    return <div className="flex min-h-screen items-center justify-center bg-slate-950 text-white">Preparando sala...</div>;
  }

  if (!token || !livekitUrl) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-slate-950 px-4 text-center text-white">
        <p className="text-xs uppercase tracking-[0.2em] text-sky-300">Sala de espera</p>
        <h1 className="text-2xl font-semibold">{classTitle}</h1>
        <p className="max-w-lg text-sm text-slate-200">
          {waitingReason === "session_ended"
            ? "La sesión terminó. Si la grabación está lista podrás verla desde la plataforma."
            : "El profesor aún no inicia la sesión. Esta pantalla se actualizará automáticamente."}
        </p>
        {scheduledStartAt ? (
          <p className="text-xs text-slate-300">
            Inicio programado:{" "}
            {new Date(scheduledStartAt).toLocaleString("es-MX", {
              dateStyle: "medium",
              timeStyle: "short",
            })}{" "}
            ({timezone})
          </p>
        ) : null}
        <button
          type="button"
          onClick={requestToken}
          className="rounded-lg border border-slate-400 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
        >
          Actualizar estado
        </button>
      </div>
    );
  }

  return (
    <div className="h-screen w-full bg-slate-950">
      <LiveKitRoom token={token} serverUrl={livekitUrl} connect={true} audio={true} video={true} data-lk-theme="default" className="h-full w-full">
        <VideoConference />
        <RoomAudioRenderer />
      </LiveKitRoom>
      <div className="pointer-events-none fixed left-0 right-0 top-0 flex justify-between p-3">
        <span className="pointer-events-auto rounded-full bg-black/70 px-3 py-1 text-xs font-semibold text-white">
          {classTitle}
        </span>
        <span className="pointer-events-auto rounded-full bg-black/70 px-3 py-1 text-xs font-semibold text-white">
          Sala: {roomName}
        </span>
      </div>
    </div>
  );
}

