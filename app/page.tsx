import Link from "next/link";
import { Button, CourseCard, Icon } from "@/components/ui";
import { SiteHeader } from "@/components/home/site-header";
import { DockerLogo, NextjsLogo, TypeScriptLogo } from "@/components/home/course-logos";

/* ------------------------------------------------------------------ */
/*  Presentational sample content (matches design/vertex-home.png)     */
/* ------------------------------------------------------------------ */

const courses = [
  {
    title: "Next.js for Production",
    description: "Build scalable, high-performance web applications with Next.js.",
    icon: <NextjsLogo />,
    level: "Intermediate",
    duration: "18h 24m",
    modules: "12 modules",
  },
  {
    title: "Docker Essentials",
    description: "Containerize applications and streamline your development workflow.",
    icon: <DockerLogo />,
    level: "Beginner",
    duration: "10h 12m",
    modules: "8 modules",
  },
  {
    title: "TypeScript Deep Dive",
    description: "Go beyond the basics and write safer, more expressive code.",
    icon: <TypeScriptLogo />,
    level: "Intermediate",
    duration: "14h 36m",
    modules: "10 modules",
  },
];

/** Soft orange "skyline" bars along the bottom edge: [left %, width %, height %]. */
const skyline: Array<[number, number, number]> = [
  [0, 5, 46],
  [5, 4, 30],
  [9, 5, 68],
  [14, 4, 52],
  [18, 5, 100],
  [23, 4, 84],
  [27, 5, 62],
  [32, 4, 40],
  [36, 4, 26],
  [58, 4, 30],
  [62, 5, 50],
  [67, 4, 74],
  [71, 5, 100],
  [76, 4, 60],
  [80, 5, 88],
  [85, 4, 44],
  [89, 5, 72],
  [94, 6, 56],
];

/* ------------------------------------------------------------------ */
/*  Page                                                               */
/* ------------------------------------------------------------------ */

export default function HomePage() {
  return (
    <div className="bg-hatch flex flex-1 flex-col">
      <div className="mx-auto flex w-full max-w-[1200px] flex-1 flex-col border-x border-neutral-200 bg-canvas">
        <SiteHeader />

        <main className="flex flex-col">
          {/* Hero */}
          <section className="border-b border-neutral-200 px-6 pt-16 pb-14 md:px-12 md:pt-20">
            <div className="mx-auto flex max-w-[860px] flex-col items-center text-center">
              <span className="inline-flex h-9 items-center rounded-sm border border-primary-200/70 bg-primary-100 px-4 text-[12px] font-medium tracking-[0.18em] text-primary-500 uppercase">
                Intelligent Learning
              </span>
              <h1 className="mt-8 font-display text-[44px] leading-[1.12] font-normal tracking-[-0.015em] text-balance text-neutral-900 md:text-[64px]">
                Search your learning in&nbsp;plain English.
              </h1>
              <p className="mt-6 max-w-[520px] text-[17px] leading-8 text-neutral-500 md:text-[19px]">
                Vertex understands what you want to learn and finds the exact lessons across all your courses.
              </p>
              <Button
                href="/courses"
                className="mt-10 h-[60px] px-6 text-[17px] shadow-sm"
                iconRight={<Icon name="arrow-right" size={20} />}
              >
                Explore Courses
              </Button>
            </div>

            {/* Hero search — presentational */}
            <form
              role="search"
              action="/search"
              className="mx-auto mt-11 flex h-16 w-full max-w-[880px] items-center gap-3 rounded-lg border border-neutral-200 bg-white pr-5 pl-5 shadow-sm transition-colors focus-within:border-primary-400 sm:h-20 sm:gap-4 sm:pl-7"
            >
              <Icon name="search" size={26} className="shrink-0 text-neutral-900" />
              <input
                type="search"
                name="q"
                aria-label="Ask anything about your learning"
                placeholder="Ask anything about your learning..."
                className="h-full min-w-0 flex-1 bg-transparent text-[17px] text-neutral-900 outline-none placeholder:text-neutral-500 sm:text-[19px]"
              />
              <kbd className="hidden h-11 shrink-0 items-center rounded-sm border border-neutral-200 px-3 font-sans text-[16px] text-neutral-900 sm:inline-flex">
                ⌘ K
              </kbd>
            </form>
          </section>

          {/* Catalog */}
          <section className="px-6 pt-14 md:px-12" aria-labelledby="all-courses">
            <div className="flex items-center justify-between gap-4">
              <h2 id="all-courses" className="font-display text-[28px] leading-9 font-normal text-neutral-900">
                All Courses
              </h2>
              <Link
                href="/courses"
                className="inline-flex items-center gap-2 text-body-lg text-primary-500 transition-colors hover:text-primary-600"
              >
                View all courses
                <Icon name="arrow-right" size={18} />
              </Link>
            </div>

            <ul className="mt-8 grid gap-5 lg:grid-cols-3">
              {courses.map((course) => (
                <li key={course.title} className="flex">
                  <CourseCard layout="stacked" className="w-full" {...course} />
                </li>
              ))}
            </ul>

            <p className="mt-14 flex items-center gap-6 text-body-lg text-neutral-700">
              <span aria-hidden="true" className="h-px flex-1 bg-neutral-200" />
              <span className="inline-flex items-center gap-4">
                <Icon name="star" size={24} className="text-primary-400" />
                New courses and lessons added every week.
              </span>
              <span aria-hidden="true" className="h-px flex-1 bg-neutral-200" />
            </p>
          </section>
        </main>

        {/* Decorative skyline — pinned to the bottom of the frame */}
        <div aria-hidden="true" className="relative mt-auto h-[210px] overflow-hidden pt-6">
          {skyline.map(([left, width, height], i) => (
            <span
              key={i}
              className="absolute bottom-0 bg-gradient-to-t from-primary-300/70 via-primary-200/45 to-primary-100/0 blur-[3px]"
              style={{ left: `${left}%`, width: `${width}%`, height: `${height}%` }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
