import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { Breadcrumbs } from "@/components/ui";
import { SiteHeader } from "@/components/home/site-header";
import { Skyline } from "@/components/home/skyline";
import { CourseCurriculum, type CurriculumModule } from "@/components/course/course-curriculum";
import { CourseHero } from "@/components/course/course-hero";
import { CourseProgressBar } from "@/components/course/course-progress-bar";
import { LearningOutcomes } from "@/components/course/learning-outcomes";
import { summarizeCourseProgress } from "@/lib/course-progress";
import { getPostHogClient } from "@/lib/posthog-server";
import { getCourseBySlug, getProgressForUser } from "@/sanity/data";
import { flattenLessons } from "@/sanity/lib/curriculum";

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const course = await getCourseBySlug(slug);
  if (!course) return { title: "Course not found" };
  return { title: course.title, description: course.summary ?? undefined };
}

export default async function CoursePage({ params }: Props) {
  const { slug } = await params;
  const [course, { userId }] = await Promise.all([getCourseBySlug(slug), auth()]);
  if (!course) notFound();

  // Learner state is read per request, keyed by the server-resolved Clerk user id.
  const progressRows = userId ? await getProgressForUser(userId) : null;
  const progress = summarizeCourseProgress(course.modules, progressRows);

  const lessonHref = (lessonSlug: string) => `/lessons/${lessonSlug}`;
  const flat = flattenLessons(course.modules);
  const resume = flat.find((entry) => entry.lesson._id === progress.resumeLessonId) ?? null;
  const ctaHref = resume ? lessonHref(resume.lesson.slug) : null;
  const ctaLabel = progress.hasProgress ? "Continue Learning" : "Start Learning";

  // Track course page view server-side
  const posthog = getPostHogClient();
  posthog.capture({
    distinctId: userId ?? "anonymous",
    event: "course_viewed",
    properties: {
      course_title: course.title,
      course_slug: slug,
      course_level: course.level,
      has_progress: progress.hasProgress,
    },
  });
  await posthog.flush();

  const modules: CurriculumModule[] = (course.modules ?? []).map((mod, moduleIndex) => {
    const lessons = (mod.lessons ?? []).filter(Boolean);
    const durations = lessons.map((l) => l.durationSeconds).filter((d): d is number => typeof d === "number");
    return {
      key: mod._key,
      title: mod.title,
      summary: mod.summary,
      durationSeconds: durations.length ? durations.reduce((a, b) => a + b, 0) : null,
      lessons: lessons.map((lesson, lessonIndex) => ({
        id: lesson._id,
        title: lesson.title,
        href: lessonHref(lesson.slug),
        position: `${moduleIndex + 1}.${lessonIndex + 1}`,
        durationSeconds: lesson.durationSeconds,
        freePreview: Boolean(lesson.freePreview),
        completed: progress.completedIds.has(lesson._id),
      })),
    };
  });

  return (
    <div className="bg-hatch flex flex-1 flex-col">
      <div className="mx-auto flex w-full max-w-[1200px] flex-1 flex-col border-x border-neutral-200 bg-canvas">
        <SiteHeader />

        <main className="flex flex-col px-6 pt-9 md:px-12">
          <Breadcrumbs items={[{ label: "All Courses", href: "/courses" }, { label: course.title }]} />

          <div className="mt-10">
            <CourseHero course={course} ctaHref={ctaHref} ctaLabel={ctaLabel} />
          </div>

          <div className="mt-12">
            <LearningOutcomes outcomes={course.learningOutcomes ?? []} />
          </div>

          <div className="mt-12">
            <CourseCurriculum
              modules={modules}
              totalModules={course.moduleCount ?? modules.length}
              totalDurationSeconds={course.durationSeconds}
            />
          </div>
        </main>

        {userId ? (
          <div className="mt-12">
            <CourseProgressBar percent={progress.percent} ctaHref={ctaHref} ctaLabel={ctaLabel} />
          </div>
        ) : (
          <div className="mt-12" />
        )}

        <Skyline className="h-[140px] pt-0" />
      </div>
    </div>
  );
}

