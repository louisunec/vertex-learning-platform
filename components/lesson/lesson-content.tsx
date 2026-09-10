import { Icon, ResourceCard } from "@/components/ui";
import { formatLevel } from "@/lib/format";
import type { BlockContent } from "@/sanity.types";
import { LessonNotes } from "./lesson-notes";

export interface LessonResource {
  _key: string;
  type: string;
  title: string;
  description: string | null;
  url: string;
}

export interface LessonContentProps {
  notes: BlockContent | null;
  keyPoints: string[];
  proTip: string | null;
  resources: LessonResource[];
}

/** "Lesson Content" tab: overview (stored notes), key points, pro tip, resources. */
export function LessonContent({ notes, keyPoints, proTip, resources }: LessonContentProps) {
  return (
    <div className="flex flex-col gap-10">
      {notes && (
        <section aria-labelledby="lesson-overview">
          <h2 id="lesson-overview" className="font-display text-[24px] leading-8 font-normal text-neutral-900">
            Overview
          </h2>
          <LessonNotes value={notes} className="mt-4" />
        </section>
      )}

      {keyPoints.length > 0 && (
        <section aria-labelledby="lesson-key-points">
          <h3 id="lesson-key-points" className="text-body-lg font-semibold text-neutral-900">
            In this lesson you will:
          </h3>
          <ul className="mt-4 space-y-3">
            {keyPoints.map((point) => (
              <li key={point} className="flex items-start gap-3 text-[15px] leading-6 text-neutral-700">
                <Icon name="check-circle" size={20} className="mt-0.5 text-primary-500" />
                {point}
              </li>
            ))}
          </ul>
        </section>
      )}

      {proTip && (
        <aside aria-label="Pro tip" className="flex gap-4 rounded-lg bg-primary-100/60 p-6">
          <Icon name="bulb" size={24} className="mt-0.5 shrink-0 text-primary-500" />
          <div>
            <p className="text-body-lg font-semibold text-neutral-900">Pro Tip</p>
            <p className="mt-1.5 text-[15px] leading-7 text-neutral-700">{proTip}</p>
          </div>
        </aside>
      )}

      {resources.length > 0 && (
        <section aria-labelledby="lesson-resources">
          <h2 id="lesson-resources" className="font-display text-[24px] leading-8 font-normal text-neutral-900">
            Resources
          </h2>
          <div className="mt-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {resources.map((resource) => (
              <ResourceCard
                key={resource._key}
                title={resource.title}
                description={resource.description ?? ""}
                meta={[formatLevel(resource.type)]}
                href={resource.url}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
