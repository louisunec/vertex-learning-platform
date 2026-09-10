import type { Metadata } from "next";
import { after } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { SiteHeader } from "@/components/home/site-header";
import { Skyline } from "@/components/home/skyline";
import { CourseCatalogCard } from "@/components/course/course-catalog-card";
import { getPostHogClient } from "@/lib/posthog-server";
import { getCourses } from "@/sanity/data";

export const metadata: Metadata = {
  title: "All Courses",
  description: "Browse every course on Vertex.",
};

export default async function CoursesPage() {
  const [courses, { userId }] = await Promise.all([getCourses(), auth()]);

  // Track catalog page view server-side
  after(async () => {
    try {
      const posthog = getPostHogClient();
      posthog.capture({
        distinctId: userId ?? "anonymous",
        event: "course_catalog_viewed",
        properties: { course_count: courses.length },
      });
      await posthog.flush();
    } catch (error) {
      console.error("[analytics] course_catalog_viewed capture failed:", error);
    }
  });

  return (
    <div className="bg-hatch flex flex-1 flex-col">
      <div className="mx-auto flex w-full max-w-[1200px] flex-1 flex-col border-x border-neutral-200 bg-canvas">
        <SiteHeader />

        <main className="flex flex-col px-6 pt-14 md:px-12" aria-labelledby="all-courses">
          <h1 id="all-courses" className="font-display text-[28px] leading-9 font-normal text-neutral-900">
            All Courses
          </h1>

          {courses.length > 0 ? (
            <ul className="mt-8 grid gap-5 md:grid-cols-2 lg:grid-cols-3">
              {courses.map((course) => (
                <li key={course._id} className="flex">
                  <CourseCatalogCard course={course} className="w-full" />
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-8 text-body-lg text-neutral-500">No courses published yet.</p>
          )}
        </main>

        <div className="mt-14" />
        <Skyline />
      </div>
    </div>
  );
}
