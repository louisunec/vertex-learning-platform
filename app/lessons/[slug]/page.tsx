import type { Metadata } from "next";
import Image from "next/image";
import { notFound } from "next/navigation";
import { after } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { Badge, Breadcrumbs, Icon, type IconName } from "@/components/ui";
import { SiteHeader } from "@/components/home/site-header";
import { LessonContent } from "@/components/lesson/lesson-content";
import { LessonFooterNav, type FooterLesson } from "@/components/lesson/lesson-footer-nav";
import { LessonNotes } from "@/components/lesson/lesson-notes";
import { LessonSidebar, type SidebarModule } from "@/components/lesson/lesson-sidebar";
import { LessonTabs } from "@/components/lesson/lesson-tabs";
import { VideoEmbed, type StartSource } from "@/components/lesson/video-embed";
import { summarizeCourseProgress } from "@/lib/course-progress";
import { formatDuration, formatLevel } from "@/lib/format";
import { getPostHogClient } from "@/lib/posthog-server";
import { getEmbedSource, toStartSeconds } from "@/lib/video/embed";
import { parseVideoUrl } from "@/lib/video/provider";
import { getLessonBySlug, getProgressForUser } from "@/sanity/data";
import { flattenLessons } from "@/sanity/lib/curriculum";
import { urlFor } from "@/sanity/lib/image";

type Props = {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ t?: string | string[] }>;
};

/** Builds the browser title from the stored lesson, with a not-found fallback. */
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const lesson = await getLessonBySlug(slug);
  if (!lesson) return { title: "Lesson not found" };
  return { title: lesson.title };
}

