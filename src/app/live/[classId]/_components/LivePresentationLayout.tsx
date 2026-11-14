"use client";

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

export const presentationCameraStyle: CSSProperties = {
  position: "relative",
  flex: "0 0 160px",
  width: 160,
  minWidth: 160,
  maxWidth: 160,
  height: 90,
  minHeight: 90,
  maxHeight: 90,
  boxSizing: "border-box",
  overflow: "hidden",
  borderRadius: 10,
};

/** Students remain above the stage; the teacher appears in a movable circular overlay. */
export function LivePresentationLayout({ cameras, presenter, presenterPosition, canMovePresenter = false, onPresenterPositionChange, children }: {
  cameras?: ReactNode;
  presenter?: ReactNode;
  presenterPosition?: { x: number; y: number };
  canMovePresenter?: boolean;
  onPresenterPositionChange?: (position: { x: number; y: number }) => Promise<boolean>;
  children: ReactNode;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ x: number; y: number; left: number; top: number; position: { x: number; y: number } } | null>(null);
  const [bounds, setBounds] = useState({ width: 0, height: 0 });
  const [localPosition, setLocalPosition] = useState<{ x: number; y: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [movePending, setMovePending] = useState(false);
  const position = localPosition ?? presenterPosition ?? { x: 0, y: 1 };
  const movable = canMovePresenter && !movePending && Boolean(onPresenterPositionChange);
  const commitPosition = async (next: { x: number; y: number }) => {
    setMovePending(true);
    try { await onPresenterPositionChange?.(next); } catch { /* The room action reports failures. */ }
    finally { setMovePending(false); setLocalPosition(null); }
  };
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const observer = new ResizeObserver(([entry]) => setBounds({ width: entry.contentRect.width, height: entry.contentRect.height }));
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);
  const size = Math.max(0, Math.min(168, Math.max(112, bounds.width * 0.18), bounds.width - 24, bounds.height - 24));
  const minLeft = 12;
  const maxLeft = Math.max(minLeft, bounds.width - size - 12);
  const hasToolbarSpace = bounds.height >= size + 112;
  const minTop = Math.min(hasToolbarSpace ? 48 : 12, Math.max(0, bounds.height - size));
  const maxTop = Math.max(minTop, bounds.height - size - (hasToolbarSpace ? 56 : 12));
  const left = minLeft + position.x * (maxLeft - minLeft);
  const top = minTop + position.y * (maxTop - minTop);
  return <div className="live-presentation-layout" style={{
    display: "grid", gridTemplateRows: cameras ? "96px minmax(0, 1fr)" : "minmax(0, 1fr)",
    flex: "1 1 0%", gap: 8, padding: 8, boxSizing: "border-box",
    width: "100%", height: "100%", minWidth: 0, minHeight: 0, overflow: "hidden",
  }}>
    {cameras ? <div className="live-presentation-cameras" role="region" aria-label="Cámaras de participantes" tabIndex={0} style={{
      height: 96, minHeight: 96, maxHeight: 96, minWidth: 0,
      overflowX: "auto", overflowY: "hidden", overscrollBehaviorX: "contain", scrollbarWidth: "thin",
    }}>
      <div className="live-camera-row" style={{
        display: "flex", flexDirection: "row", flexWrap: "nowrap", justifyContent: "center", alignItems: "center",
        gap: 8, width: "max-content", minWidth: "100%", height: 90, maxHeight: 90,
      }}>{cameras}</div>
    </div> : null}
    <div ref={stageRef} className="live-presentation-content" role="region" aria-label="Presentación compartida" style={{
      position: "relative", width: "100%", height: "100%", minWidth: 0, minHeight: 0, overflow: "hidden",
    }}>
      {children}
      {presenter && size > 0 ? <div
        className="live-presenter-avatar"
        role={canMovePresenter ? "button" : "img"} tabIndex={canMovePresenter ? 0 : undefined} aria-label={canMovePresenter ? "Mover cámara del profesor" : "Cámara del profesor"} title={canMovePresenter ? "Arrastra para mover la cámara del profesor" : undefined}
        style={{ position: "absolute", left, top, width: size, height: size, zIndex: 20, borderRadius: "50%", overflow: "hidden", border: "3px solid #38bdf8", boxSizing: "border-box", background: "#0f172a", boxShadow: "0 8px 28px rgb(0 0 0 / 40%)", cursor: movable ? dragging ? "grabbing" : "grab" : "default", touchAction: movable ? "none" : "auto" }}
        onPointerDown={(event) => {
          if (!movable || event.button !== 0) return;
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          dragRef.current = { x: event.clientX, y: event.clientY, left, top, position };
          setDragging(true);
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current;
          if (!drag || !canMovePresenter) return;
          const next = {
            x: Math.max(0, Math.min(1, (drag.left + event.clientX - drag.x - minLeft) / Math.max(1, maxLeft - minLeft))),
            y: Math.max(0, Math.min(1, (drag.top + event.clientY - drag.y - minTop) / Math.max(1, maxTop - minTop))),
          };
          drag.position = next;
          setLocalPosition(next);
        }}
        onPointerUp={(event) => {
          const next = dragRef.current?.position;
          dragRef.current = null; setDragging(false);
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
          if (next && canMovePresenter) void commitPosition(next);
        }}
        onPointerCancel={() => { dragRef.current = null; setDragging(false); setLocalPosition(null); }}
        onKeyDown={(event) => {
          if (!movable || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
          event.preventDefault();
          const next = { x: Math.max(0, Math.min(1, position.x + (event.key === "ArrowRight" ? 0.05 : event.key === "ArrowLeft" ? -0.05 : 0))), y: Math.max(0, Math.min(1, position.y + (event.key === "ArrowDown" ? 0.05 : event.key === "ArrowUp" ? -0.05 : 0))) };
          setLocalPosition(next);
          void commitPosition(next);
        }}
      >{presenter}</div> : null}
    </div>
  </div>;
}
