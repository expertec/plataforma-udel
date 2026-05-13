"use client";

import "@livekit/components-styles";
import {
  CarouselLayout,
  ChatToggle,
  FocusLayout,
  FocusLayoutContainer,
  GridLayout,
  isTrackReference,
  LayoutContextProvider,
  LiveKitRoom,
  MediaDeviceMenu,
  ParticipantTile,
  RoomAudioRenderer,
  StartAudio,
  TrackToggle,
  useChat,
  useConnectionState,
  useDataChannel,
  useLocalParticipantPermissions,
  useMaybeLayoutContext,
  useParticipants,
  useSpeakingParticipants,
  type TrackReference,
  type WidgetState,
  useTracks,
} from "@livekit/components-react";
import { onAuthStateChanged, type User } from "firebase/auth";
import { ConnectionState, isBrowserSupported, MediaDeviceFailure, Track } from "livekit-client";
import { useParams, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LoginCard } from "@/components/auth/LoginCard";
import { auth } from "@/lib/firebase/client";
import { formatEsMxDateTime } from "@/lib/utils/date-format";

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

type LiveRoomParticipantSummary = {
  identity: string;
  name: string;
  role: string | null;
  microphone: {
    total: number;
    muted: number;
    unmuted: number;
  };
};

type LiveParticipantsResponse = {
  success?: boolean;
  data?: {
    roomName?: string;
    participants?: LiveRoomParticipantSummary[];
  };
  error?: string;
};

type LiveParticipantsActionResponse = {
  success?: boolean;
  data?: {
    action?: string;
    result?: {
      participantIdentity?: string;
      totalMicrophoneTracks?: number;
      mutedTrackSids?: string[];
      alreadyMutedTrackSids?: string[];
      targetedParticipants?: number;
      mutedParticipants?: number;
      mutedMicrophoneTracks?: number;
    };
  };
  error?: string;
};

type LiveSignalPayload =
  | {
      type: "reaction";
      eventId: string;
      emoji: string;
      senderId: string;
      senderName: string;
      timestamp: number;
    }
  | {
      type: "hand";
      eventId: string;
      raised: boolean;
      senderId: string;
      senderName: string;
      timestamp: number;
    };

type LiveReactionEvent = {
  eventId: string;
  emoji: string;
  senderId: string;
  senderName: string;
  timestamp: number;
  expiresAt: number;
};

type RaisedHandEntry = {
  senderId: string;
  senderName: string;
  timestamp: number;
};

const LIVE_SIGNAL_TOPIC = "udx.live.signal";
const LIVE_REACTION_TTL_MS = 4500;
const LIVE_REACTIONS = ["👍", "👏", "🎉", "🔥", "❤️", "😂"];

function isLiveSignalPayload(value: unknown): value is LiveSignalPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const data = value as Record<string, unknown>;
  const common =
    typeof data.eventId === "string" &&
    data.eventId.trim().length > 0 &&
    typeof data.senderId === "string" &&
    data.senderId.trim().length > 0 &&
    typeof data.senderName === "string" &&
    data.senderName.trim().length > 0 &&
    typeof data.timestamp === "number" &&
    Number.isFinite(data.timestamp);
  if (!common) return false;
  if (data.type === "reaction") {
    return typeof data.emoji === "string" && data.emoji.trim().length > 0;
  }
  if (data.type === "hand") {
    return typeof data.raised === "boolean";
  }
  return false;
}

function encodeLiveSignal(payload: LiveSignalPayload): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(payload));
}

function buildLiveClassQuery(courseId: string, lessonId: string): string {
  const search = new URLSearchParams();
  if (courseId) search.set("courseId", courseId);
  if (lessonId) search.set("lessonId", lessonId);
  return search.toString();
}

function isTeacherLikeLiveRole(role: string | null): boolean {
  if (!role) return false;
  return (
    role === "teacher" ||
    role === "adminteacher" ||
    role === "superadminteacher" ||
    role === "admin_teacher" ||
    role === "super_admin_teacher"
  );
}

function parseParticipantRoleFromMetadata(rawMetadata: string | undefined): string | null {
  const value = (rawMetadata ?? "").trim();
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const role = (parsed as Record<string, unknown>).role;
      if (typeof role === "string") {
        const normalized = role.trim().toLowerCase();
        return normalized || null;
      }
    }
  } catch {
    // ignore malformed metadata
  }
  return null;
}

