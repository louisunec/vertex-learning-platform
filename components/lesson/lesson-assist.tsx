"use client";

import { useState } from "react";
import type { LessonFeatures } from "@/lib/lesson/features";
import { LessonCheck } from "./lesson-check";
import { TutorPanel, type ActiveTask } from "./tutor-panel";

/**
 * The lesson page's learning features under the video (development plan §5
 * PR-7), rendered only when `resolveLessonFeatures` enables one. It shares
 * the open check question with the tutor so tutor help is recorded against
 * that task, as the help policy requires.
 */
export function LessonAssist({
  lessonId,
  lessonSlug,
  courseSlug,
  lessonRev,
  startSeconds,
  durationSeconds,
  features,
}: {
  lessonId: string;
  lessonSlug: string;
  courseSlug: string | null;
  lessonRev: string;
  startSeconds: number | null;
  durationSeconds: number | null;
  features: LessonFeatures;
}) {
  const [activeTask, setActiveTask] = useState<ActiveTask>(null);

  return (
    <div className="mt-6 flex flex-col gap-4">
      {features.tutor && (
        <TutorPanel
          lessonId={lessonId}
          lessonSlug={lessonSlug}
          courseSlug={courseSlug}
          startSeconds={startSeconds}
          durationSeconds={durationSeconds}
          activeTask={activeTask}
        />
      )}
      {features.check && (
        <LessonCheck
          lessonId={lessonId}
          lessonSlug={lessonSlug}
          courseSlug={courseSlug}
          lessonRev={lessonRev}
          hints={features.hints}
          onActiveTaskChange={setActiveTask}
        />
      )}
    </div>
  );
}
