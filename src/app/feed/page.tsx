"use client";

import { Suspense } from "react";
import StudentFeedPage from "../student/page";

// Reuse the new TikTok-like student feed under /feed for convenience.
export default function FeedPage() {
  return (
    <Suspense fallback={null}>
      <StudentFeedPage />
    </Suspense>
  );
}