function formatChatHour(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString("es-MX", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function LiveRoomChatPanel({ visible }: { visible: boolean }) {
  const listRef = useRef<HTMLUListElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const layoutContext = useMaybeLayoutContext();
  const lastReadMessageAt = useRef<number>(0);
  const { chatMessages, send, isSending } = useChat();

  const closeChat = useCallback(() => {
    layoutContext?.widget.dispatch?.({ msg: "hide_chat" });
  }, [layoutContext]);

  const handleSubmit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      if (!inputRef.current) return;
      const text = inputRef.current.value.trim();
      if (!text) return;
      await send(text);
      inputRef.current.value = "";
      inputRef.current.focus();
    },
    [send],
  );

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [chatMessages]);

  useEffect(() => {
    if (!layoutContext || chatMessages.length === 0) {
      return;
    }
    if (
      layoutContext.widget.state?.showChat &&
      lastReadMessageAt.current !== chatMessages[chatMessages.length - 1]?.timestamp
    ) {
      lastReadMessageAt.current = chatMessages[chatMessages.length - 1]?.timestamp ?? 0;
      return;
    }

    const unreadCount = chatMessages.filter(
      (message) => !lastReadMessageAt.current || message.timestamp > lastReadMessageAt.current,
    ).length;
    if (unreadCount > 0 && layoutContext.widget.state?.unreadMessages !== unreadCount) {
      layoutContext.widget.dispatch?.({ msg: "unread_msg", count: unreadCount });
    }
  }, [chatMessages, layoutContext]);

  return (
    <div className="lk-chat" style={{ display: visible ? "grid" : "none" }}>
      <div className="lk-chat-header">
        Mensajes
        <button type="button" onClick={closeChat} className="lk-button lk-close-button">
          Cerrar
        </button>
      </div>
      <ul className="lk-list lk-chat-messages" ref={listRef}>
        {chatMessages.map((message, index, allMessages) => {
          const previous = index >= 1 ? allMessages[index - 1] : null;
          const sameSender = Boolean(
            previous &&
              previous.from?.identity === message.from?.identity &&
              previous.from?.isLocal === message.from?.isLocal,
          );
          const showTime =
            !previous ||
            message.timestamp - previous.timestamp >= 60_000 ||
            Boolean(message.editTimestamp);
          const senderName = message.from?.isLocal
            ? "Tú"
            : (message.from?.name ?? message.from?.identity ?? "Participante");
          return (
            <li
              key={message.id ?? `${message.timestamp}-${index}`}
              className="lk-chat-entry"
              data-lk-message-origin={message.from?.isLocal ? "local" : "remote"}
            >
              {(!sameSender || showTime) && (
                <span className="lk-meta-data">
                  {!sameSender ? <strong className="lk-participant-name">{senderName}</strong> : null}
                  {showTime ? (
                    <span className="lk-timestamp">
                      {message.editTimestamp ? "editado " : ""}
                      {formatChatHour(message.timestamp)}
                    </span>
                  ) : null}
                </span>
              )}
              <span className="lk-message-body">{message.message}</span>
            </li>
          );
        })}
      </ul>
      <form className="lk-chat-form" onSubmit={handleSubmit}>
        <input
          className="lk-form-control lk-chat-form-input"
          disabled={isSending}
          ref={inputRef}
          type="text"
          placeholder="Escribe un mensaje..."
          onInput={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
          onKeyUp={(event) => event.stopPropagation()}
        />
        <button type="submit" className="lk-button lk-chat-form-button" disabled={isSending}>
          Enviar
        </button>
      </form>
    </div>
  );
}