/** Renders a grounded lesson page with curriculum context and learner progress. */
export default async function LessonPage({ params, searchParams }: Props) {
  const [{ slug }, sp] = await Promise.all([params, searchParams]);
  const [lesson, { userId }] = await Promise.all([getLessonBySlug(slug), auth()]);
  if (!lesson) notFound();

  // Course/module context is derived through the reverse reference and may be
  // absent; the page degrades rather than fabricating a curriculum.
  const course = lesson.course;
  const context = lesson.context;

  // Learner state is read per request, keyed by the server-resolved Clerk user id.
  const progressRows = userId ? await getProgressForUser(userId) : null;
  const progress = course ? summarizeCourseProgress(course.modules, progressRows) : null;

  // Start position: explicit deep link (?t=seconds) wins over the stored resume position.
  const tParam = Array.isArray(sp.t) ? sp.t[0] : sp.t;
  const row = progressRows?.find((r) => r.lessonId === lesson._id) ?? null;
  const deepLinkSeconds = toStartSeconds(tParam);
  const resumeSeconds = row && !row.completed ? toStartSeconds(row.resumeSeconds) : null;
  const startSeconds = deepLinkSeconds ?? resumeSeconds;
  const startSource: StartSource =
    deepLinkSeconds !== null ? "deeplink" : resumeSeconds ? "resume" : "beginning";

  const parsed = parseVideoUrl(lesson.videoUrl);
  const embedSrc = parsed ? getEmbedSource(parsed, startSeconds) : null;
  const poster = lesson.poster?.asset ? lesson.poster : null;

  after(async () => {
    try {
      const posthog = getPostHogClient();
      posthog.capture({
        distinctId: userId ?? "anonymous",
        event: "lesson_viewed",
        properties: {
          lesson_title: lesson.title,
          lesson_slug: slug,
          lesson_position: context?.position ?? null,
          course_slug: course?.slug ?? null,
          start_seconds: startSeconds,
          start_source: startSource,
        },
      });
      if (startSource === "resume") {
        posthog.capture({
          distinctId: userId ?? "anonymous",
          event: "resume_used",
          properties: {
            lesson_slug: slug,
            course_slug: course?.slug ?? null,
            resume_seconds: startSeconds,
          },
        });
      }
      await posthog.flush();
    } catch (error) {
      console.error("[analytics] lesson_viewed capture failed:", error);
    }
  });

  const lessonHref = (lessonSlug: string) => `/lessons/${lessonSlug}`;
  const flat = course ? flattenLessons(course.modules) : [];
  const index = flat.findIndex((entry) => entry.lesson._id === lesson._id);
  const toFooter = (entry: (typeof flat)[number] | undefined): FooterLesson | null =>
    entry
      ? { href: lessonHref(entry.lesson.slug), title: entry.lesson.title, durationSeconds: entry.lesson.durationSeconds }
      : null;
  const prev = index > 0 ? toFooter(flat[index - 1]) : null;
  const next = index >= 0 ? toFooter(flat[index + 1]) : null;

  const sidebarModules: SidebarModule[] = (course?.modules ?? []).map((mod) => {
    const lessons = (mod.lessons ?? []).filter(Boolean);
    const durations = lessons.map((l) => l.durationSeconds).filter((d): d is number => typeof d === "number");
    return {
      key: mod._key,
      title: mod.title,
      durationSeconds: durations.length ? durations.reduce((a, b) => a + b, 0) : null,
      completed: lessons.length > 0 && lessons.every((l) => progress?.completedIds.has(l._id) ?? false),
      lessons: lessons.map((l) => ({
        id: l._id,
        title: l.title,
        href: lessonHref(l.slug),
        durationSeconds: l.durationSeconds,
        completed: progress?.completedIds.has(l._id) ?? false,
        current: l._id === lesson._id,
      })),
    };
  });

  const meta: Array<{ icon: IconName; label: string }> = [];
  if (lesson.durationSeconds) meta.push({ icon: "clock", label: formatDuration(lesson.durationSeconds) });
  if (course?.level) meta.push({ icon: "chart", label: formatLevel(course.level) });
  if (lesson.studentCountDisplay) meta.push({ icon: "users", label: lesson.studentCountDisplay });

  const crumbs = [
    { label: "All Courses", href: "/courses" },
    ...(course ? [{ label: course.title, href: `/courses/${course.slug}` }] : []),
    ...(context ? [{ label: context.module.title ?? "" }] : []),
    { label: lesson.title },
  ];

  return (
    <div className="bg-hatch flex flex-1 flex-col">
      <div className="mx-auto flex w-full max-w-[1200px] flex-1 flex-col border-x border-neutral-200 bg-canvas">
        <SiteHeader />

        <div className="flex flex-1 flex-col lg:flex-row">
          {course && (
            <aside className="order-2 shrink-0 border-t border-neutral-200 bg-surface lg:order-1 lg:w-[280px] lg:border-t-0 lg:border-r">
              <LessonSidebar
                courseTitle={course.title}
                courseHref={`/courses/${course.slug}`}
                coverImageUrl={
                  course.coverImage?.asset
                    ? urlFor(course.coverImage).width(96).height(96).fit("crop").auto("format").url()
                    : null
                }
                percent={userId && progress ? progress.percent : null}
                modules={sidebarModules}
                currentModuleNumber={context?.moduleNumber ?? null}
                currentModuleKey={context?.module._key ?? null}
              />
            </aside>
          )}

          <main className="order-1 min-w-0 flex-1 px-6 pt-9 pb-16 md:px-10 lg:order-2">
            <Breadcrumbs items={crumbs} />

            <div className="mt-8 flex items-start justify-between gap-6">
              <div>
                {context && <Badge variant="video">Lesson {context.position}</Badge>}
                <h1 className="mt-4 font-display text-[36px] leading-[1.2] font-normal tracking-[-0.01em] text-balance text-neutral-900 md:text-[44px]">
                  {lesson.title}
                </h1>
              </div>
              <button
                type="button"
                aria-label="Bookmark lesson"
                className="mt-1 inline-flex size-11 shrink-0 items-center justify-center rounded-md border border-neutral-200 bg-surface text-neutral-500 shadow-sm transition-colors hover:border-neutral-300 hover:text-primary-500 focus-visible:ring-2 focus-visible:ring-primary-400 focus-visible:outline-none"
              >
                <Icon name="bookmark" size={20} />
              </button>
            </div>

            {meta.length > 0 && (
              <ul className="mt-5 flex flex-wrap items-center gap-x-7 gap-y-3 text-body text-neutral-700">
                {meta.map((m) => (
                  <li key={m.icon} className="inline-flex items-center gap-2">
                    <Icon name={m.icon} size={17} className="text-neutral-500" />
                    {m.label}
                  </li>
                ))}
              </ul>
            )}

            <div className="mt-8">
              {parsed && embedSrc ? (
                <VideoEmbed
                  key={embedSrc}
                  src={embedSrc}
                  title={lesson.title}
                  tracking={{
                    provider: parsed.provider,
                    lessonSlug: slug,
                    courseSlug: course?.slug ?? null,
                    startSeconds,
                    startSource,
                  }}
                />
              ) : poster ? (
                <div className="relative aspect-video overflow-hidden rounded-[20px] bg-black shadow-sm">
                  <Image
                    src={urlFor(poster).width(1280).fit("max").auto("format").url()}
                    alt={poster.alt ?? ""}
                    fill
                    sizes="(min-width: 1024px) 860px, 100vw"
                    className="object-cover"
                  />
                </div>
              ) : null}
            </div>

            <div className="mt-10">
              <LessonTabs
                lessonTitle={lesson.title}
                lessonSlug={slug}
                content={
                  <LessonContent
                    notes={lesson.notes}
                    keyPoints={lesson.keyPoints ?? []}
                    proTip={lesson.proTip}
                    resources={(lesson.resources ?? []).map((r) => ({
                      _key: r._key,
                      type: r.type,
                      title: r.title,
                      description: r.description,
                      url: r.url,
                    }))}
                  />
                }
                notes={lesson.notes ? <LessonNotes value={lesson.notes} /> : null}
              />
            </div>
          </main>
        </div>

        <LessonFooterNav prev={prev} next={next} />
      </div>
    </div>
  );
}
