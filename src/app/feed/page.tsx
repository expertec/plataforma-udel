"use client";

import { Suspense } from "react";
import StudentFeedPageClient from "../student/StudentFeedPageClient";

// Reuse the new TikTok-like student feed under /feed for convenience.
export default function FeedPage() {
  return (
    <Suspense fallback={null}>
      <StudentFeedPageClient />
    </Suspense>
  );
}