function LiveRoomConference() {
  const participants = useParticipants();
  const speakingParticipants = useSpeakingParticipants();
  const connectionState = useConnectionState();
  const localParticipantPermissions = useLocalParticipantPermissions();
  const tracks = useTracks(
    [
      { source: Track.Source.Camera, withPlaceholder: true },
      { source: Track.Source.ScreenShare, withPlaceholder: false },
    ],
    {
      onlySubscribed: false,
    },
  );
  const [widgetState, setWidgetState] = useState<WidgetState>({
    showChat: false,
    unreadMessages: 0,
    showSettings: false,
  });
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [raisedHands, setRaisedHands] = useState<Record<string, RaisedHandEntry>>({});
  const [handRaised, setHandRaised] = useState(false);
  const [activeReactions, setActiveReactions] = useState<LiveReactionEvent[]>([]);
  const processedSignalIdsRef = useRef<string[]>([]);
  const previousParticipantsCountRef = useRef(0);

  const localParticipant = useMemo(
    () => participants.find((participant) => participant.isLocal),
    [participants],
  );
  const localParticipantId = localParticipant?.identity ?? "";
  const localParticipantName =
    localParticipant?.name?.trim() || localParticipantId || "Participante";
  const signalSendBackoffUntilRef = useRef(0);

  const remoteParticipantIdentities = useMemo(
    () =>
      participants
        .filter((participant) => !participant.isLocal)
        .map((participant) => participant.identity.trim())
        .filter((identity) => identity.length > 0),
    [participants],
  );

  const canPublishSignalPackets =
    connectionState === ConnectionState.Connected &&
    localParticipantPermissions?.canPublishData !== false;

  const screenShareTrack = useMemo(() => {
    const screenShares = tracks.filter(
      (track): track is TrackReference =>
        track.source === Track.Source.ScreenShare && isTrackReference(track),
    );
    const subscribed = screenShares.find((track) => track.publication.isSubscribed);
    return subscribed ?? screenShares[0] ?? null;
  }, [tracks]);

  const activeTeacherParticipant = useMemo(
    () =>
      speakingParticipants.find((participant) =>
        isTeacherLikeLiveRole(parseParticipantRoleFromMetadata(participant.metadata)),
      ) ?? null,
    [speakingParticipants],
  );

  const teacherSpeakerCameraTrack = useMemo(() => {
    if (!activeTeacherParticipant) return null;
    const teacherCameraTracks = tracks.filter(
      (track): track is TrackReference =>
        isTrackReference(track) &&
        track.source === Track.Source.Camera &&
        track.participant.identity === activeTeacherParticipant.identity,
    );
    const subscribed = teacherCameraTracks.find((track) => track.publication.isSubscribed);
    return subscribed ?? teacherCameraTracks[0] ?? null;
  }, [activeTeacherParticipant, tracks]);

  const focusTrack = screenShareTrack ?? teacherSpeakerCameraTrack ?? null;

  const nonFocusedTracks = useMemo(() => {
    if (!focusTrack) return tracks;
    const focusedTrackKey = `track:${focusTrack.publication.trackSid}`;
    return tracks.filter((track) => {
      const trackKey = isTrackReference(track)
        ? `track:${track.publication.trackSid}`
        : `placeholder:${track.participant.identity}:${track.source}`;
      return trackKey !== focusedTrackKey;
    });
  }, [focusTrack, tracks]);

  const rememberSignalId = useCallback((eventId: string): boolean => {
    const normalized = eventId.trim();
    if (!normalized) return false;
    const alreadyProcessed = processedSignalIdsRef.current.includes(normalized);
    if (alreadyProcessed) return true;
    processedSignalIdsRef.current = [...processedSignalIdsRef.current.slice(-199), normalized];
    return false;
  }, []);

  const applyReaction = useCallback(
    (payload: LiveSignalPayload & { type: "reaction" }) => {
      setActiveReactions((current) => {
        const now = Date.now();
        const filtered = current.filter(
          (reaction) => reaction.expiresAt > now && reaction.eventId !== payload.eventId,
        );
        return [
          ...filtered,
          {
            eventId: payload.eventId,
            emoji: payload.emoji,
            senderId: payload.senderId,
            senderName: payload.senderName,
            timestamp: payload.timestamp,
            expiresAt: now + LIVE_REACTION_TTL_MS,
          },
        ];
      });
    },
    [],
  );

  const applyRaisedHand = useCallback(
    (payload: LiveSignalPayload & { type: "hand" }) => {
      setRaisedHands((current) => {
        if (!payload.raised) {
          const next = { ...current };
          delete next[payload.senderId];
          return next;
        }
        return {
          ...current,
          [payload.senderId]: {
            senderId: payload.senderId,
            senderName: payload.senderName,
            timestamp: payload.timestamp,
          },
        };
      });
      if (payload.senderId === localParticipantId) {
        setHandRaised(payload.raised);
      }
    },
    [localParticipantId],
  );

  const handleSignalMessage = useCallback(
    (rawMessage: { payload: Uint8Array }) => {
      try {
        const decodedRaw = new TextDecoder().decode(rawMessage.payload);
        const parsed = JSON.parse(decodedRaw) as unknown;
        if (!isLiveSignalPayload(parsed)) return;
        if (rememberSignalId(parsed.eventId)) return;
        if (parsed.type === "reaction") {
          applyReaction(parsed);
          return;
        }
        if (parsed.type === "hand") {
          applyRaisedHand(parsed);
        }
      } catch {
        // ignore malformed or non-JSON payloads
      }
    },
    [applyRaisedHand, applyReaction, rememberSignalId],
  );

  const { send: sendSignal } = useDataChannel(LIVE_SIGNAL_TOPIC, handleSignalMessage);

  const publishSignal = useCallback(
    async (payload: LiveSignalPayload, reliable: boolean) => {
      if (!canPublishSignalPackets) return false;
      if (remoteParticipantIdentities.length === 0) return false;
      if (signalSendBackoffUntilRef.current > Date.now()) return false;
      try {
        await sendSignal(encodeLiveSignal(payload), {
          reliable,
          destinationIdentities: remoteParticipantIdentities,
        });
        return true;
      } catch (signalError) {
        signalSendBackoffUntilRef.current = Date.now() + 1_500;
        console.warn("No se pudo enviar señal en vivo", signalError);
        return false;
      }
    },
    [canPublishSignalPackets, remoteParticipantIdentities, sendSignal],
  );

  const sendReaction = useCallback(
    async (emoji: string) => {
      if (!localParticipantId || !emoji.trim()) return;
      const payload: LiveSignalPayload = {
        type: "reaction",
        eventId: `reaction-${localParticipantId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        emoji,
        senderId: localParticipantId,
        senderName: localParticipantName,
        timestamp: Date.now(),
      };
      if (rememberSignalId(payload.eventId)) return;
      applyReaction(payload);
      await publishSignal(payload, false);
    },
    [applyReaction, localParticipantId, localParticipantName, publishSignal, rememberSignalId],
  );

  const broadcastHandState = useCallback(
    async (nextRaised: boolean) => {
      if (!localParticipantId) return;
      const payload: LiveSignalPayload = {
        type: "hand",
        eventId: `hand-${localParticipantId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        raised: nextRaised,
        senderId: localParticipantId,
        senderName: localParticipantName,
        timestamp: Date.now(),
      };
      if (rememberSignalId(payload.eventId)) return;
      applyRaisedHand(payload);
      await publishSignal(payload, true);
    },
    [applyRaisedHand, localParticipantId, localParticipantName, publishSignal, rememberSignalId],
  );

  const toggleHandRaised = useCallback(() => {
    void broadcastHandState(!handRaised);
  }, [broadcastHandState, handRaised]);

  const resendRaisedHandPresence = useCallback(async () => {
    if (!localParticipantId || !handRaised) return;
    const payload: LiveSignalPayload = {
      type: "hand",
      eventId: `hand-sync-${localParticipantId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      raised: true,
      senderId: localParticipantId,
      senderName: localParticipantName,
      timestamp: Date.now(),
    };
    if (rememberSignalId(payload.eventId)) return;
    await publishSignal(payload, true);
  }, [handRaised, localParticipantId, localParticipantName, publishSignal, rememberSignalId]);

  const raisedHandsList = useMemo(
    () =>
      Object.values(raisedHands).sort((left, right) => {
        if (left.timestamp !== right.timestamp) {
          return left.timestamp - right.timestamp;
        }
        return left.senderName.localeCompare(right.senderName, "es-MX", {
          sensitivity: "base",
        });
      }),
    [raisedHands],
  );

  useEffect(() => {
    const timer = window.setInterval(() => {
      const now = Date.now();
      setActiveReactions((current) => current.filter((reaction) => reaction.expiresAt > now));
    }, 400);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const currentCount = participants.length;
    const previousCount = previousParticipantsCountRef.current;
    previousParticipantsCountRef.current = currentCount;
    if (!handRaised || !localParticipantId) return;
    if (currentCount > previousCount) {
      void resendRaisedHandPresence();
    }
  }, [handRaised, localParticipantId, participants.length, resendRaisedHandPresence]);

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      {raisedHandsList.length > 0 ? (
        <div className="pointer-events-none absolute left-3 top-3 z-20 flex max-w-[70vw] flex-wrap gap-2">
          {raisedHandsList.map((entry) => (
            <span
              key={entry.senderId}
              className="pointer-events-auto rounded-full border border-amber-300/60 bg-amber-500/80 px-3 py-1 text-xs font-semibold text-amber-950 shadow"
            >
              ✋ {entry.senderName}
            </span>
          ))}
        </div>
      ) : null}
      {activeReactions.length > 0 ? (
        <div className="pointer-events-none absolute left-1/2 top-12 z-20 flex -translate-x-1/2 flex-col items-center gap-2">
          {activeReactions.slice(-5).map((reaction) => (
            <span
              key={reaction.eventId}
              className="rounded-full bg-black/65 px-3 py-1 text-sm font-semibold text-white shadow"
            >
              {reaction.emoji} {reaction.senderName}
            </span>
          ))}
        </div>
      ) : null}
      <div className="pointer-events-none absolute bottom-20 left-1/2 z-20 flex -translate-x-1/2">
        <div className="pointer-events-auto rounded-2xl border border-slate-700 bg-slate-900/90 px-3 py-2 shadow-xl backdrop-blur">
          <div className="flex items-center gap-2">
            {LIVE_REACTIONS.map((emoji) => (
              <button
                key={emoji}
                type="button"
                onClick={() => {
                  void sendReaction(emoji);
                }}
                className="rounded-full bg-slate-800 px-2 py-1 text-lg leading-none hover:bg-slate-700"
                title={`Enviar reacción ${emoji}`}
                aria-label={`Enviar reacción ${emoji}`}
              >
                {emoji}
              </button>
            ))}
            <button
              type="button"
              onClick={toggleHandRaised}
              className={`rounded-full px-3 py-1 text-xs font-semibold ${
                handRaised
                  ? "bg-amber-500 text-amber-950 hover:bg-amber-400"
                  : "bg-sky-600 text-white hover:bg-sky-500"
              }`}
            >
              {handRaised ? "Bajar mano" : "Levantar mano"}
            </button>
          </div>
        </div>
      </div>
      <LayoutContextProvider onWidgetChange={setWidgetState}>
        <div className="flex min-h-0 flex-1">
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="lk-video-conference-inner min-h-0 flex-1">
              {!focusTrack ? (
                <div className="lk-grid-layout-wrapper min-h-0 flex-1">
                  <GridLayout tracks={tracks} className="h-full">
                    <ParticipantTile />
                  </GridLayout>
                </div>
              ) : (
                <div className="lk-focus-layout-wrapper min-h-0 flex-1">
                  <FocusLayoutContainer className="h-full">
                    <CarouselLayout tracks={nonFocusedTracks}>
                      <ParticipantTile />
                    </CarouselLayout>
                    <FocusLayout trackRef={focusTrack} />
                  </FocusLayoutContainer>
                </div>
              )}
            </div>
            <div className="border-t border-slate-800 bg-slate-950/80 px-2 py-2">
              <div className="lk-control-bar">
                <div className="lk-button-group">
                  <TrackToggle source={Track.Source.Microphone} showIcon={true}>
                    Micrófono
                  </TrackToggle>
                  <div className="lk-button-group-menu">
                    <MediaDeviceMenu kind="audioinput" />
                  </div>
                </div>
                <div className="lk-button-group">
                  <TrackToggle source={Track.Source.Camera} showIcon={true}>
                    Cámara
                  </TrackToggle>
                  <div className="lk-button-group-menu">
                    <MediaDeviceMenu kind="videoinput" />
                  </div>
                </div>
                <TrackToggle
                  source={Track.Source.ScreenShare}
                  captureOptions={{ audio: true, selfBrowserSurface: "include" }}
                  showIcon={true}
                  onChange={(enabled) => {
                    setIsScreenSharing(enabled);
                  }}
                >
                  {isScreenSharing ? "Detener pantalla" : "Compartir pantalla"}
                </TrackToggle>
                <ChatToggle>
                  Mensajes
                </ChatToggle>
              </div>
            </div>
          </div>
          <LiveRoomChatPanel visible={Boolean(widgetState.showChat)} />
        </div>
      </LayoutContextProvider>
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
  const liveClassQuery = useMemo(() => buildLiveClassQuery(courseId, lessonId), [courseId, lessonId]);
  const participantsEndpoint = useMemo(
    () =>
      `/api/live/classes/${encodeURIComponent(classId)}/participants${liveClassQuery ? `?${liveClassQuery}` : ""}`,
    [classId, liveClassQuery],
  );
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
  const [livekitError, setLivekitError] = useState<string | null>(null);
  const [startingSession, setStartingSession] = useState(false);
  const [endingSession, setEndingSession] = useState(false);
  const [showEndSessionConfirm, setShowEndSessionConfirm] = useState(false);
  const [showModerationPanel, setShowModerationPanel] = useState(false);
  const [participantsLoading, setParticipantsLoading] = useState(false);
  const [participantsError, setParticipantsError] = useState<string | null>(null);
  const [participants, setParticipants] = useState<LiveRoomParticipantSummary[]>([]);
  const [mutingAll, setMutingAll] = useState(false);
  const [mutingParticipantId, setMutingParticipantId] = useState<string | null>(null);
  const [moderationMessage, setModerationMessage] = useState<string | null>(null);
  const autoStartAttemptedRef = useRef(false);
  const browserSupported = useMemo(() => isBrowserSupported(), []);

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
    setLivekitError(null);
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
        setShowModerationPanel(false);
        setParticipants([]);
        setParticipantsError(null);
        setModerationMessage(null);
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
    setShowEndSessionConfirm(false);
    setShowModerationPanel(false);
    setParticipants([]);
    setParticipantsError(null);
    setModerationMessage(null);
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

  const requestEndSessionConfirmation = useCallback(() => {
    if (asRole !== "teacher" || endingSession) return;
    setShowEndSessionConfirm(true);
  }, [asRole, endingSession]);

  const endSession = useCallback(async () => {
    if (!classId || !user || asRole !== "teacher") return;

    setShowEndSessionConfirm(false);
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
      setShowModerationPanel(false);
      setParticipants([]);
      setParticipantsError(null);
      setModerationMessage(null);
    } catch (endError) {
      console.error("No se pudo terminar la sesión", endError);
      setError(endError instanceof Error ? endError.message : "No se pudo terminar la sesión");
    } finally {
      setEndingSession(false);
    }
  }, [asRole, classId, courseId, lessonId, user]);

  const fetchParticipants = useCallback(async () => {
    if (!classId || !user || asRole !== "teacher") return;

    setParticipantsLoading(true);
    setParticipantsError(null);
    try {
      const idToken = await user.getIdToken();
      const response = await fetch(participantsEndpoint, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${idToken}`,
        },
      });
      const payload = (await response.json().catch(() => null)) as LiveParticipantsResponse | null;
      if (!response.ok || !payload?.success || !payload.data) {
        throw new Error(payload?.error || "No se pudo consultar participantes");
      }

      setParticipants(payload.data.participants ?? []);
      if (payload.data.roomName) {
        setRoomName(payload.data.roomName);
      }
    } catch (participantsFetchError) {
      console.error("No se pudo consultar participantes de la sala", participantsFetchError);
      setParticipantsError(
        participantsFetchError instanceof Error
          ? participantsFetchError.message
          : "No se pudo consultar participantes",
      );
    } finally {
      setParticipantsLoading(false);
    }
  }, [asRole, classId, participantsEndpoint, user]);

  const submitParticipantsAction = useCallback(
    async (actionPayload: Record<string, unknown>) => {
      if (!classId || !user || asRole !== "teacher") {
        throw new Error("No tienes permisos para moderar audio");
      }

      const idToken = await user.getIdToken();
      const response = await fetch(participantsEndpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify(actionPayload),
      });
      const payload = (await response.json().catch(() => null)) as
        | LiveParticipantsActionResponse
        | null;
      if (!response.ok || !payload?.success) {
        throw new Error(payload?.error || "No se pudo ejecutar la acción");
      }
      return payload.data?.result;
    },
    [asRole, classId, participantsEndpoint, user],
  );

  const muteParticipant = useCallback(
    async (participantIdentity: string) => {
      if (!participantIdentity) return;
      setParticipantsError(null);
      setModerationMessage(null);
      setMutingParticipantId(participantIdentity);
      try {
        const result = await submitParticipantsAction({
          action: "mute_participant",
          participantIdentity,
        });
        const mutedCount = result?.mutedTrackSids?.length ?? 0;
        const totalMicTracks = result?.totalMicrophoneTracks ?? 0;
        setModerationMessage(
          mutedCount > 0
            ? `Micrófono(s) silenciado(s): ${mutedCount}.`
            : totalMicTracks > 0
              ? "Ese participante ya tenía el micrófono silenciado."
              : "Ese participante no tiene micrófono activo.",
        );
        await fetchParticipants();
      } catch (muteError) {
        console.error("No se pudo silenciar participante", muteError);
        setParticipantsError(
          muteError instanceof Error ? muteError.message : "No se pudo silenciar participante",
        );
      } finally {
        setMutingParticipantId(null);
      }
    },
    [fetchParticipants, submitParticipantsAction],
  );

  const muteAllParticipants = useCallback(async () => {
    setParticipantsError(null);
    setModerationMessage(null);
    setMutingAll(true);
    try {
      const result = await submitParticipantsAction({
        action: "mute_all",
        excludeSelf: true,
        includeTeacherParticipants: false,
      });
      const targetedParticipants = result?.targetedParticipants ?? 0;
      const mutedParticipants = result?.mutedParticipants ?? 0;
      const mutedMicrophoneTracks = result?.mutedMicrophoneTracks ?? 0;
      setModerationMessage(
        `Silenciados ${mutedParticipants}/${targetedParticipants} participantes (${mutedMicrophoneTracks} micrófono(s)).`,
      );
      await fetchParticipants();
    } catch (muteAllError) {
      console.error("No se pudo silenciar a todos", muteAllError);
      setParticipantsError(
        muteAllError instanceof Error ? muteAllError.message : "No se pudo silenciar a todos",
      );
    } finally {
      setMutingAll(false);
    }
  }, [fetchParticipants, submitParticipantsAction]);

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

  useEffect(() => {
    if (!showModerationPanel || asRole !== "teacher") return;
    if (!token || !livekitUrl) return;
    void fetchParticipants();
  }, [asRole, fetchParticipants, livekitUrl, showModerationPanel, token]);

  useEffect(() => {
    if (asRole === "teacher") return;
    setShowEndSessionConfirm(false);
    setShowModerationPanel(false);
    setParticipants([]);
    setParticipantsError(null);
    setModerationMessage(null);
  }, [asRole]);

  useEffect(() => {
    if (!moderationMessage) return;
    const timeout = window.setTimeout(() => {
      setModerationMessage(null);
    }, 4000);
    return () => window.clearTimeout(timeout);
  }, [moderationMessage]);

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

  if (!browserSupported) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-slate-950 px-4 text-center text-white">
        <p>Este navegador no es compatible con clases en vivo.</p>
        <p className="max-w-lg text-sm text-slate-300">
          Usa una versión reciente de Chrome, Edge, Firefox o Safari.
        </p>
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
            {formatEsMxDateTime(scheduledStartAt)}{" "}
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
      {livekitError ? (
        <div className="pointer-events-none fixed left-0 right-0 top-14 z-20 flex justify-center px-3">
          <p className="pointer-events-auto rounded-full bg-red-600/90 px-3 py-1 text-xs font-semibold text-white">
            {livekitError}
          </p>
        </div>
      ) : null}
      <LiveKitRoom
        token={token}
        serverUrl={livekitUrl}
        connect={true}
        // Publish media manually from controls to avoid browser/device-specific
        // join failures when mic/camera permissions are blocked.
        audio={false}
        video={false}
        onError={(liveError) => {
          console.error("LiveKit error", liveError);
          setLivekitError("No se pudo conectar a la sala. Revisa internet y permisos del navegador.");
        }}
        onMediaDeviceFailure={(failure) => {
          if (failure === MediaDeviceFailure.PermissionDenied) {
            setLivekitError("Permiso de cámara o micrófono bloqueado en el navegador.");
            return;
          }
          if (failure === MediaDeviceFailure.NotFound) {
            setLivekitError("No se detectó cámara o micrófono en este dispositivo.");
            return;
          }
          setLivekitError("No se pudo acceder a dispositivos de audio/video.");
        }}
        onConnected={() => {
          setLivekitError(null);
        }}
        onDisconnected={() => {
          setToken(null);
          setLivekitUrl(null);
          setWaitingReason((currentReason) =>
            currentReason === "session_ended" ? "session_ended" : "left_room",
          );
          setLoading(false);
          setShowEndSessionConfirm(false);
          setShowModerationPanel(false);
          setParticipants([]);
          setParticipantsError(null);
          setModerationMessage(null);
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
              onClick={() => {
                setShowModerationPanel((current) => !current);
              }}
              className="rounded-full bg-sky-600 px-3 py-1 text-xs font-semibold text-white hover:bg-sky-500"
            >
              {showModerationPanel ? "Cerrar moderación" : "Moderar audio"}
            </button>
          ) : null}
          {asRole === "teacher" ? (
            <button
              type="button"
              disabled={endingSession}
              onClick={requestEndSessionConfirmation}
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
      {asRole === "teacher" && showEndSessionConfirm ? (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/70 px-4">
          <div className="w-full max-w-md rounded-2xl border border-slate-700 bg-slate-900 p-5 text-white shadow-2xl">
            <h2 className="text-lg font-semibold">Confirmar fin de sesión</h2>
            <p className="mt-2 text-sm text-slate-300">
              ¿Seguro que quieres terminar la sesión en vivo? Esta acción finalizará la clase para todos los
              participantes.
            </p>
            <div className="mt-5 flex items-center justify-end gap-2">
              <button
                type="button"
                disabled={endingSession}
                onClick={() => {
                  setShowEndSessionConfirm(false);
                }}
                className="rounded-lg border border-slate-600 px-3 py-2 text-sm font-semibold text-slate-100 hover:bg-slate-800 disabled:opacity-60"
              >
                Cancelar
              </button>
              <button
                type="button"
                disabled={endingSession}
                onClick={endSession}
                className="rounded-lg bg-amber-600 px-3 py-2 text-sm font-semibold text-white hover:bg-amber-500 disabled:opacity-60"
              >
                {endingSession ? "Terminando..." : "Sí, terminar sesión"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {asRole === "teacher" && showModerationPanel ? (
        <div className="pointer-events-none fixed right-3 top-16 z-30 flex w-[22rem] max-w-[calc(100vw-1.5rem)] justify-end">
          <div className="pointer-events-auto max-h-[72vh] w-full overflow-hidden rounded-xl border border-slate-700 bg-slate-900/95 shadow-2xl backdrop-blur">
            <div className="flex items-center justify-between border-b border-slate-700 px-3 py-2">
              <div>
                <p className="text-sm font-semibold text-white">Moderar audio</p>
                <p className="text-[11px] text-slate-300">Anfitrión y mentores pueden silenciar participantes.</p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setShowModerationPanel(false);
                }}
                className="rounded-md border border-slate-600 px-2 py-1 text-[11px] font-semibold text-slate-200 hover:bg-slate-800"
              >
                Cerrar
              </button>
            </div>
            <div className="flex items-center gap-2 border-b border-slate-800 px-3 py-2">
              <button
                type="button"
                disabled={participantsLoading || mutingAll || mutingParticipantId !== null}
                onClick={() => {
                  void fetchParticipants();
                }}
                className="rounded-md border border-slate-600 px-2 py-1 text-xs font-semibold text-slate-100 hover:bg-slate-800 disabled:opacity-60"
              >
                {participantsLoading ? "Actualizando..." : "Actualizar"}
              </button>
              <button
                type="button"
                disabled={
                  participantsLoading ||
                  mutingAll ||
                  mutingParticipantId !== null ||
                  participants.length === 0
                }
                onClick={() => {
                  void muteAllParticipants();
                }}
                className="rounded-md bg-amber-600 px-2 py-1 text-xs font-semibold text-white hover:bg-amber-500 disabled:opacity-60"
              >
                {mutingAll ? "Silenciando..." : "Silenciar a todos"}
              </button>
            </div>
            {participantsError ? (
              <p className="border-b border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-100">
                {participantsError}
              </p>
            ) : null}
            {moderationMessage ? (
              <p className="border-b border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-100">
                {moderationMessage}
              </p>
            ) : null}
            <div className="max-h-[52vh] overflow-y-auto">
              {participantsLoading && participants.length === 0 ? (
                <p className="px-3 py-4 text-xs text-slate-300">Cargando participantes...</p>
              ) : participants.length === 0 ? (
                <p className="px-3 py-4 text-xs text-slate-300">No hay participantes en la sala.</p>
              ) : (
                participants.map((participant) => {
                  const isSelfParticipant = participant.identity === user.uid;
                  const isTeacherParticipant = isTeacherLikeLiveRole(participant.role);
                  const canMuteParticipant =
                    !isSelfParticipant &&
                    !isTeacherParticipant &&
                    participant.microphone.unmuted > 0;
                  return (
                    <div key={participant.identity} className="border-b border-slate-800 px-3 py-3">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-semibold text-white">
                            {participant.name}
                            {isSelfParticipant ? " (tú)" : ""}
                          </p>
                          <p className="truncate text-[11px] text-slate-400">{participant.identity}</p>
                        </div>
                        <span className="rounded bg-slate-700 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-200">
                          {isTeacherParticipant ? "Anfitrión" : "Participante"}
                        </span>
                      </div>
                      <div className="mt-2 flex items-center justify-between gap-2">
                        <p className="text-xs text-slate-200">
                          Micrófonos: {participant.microphone.unmuted} abiertos de {participant.microphone.total}
                        </p>
                        <button
                          type="button"
                          disabled={
                            !canMuteParticipant ||
                            participantsLoading ||
                            mutingAll ||
                            mutingParticipantId !== null
                          }
                          onClick={() => {
                            void muteParticipant(participant.identity);
                          }}
                          className="rounded-md bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-900 hover:bg-white disabled:opacity-50"
                        >
                          {mutingParticipantId === participant.identity
                            ? "Silenciando..."
                            : participant.microphone.unmuted > 0
                              ? "Silenciar"
                              : "Silenciado"}
                        </button>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
