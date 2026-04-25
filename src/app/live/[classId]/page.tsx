"use client";

import "@livekit/components-styles";
import {
  ControlBar,
  GridLayout,
  LiveKitRoom,
  ParticipantTile,
  RoomAudioRenderer,
  StartAudio,
  useTracks,
} from "@livekit/components-react";
import { onAuthStateChanged, type User } from "firebase/auth";
import { Track } from "livekit-client";
import { useParams, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LoginCard } from "@/components/auth/LoginCard";
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

function LiveRoomConference() {
  const tracks = useTracks([Track.Source.Camera, Track.Source.ScreenShare], {
    onlySubscribed: false,
  });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 p-2">
        <GridLayout tracks={tracks} className="h-full">
          <ParticipantTile />
        </GridLayout>
      </div>
      <div className="border-t border-slate-800 bg-slate-950/80 px-2 py-2">
        <ControlBar controls={{ leave: false, chat: false, settings: false }} />
      </div>
      <StartAudio label="Habilitar audio" />
      <RoomAudioRenderer />
    </div>
  );
}

export default function LiveClassRoomPage() {
  const params = useParams<{ classId: string }>();
  const searchParams = useSearchParams();
  const classId = useMemo(() => (params.classId ?? "").trim(), [params.classId]);
  const courseId = useMemo(() => (searchParams.get("courseId") ?? "").trim(), [searchParams]);
  const lessonId = useMemo(() => (searchParams.get("lessonId") ?? "").trim(), [searchParams]);
  const returnTo = useMemo(() => {
    const query = searchParams.toString();
    return `/live/${encodeURIComponent(classId)}${query ? `?${query}` : ""}`;
  }, [classId, searchParams]);

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
  const [asRole, setAsRole] = useState<"teacher" | "student" | null>(null);
  const [startingSession, setStartingSession] = useState(false);
  const [endingSession, setEndingSession] = useState(false);
  const autoStartAttemptedRef = useRef(false);

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
        body: JSON.stringify({
          classId,
          courseId: courseId || undefined,
          lessonId: lessonId || undefined,
        }),
      });
      const payload = (await response.json().catch(() => null)) as LiveTokenResponse | null;
      if (!response.ok || !payload?.success || !payload.data) {
        throw new Error(payload?.error || "No se pudo abrir la clase en vivo");
      }

      setClassTitle(payload.data.classTitle || "Clase en vivo");
      setRoomName(payload.data.roomName || null);
      setScheduledStartAt(payload.data.liveSession?.scheduledStartAt ?? null);
      setTimezone(payload.data.liveSession?.timezone ?? "America/Monterrey");
      setAsRole(payload.data.asRole ?? null);

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
  }, [classId, courseId, lessonId, user]);

  const leaveRoom = useCallback(() => {
    // Unmounting LiveKitRoom forces a clean disconnect and avoids internal
    // VideoConference paging errors seen during leave.
    setToken(null);
    setLivekitUrl(null);
    setWaitingReason("left_room");
    setLoading(false);
  }, []);

  const pollJoinAccess = useCallback(async () => {
    if (!classId || !user) return;

    try {
      const idToken = await user.getIdToken();
      const response = await fetch("/api/livekit/token", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify({
          classId,
          courseId: courseId || undefined,
          lessonId: lessonId || undefined,
        }),
      });
      const payload = (await response.json().catch(() => null)) as LiveTokenResponse | null;
      if (!response.ok || !payload?.success || !payload.data) {
        return;
      }

      setAsRole(payload.data.asRole ?? null);
      if (!payload.data.joinAllowed) {
        setWaitingReason(payload.data.waitingReason || "session_ended");
        setToken(null);
        setLivekitUrl(null);
        setLoading(false);
      }
    } catch {
      // ignore polling transient errors while in-room
    }
  }, [classId, courseId, lessonId, user]);

  const startSession = useCallback(async () => {
    if (!classId || !user || asRole !== "teacher") return;

    setStartingSession(true);
    setError(null);
    try {
      const idToken = await user.getIdToken();
      const search = new URLSearchParams();
      if (courseId) search.set("courseId", courseId);
      if (lessonId) search.set("lessonId", lessonId);
      const query = search.toString();

      const response = await fetch(
        `/api/live/classes/${encodeURIComponent(classId)}/start${query ? `?${query}` : ""}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${idToken}`,
          },
        },
      );
      const payload = (await response.json().catch(() => null)) as
        | { success?: boolean; error?: string }
        | null;
      if (!response.ok || !payload?.success) {
        throw new Error(payload?.error || "No se pudo iniciar la sesión");
      }

      await requestToken();
    } catch (startError) {
      console.error("No se pudo iniciar la sesión", startError);
      setError(startError instanceof Error ? startError.message : "No se pudo iniciar la sesión");
      setLoading(false);
    } finally {
      setStartingSession(false);
    }
  }, [asRole, classId, courseId, lessonId, requestToken, user]);

  const endSession = useCallback(async () => {
    if (!classId || !user || asRole !== "teacher") return;

    setEndingSession(true);
    setError(null);
    try {
      const idToken = await user.getIdToken();
      const search = new URLSearchParams();
      if (courseId) search.set("courseId", courseId);
      if (lessonId) search.set("lessonId", lessonId);
      const query = search.toString();

      const response = await fetch(
        `/api/live/classes/${encodeURIComponent(classId)}/end${query ? `?${query}` : ""}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${idToken}`,
          },
        },
      );
      const payload = (await response.json().catch(() => null)) as
        | { success?: boolean; error?: string }
        | null;
      if (!response.ok || !payload?.success) {
        throw new Error(payload?.error || "No se pudo terminar la sesión");
      }

      setWaitingReason("session_ended");
      setToken(null);
      setLivekitUrl(null);
      setLoading(false);
    } catch (endError) {
      console.error("No se pudo terminar la sesión", endError);
      setError(endError instanceof Error ? endError.message : "No se pudo terminar la sesión");
    } finally {
      setEndingSession(false);
    }
  }, [asRole, classId, courseId, lessonId, user]);

  useEffect(() => {
    if (!user || !classId) return;
    requestToken();
  }, [classId, requestToken, user]);

  useEffect(() => {
    if (!user || !classId) return;
    if (token || waitingReason !== "waiting_teacher") return;
    if (asRole === "teacher") return;
    const timer = window.setInterval(() => {
      requestToken();
    }, 8000);
    return () => window.clearInterval(timer);
  }, [asRole, classId, requestToken, token, user, waitingReason]);

  useEffect(() => {
    if (!user || !classId) return;
    if (token || waitingReason !== "waiting_teacher" || asRole !== "teacher") return;
    if (startingSession) return;
    if (autoStartAttemptedRef.current) return;
    autoStartAttemptedRef.current = true;
    startSession();
  }, [asRole, classId, startSession, startingSession, token, user, waitingReason]);

  useEffect(() => {
    if (!user || !classId) return;
    if (!token || !livekitUrl) return;
    if (asRole !== "student") return;
    const timer = window.setInterval(() => {
      pollJoinAccess();
    }, 6000);
    return () => window.clearInterval(timer);
  }, [asRole, classId, livekitUrl, pollJoinAccess, token, user]);

  if (authLoading) {
    return <div className="flex min-h-screen items-center justify-center bg-slate-950 text-white">Verificando sesión...</div>;
  }

  if (!user) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-950 px-4 py-10 text-white">
        <LoginCard
          title="Entrar a clase en vivo"
          subtitle="Inicia sesión para acceder con tu cuenta de alumno."
          redirectTo={returnTo}
        />
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
            : waitingReason === "left_room"
              ? "Saliste de la sala. Puedes volver a entrar cuando quieras."
              : asRole === "teacher"
                ? "La sesión todavía no está iniciada."
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
        {asRole === "teacher" && waitingReason === "waiting_teacher" ? (
          <button
            type="button"
            disabled={startingSession}
            onClick={startSession}
            className="rounded-lg bg-green-600 px-4 py-2 text-sm font-semibold text-white hover:bg-green-500 disabled:opacity-60"
          >
            {startingSession ? "Iniciando..." : "Iniciar sesión"}
          </button>
        ) : (
          <button
            type="button"
            onClick={requestToken}
            className="rounded-lg border border-slate-400 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
          >
            {waitingReason === "left_room" ? "Volver a entrar" : "Actualizar estado"}
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="h-screen w-full bg-slate-950">
      <LiveKitRoom
        token={token}
        serverUrl={livekitUrl}
        connect={true}
        audio={true}
        video={true}
        onDisconnected={() => {
          setToken(null);
          setLivekitUrl(null);
          setWaitingReason((currentReason) =>
            currentReason === "session_ended" ? "session_ended" : "left_room",
          );
          setLoading(false);
        }}
        data-lk-theme="default"
        className="h-full w-full"
      >
        <LiveRoomConference />
      </LiveKitRoom>
      <div className="pointer-events-none fixed left-0 right-0 top-0 flex justify-between p-3">
        <div className="flex items-center gap-2">
          <span className="pointer-events-auto rounded-full bg-black/70 px-3 py-1 text-xs font-semibold text-white">
            {classTitle}
          </span>
          <span className="pointer-events-auto rounded-full bg-black/70 px-3 py-1 text-xs font-semibold text-white">
            Sala: {roomName}
          </span>
        </div>
        <div className="pointer-events-auto flex items-center gap-2">
          {asRole === "teacher" ? (
            <button
              type="button"
              disabled={endingSession}
              onClick={endSession}
              className="rounded-full bg-amber-600 px-3 py-1 text-xs font-semibold text-white hover:bg-amber-500 disabled:opacity-60"
            >
              {endingSession ? "Terminando..." : "Terminar sesión"}
            </button>
          ) : null}
          <button
            type="button"
            onClick={leaveRoom}
            className="rounded-full bg-red-600 px-3 py-1 text-xs font-semibold text-white hover:bg-red-500"
          >
            Salir
          </button>
        </div>
      </div>
    </div>
  );
}
