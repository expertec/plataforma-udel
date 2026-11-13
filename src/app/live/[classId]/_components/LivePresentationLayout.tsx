"use client";

import type { CSSProperties, ReactNode } from "react";

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

/** Keep cameras above the shared stage, with an independent horizontal scroll. */
export function LivePresentationLayout({ cameras, children }: { cameras?: ReactNode; children: ReactNode }) {
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
    <div className="live-presentation-content" role="region" aria-label="Presentación compartida" style={{
      position: "relative", width: "100%", height: "100%", minWidth: 0, minHeight: 0, overflow: "hidden",
    }}>
      {children}
    </div>
  </div>;
}
