"use client";

import { useRoomContext } from "@livekit/components-react";
import type { User } from "firebase/auth";
import { ConnectionState, RoomEvent, Track, type Participant, type TrackPublication } from "livekit-client";
import { useEffect, useRef } from "react";

export function LiveCameraAttendance({ user, endpoint }: { user: User; endpoint: string }) {
  const room = useRoomContext();
  const pendingRequests = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    let hasReported = false;
    const enqueue = (cameraEnabled: boolean, roomConnected: boolean) => {
      hasReported = true;
      pendingRequests.current = pendingRequests.current.then(async () => {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            const token = await user.getIdToken();
            const response = await fetch(endpoint, {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
              body: JSON.stringify({ action: "camera", cameraEnabled, roomConnected }),
              keepalive: true,
            });
            if (response.ok || response.status < 500) return;
          } catch (error) {
            if (attempt === 1) console.warn("No se pudo registrar el estado de cámara:", error);
          }
        }
      }).catch((error) => console.warn("No se pudo registrar el estado de cámara:", error));
    };
    const reportState = () => {
      const connected = room.state === ConnectionState.Connected;
      if (connected || hasReported) enqueue(connected && room.localParticipant.isCameraEnabled, connected);
    };
    const reportTrack = (publication: TrackPublication, participant: Participant) => {
      if (participant.isLocal && publication.source === Track.Source.Camera) reportState();
    };

    room.on(RoomEvent.Connected, reportState);
    room.on(RoomEvent.Reconnected, reportState);
    room.on(RoomEvent.Reconnecting, reportState);
    room.on(RoomEvent.Disconnected, reportState);
    room.on(RoomEvent.LocalTrackPublished, reportTrack);
    room.on(RoomEvent.LocalTrackUnpublished, reportTrack);
    room.on(RoomEvent.TrackMuted, reportTrack);
    room.on(RoomEvent.TrackUnmuted, reportTrack);
    const heartbeat = window.setInterval(reportState, 30_000);
    reportState();
    return () => {
      window.clearInterval(heartbeat);
      room.off(RoomEvent.Connected, reportState);
      room.off(RoomEvent.Reconnected, reportState);
      room.off(RoomEvent.Reconnecting, reportState);
      room.off(RoomEvent.Disconnected, reportState);
      room.off(RoomEvent.LocalTrackPublished, reportTrack);
      room.off(RoomEvent.LocalTrackUnpublished, reportTrack);
      room.off(RoomEvent.TrackMuted, reportTrack);
      room.off(RoomEvent.TrackUnmuted, reportTrack);
    };
  }, [endpoint, room, user]);

  return null;
}
