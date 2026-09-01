import Image from "next/image";
import { Badge, Button, Icon, type IconName } from "@/components/ui";
import { urlFor } from "@/sanity/lib/image";
import type { COURSE_BY_SLUG_QUERY_RESULT } from "@/sanity.types";
import { formatDuration, formatLevel, pluralize } from "@/lib/format";

type Course = NonNullable<COURSE_BY_SLUG_QUERY_RESULT>;

export interface CourseHeroProps {
  course: Course;
  /** Where the primary CTA goes; `null` when the course has no resolvable lessons. */
  ctaHref: string | null;
  ctaLabel: string;
}

const COVER_PX = 280;

/** Course header: cover tile, badge, title, summary, grounded meta row and CTAs. */
export function CourseHero({ course, ctaHref, ctaLabel }: CourseHeroProps) {
  const meta: Array<{ icon: IconName; label: string }> = [
    { icon: "chart", label: formatLevel(course.level) },
  ];
  if (course.durationSeconds) meta.push({ icon: "clock", label: formatDuration(course.durationSeconds) });
  if (course.moduleCount) meta.push({ icon: "folder", label: pluralize(course.moduleCount, "module") });
  if (course.studentCountDisplay) meta.push({ icon: "users", label: course.studentCountDisplay });

  const cover = course.coverImage?.asset ? course.coverImage : null;

  return (
    <section className="grid gap-10 md:grid-cols-[280px_1fr] md:gap-14">
      <div
        className="relative aspect-square w-full max-w-[280px] overflow-hidden rounded-[20px] bg-neutral-900 shadow-sm"
        style={{ maxWidth: COVER_PX }}
      >
        {cover && (
          <Image
            src={urlFor(cover).width(COVER_PX * 2).height(COVER_PX * 2).fit("crop").auto("format").url()}
            alt={cover.alt ?? ""}
            fill
            sizes={`${COVER_PX}px`}
            priority
            placeholder={cover.asset?.metadata?.lqip ? "blur" : "empty"}
            blurDataURL={cover.asset?.metadata?.lqip ?? undefined}
            className="object-cover"
          />
        )}
      </div>

      <div className="flex flex-col items-start">
        {course.popular && (
          <Badge variant="popular" className="h-7 rounded-xs bg-primary-100 px-3 text-[12px] tracking-[0.18em] text-primary-500">
            Popular
          </Badge>
        )}
        <h1 className="mt-5 font-display text-[40px] leading-[1.15] font-normal tracking-[-0.01em] text-balance text-neutral-900 md:text-[52px]">
          {course.title}
        </h1>
        {course.summary && (
          <p className="mt-5 max-w-[540px] text-[18px] leading-8 text-neutral-500 md:text-[19px]">{course.summary}</p>
        )}

        <ul className="mt-7 flex flex-wrap items-center gap-x-8 gap-y-3 text-body text-neutral-700">
          {meta.map((m) => (
            <li key={m.icon} className="inline-flex items-center gap-2.5">
              <Icon name={m.icon} size={18} className="text-neutral-500" />
              {m.label}
            </li>
          ))}
        </ul>

        <div className="mt-8 flex flex-wrap items-center gap-4">
          {ctaHref ? (
            <Button href={ctaHref} className="h-14 px-6 text-[17px] shadow-sm" iconRight={<Icon name="arrow-right" size={20} />}>
              {ctaLabel}
            </Button>
          ) : (
            <Button disabled className="h-14 px-6 text-[17px]" iconRight={<Icon name="arrow-right" size={20} />}>
              {ctaLabel}
            </Button>
          )}
          {/* Presentational: bookmarking has no backend yet. */}
          <Button variant="tertiary" className="h-14 px-6 text-[17px]" iconLeft={<Icon name="bookmark" size={20} />}>
            Bookmark
          </Button>
        </div>
      </div>
    </section>
  );
}
