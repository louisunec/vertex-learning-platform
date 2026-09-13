"use client";

import { useRouter } from "next/navigation";
import { Icon } from "@/components/ui";

/**
 * The course whose map is shown. A native select laid invisibly over the
 * designed control keeps keyboard and screen-reader behaviour; choosing a
 * course navigates, so the map is read on the server.
 */
export function CourseSelect({ courses, value }: { courses: Array<{ slug: string; title: string }>; value: string }) {
  const router = useRouter();
  const current = courses.find((course) => course.slug === value);

  return (
    <div className="relative flex h-16 w-full items-center gap-4 rounded-md border border-neutral-200 bg-surface px-5 focus-within:ring-2 focus-within:ring-primary-400 sm:w-[246px]">
      <Icon name="folder" size={22} className="shrink-0 text-neutral-900" />
      <span className="min-w-0 flex-1">
        <span className="block text-small text-neutral-500">Course</span>
        <span className="block truncate text-body font-medium text-neutral-900">{current?.title}</span>
      </span>
      <Icon name="chevron-down" size={16} className="shrink-0 text-neutral-700" />
      <select
        aria-label="Course"
        value={value}
        onChange={(event) =>
          router.push(`/my-learning/knowledge-map?course=${encodeURIComponent(event.target.value)}`, { scroll: false })
        }
        className="absolute inset-0 cursor-pointer appearance-none opacity-0"
      >
        {courses.map((course) => (
          <option key={course.slug} value={course.slug}>
            {course.title}
          </option>
        ))}
      </select>
    </div>
  );
}
