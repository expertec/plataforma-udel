"use client";

import { onAuthStateChanged, type User } from "firebase/auth";
import { useEffect, useState } from "react";
import { RoleGate } from "@/components/auth/RoleGate";
import { auth } from "@/lib/firebase/client";
import { TeacherLiveClassesView } from "../clases-en-vivo/_components/TeacherLiveClassesView";

export default function TeacherOwnLiveClassesPage() {
  const [currentUser, setCurrentUser] = useState<User | null>(auth.currentUser);
  const [authReady, setAuthReady] = useState(Boolean(auth.currentUser));

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (user) => {
      setCurrentUser(user);
      setAuthReady(true);
    });

    return () => unsub();
  }, []);

  return (
    <RoleGate allowedRole="teacher">
      <TeacherLiveClassesView currentUser={currentUser} authReady={authReady} />
    </RoleGate>
  );
}
