"use client";

import { useEffect, useMemo, useState } from "react";
import { MessageCircle, MessagesSquare, Paperclip } from "lucide-react";
import { ForumPanel } from "@/app/student/StudentFeedPageClient";
import { useAulaData } from "../_lib/AulaDataContext";
import { AssignmentSection } from "./AssignmentSection";
import { CommentsTab } from "./CommentsTab";
import type { FeedClass } from "../_lib/types";

type TabId = "comentarios" | "foro" | "tarea";

/**
 * El ForumPanel del feed clásico está posicionado `fixed`. `positionClass` es su
 * escape de estilos, así que lo anclamos al panel en lugar de a la pantalla.
 */
const EMBEDDED_FORUM_POSITION =
  "static! z-auto! h-full max-w-none! w-full bg-transparent! shadow-none! backdrop-blur-none!";

export function ClassPanel({
  cls,
  activeTab,
  onTabChange,
}: {
  cls: FeedClass;
  activeTab: TabId;
  onTabChange: (tab: TabId) => void;
}) {
  const { forumDone, refreshForumStatus, studentName, currentUser } = useAulaData();
  const [commentsCount, setCommentsCount] = useState<number | null>(null);

  const forumPending = cls.forumEnabled === true && forumDone[cls.id] !== true;

  const tabs = useMemo(() => {
    const list: Array<{ id: TabId; label: string; icon: typeof MessageCircle; badge?: string }> = [
      {
        id: "comentarios",
        label: "Comentarios",
        icon: MessageCircle,
        badge: commentsCount !== null ? String(commentsCount) : undefined,
      },
    ];
    if (cls.forumEnabled) {
      list.push({
        id: "foro",
        label: "Foro",
        icon: MessagesSquare,
        badge: forumPending ? "!" : undefined,
      });
    }
    if (cls.hasAssignment) {
      list.push({ id: "tarea", label: "Tarea", icon: Paperclip });
    }
    return list;
  }, [cls.forumEnabled, cls.hasAssignment, commentsCount, forumPending]);

  // Si la clase actual no tiene la pestaña abierta, vuelve a comentarios.
  useEffect(() => {
    if (!tabs.some((tab) => tab.id === activeTab)) onTabChange("comentarios");
  }, [tabs, activeTab, onTabChange]);

  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden rounded-2xl border border-[var(--aula-border)] bg-[var(--aula-surface)]">
      <nav className="flex shrink-0 border-b border-[var(--aula-border)]">
        {tabs.map((tab) => {
          const active = tab.id === activeTab;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => onTabChange(tab.id)}
              className={`flex flex-1 items-center justify-center gap-2 border-b-2 px-3 py-3.5 text-sm font-medium transition-colors ${
                active
                  ? "border-[var(--aula-accent)] text-[var(--aula-text)]"
                  : "border-transparent text-[var(--aula-text-muted)] hover:text-[var(--aula-text)]"
              }`}
            >
              <tab.icon size={16} className={active ? "text-[var(--aula-accent-soft)]" : undefined} />
              {tab.label}
              {tab.badge && (
                <span
                  className={`rounded-full px-1.5 text-xs ${
                    tab.badge === "!"
                      ? "bg-amber-500/20 text-amber-300"
                      : "text-[var(--aula-text-muted)]"
                  }`}
                >
                  {tab.badge}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      <div className="min-h-0 flex-1 overflow-hidden pt-4">
        {activeTab === "comentarios" && (
          <CommentsTab cls={cls} onCountChange={setCommentsCount} />
        )}

        {activeTab === "foro" && cls.forumEnabled && (
          <div className="h-full overflow-hidden">
            <ForumPanel
              open
              positionClass={EMBEDDED_FORUM_POSITION}
              onClose={() => onTabChange("comentarios")}
              classMeta={cls}
              requiredFormat={cls.forumRequiredFormat ?? "text"}
              studentName={studentName}
              studentId={currentUser?.uid}
              onSubmitted={() => {
                void refreshForumStatus();
              }}
              onDeleted={() => {
                void refreshForumStatus();
              }}
            />
          </div>
        )}

        {activeTab === "tarea" && cls.hasAssignment && (
          <div className="h-full overflow-y-auto px-4 pb-4">
            <AssignmentSection cls={cls} />
          </div>
        )}
      </div>
    </section>
  );
}
