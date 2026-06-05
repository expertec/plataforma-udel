"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Track } from "livekit-client";

export type ParticipantsPipTile = {
  id: string;
  name: string;
  track: Track | null;
};

type DocumentPictureInPicture = {
  requestWindow: (options?: { width?: number; height?: number }) => Promise<Window>;
  window: Window | null;
};

function getDocumentPip(): DocumentPictureInPicture | null {
  if (typeof window === "undefined") return null;
  const dpip = (window as unknown as { documentPictureInPicture?: DocumentPictureInPicture })
    .documentPictureInPicture;
  return dpip ?? null;
}

export function isStudentsPipSupported(): boolean {
  return getDocumentPip() !== null;
}

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function PipTileView({ tile }: { tile: ParticipantsPipTile }) {
  const videoRef = useRef<HTMLVideoElement>(null);

  // Attach the track to our own element in the PiP window. The same track can be
  // attached to several elements at once, so the on-screen tile is unaffected. We
  // detach only this element on cleanup.
  useEffect(() => {
    const element = videoRef.current;
    const track = tile.track;
    if (!element || !track) return;
    track.attach(element);
    return () => {
      try {
        track.detach(element);
      } catch {
        // ignore
      }
    };
  }, [tile.track]);

  const hasVideo = Boolean(tile.track);

  return (
    <div
      style={{
        position: "relative",
        flex: "1 1 45%",
        minWidth: 120,
        aspectRatio: "16 / 9",
        background: "#1e293b",
        borderRadius: 8,
        overflow: "hidden",
      }}
    >
      {hasVideo ? (
        <video
          ref={videoRef}
          autoPlay
          muted
          playsInline
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
            transform: "scaleX(-1)",
          }}
        />
      ) : (
        <div
          style={{
            display: "flex",
            width: "100%",
            height: "100%",
            alignItems: "center",
            justifyContent: "center",
            color: "#cbd5e1",
            fontSize: 22,
            fontFamily: "sans-serif",
          }}
        >
          {getInitials(tile.name)}
        </div>
      )}
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          padding: "2px 6px",
          background: "rgba(0,0,0,0.55)",
          color: "#fff",
          fontSize: 11,
          fontFamily: "sans-serif",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {tile.name}
      </div>
    </div>
  );
}

function PipContent({ tiles }: { tiles: ParticipantsPipTile[] }) {
  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: 6,
        padding: 6,
        alignContent: "flex-start",
        boxSizing: "border-box",
        minHeight: "100vh",
      }}
    >
      {tiles.length === 0 ? (
        <div
          style={{
            color: "#94a3b8",
            fontFamily: "sans-serif",
            fontSize: 13,
            padding: 12,
          }}
        >
          Esperando alumnos…
        </div>
      ) : (
        tiles.map((tile) => <PipTileView key={tile.id} tile={tile} />)
      )}
    </div>
  );
}

/**
 * Floating, always-on-top window that shows the remote participants (students)
 * using the Document Picture-in-Picture API. Because the video elements live in
 * the PiP window, they keep updating even while the teacher is on another tab or
 * app interacting with their shared screen.
 */
export function useStudentsPip(tiles: ParticipantsPipTile[]) {
  const [pipWindow, setPipWindow] = useState<Window | null>(null);

  const close = useCallback(() => {
    setPipWindow((current) => {
      current?.close();
      return null;
    });
  }, []);

  const open = useCallback(async () => {
    const dpip = getDocumentPip();
    if (!dpip) return;
    try {
      // Must be invoked synchronously within the click gesture to keep activation.
      const win = await dpip.requestWindow({ width: 360, height: 320 });
      win.document.body.style.margin = "0";
      win.document.body.style.background = "#0f172a";
      win.addEventListener("pagehide", () => setPipWindow(null), { once: true });
      setPipWindow(win);
    } catch (error) {
      console.error("No se pudo abrir la ventana flotante de alumnos", error);
    }
  }, []);

  const toggle = useCallback(() => {
    if (pipWindow) {
      close();
    } else {
      void open();
    }
  }, [close, open, pipWindow]);

  useEffect(() => {
    return () => {
      pipWindow?.close();
    };
  }, [pipWindow]);

  const portal = pipWindow
    ? createPortal(<PipContent tiles={tiles} />, pipWindow.document.body)
    : null;

  return {
    supported: getDocumentPip() !== null,
    active: pipWindow !== null,
    toggle,
    portal,
  };
}
