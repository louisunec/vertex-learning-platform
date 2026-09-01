import Link from "next/link";
import { Button, Icon } from "@/components/ui";
import { SiteHeader } from "@/components/home/site-header";
import { Skyline } from "@/components/home/skyline";
import { CourseCatalogCard } from "@/components/course/course-catalog-card";
import { getCourses } from "@/sanity/data";

/** The mock shows three catalog cards; "View all courses" leads to the full catalog. */
const HOME_COURSE_LIMIT = 3;

export default async function HomePage() {
  const courses = (await getCourses()).slice(0, HOME_COURSE_LIMIT);

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

          {/* Catalog — stored Sanity content, first N in catalog order */}
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

            {courses.length > 0 ? (
              <ul className="mt-8 grid gap-5 lg:grid-cols-3">
                {courses.map((course) => (
                  <li key={course._id} className="flex">
                    <CourseCatalogCard course={course} className="w-full" />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-8 text-body-lg text-neutral-500">No courses published yet.</p>
            )}

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

        <Skyline />
      </div>
    </div>
  );
}
