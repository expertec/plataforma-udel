import { Suspense } from "react";
import StudentFeedPageClient from "./StudentFeedPageClient";
import StudentFeedErrorBoundary from "./StudentFeedErrorBoundary";

export default function StudentPage() {
  return (
    <StudentFeedErrorBoundary>
      <Suspense fallback={null}>
        <StudentFeedPageClient />
      </Suspense>
    </StudentFeedErrorBoundary>
  );
}
