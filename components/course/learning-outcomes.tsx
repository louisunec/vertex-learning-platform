import { Icon, iconNames, type IconName } from "@/components/ui";

export interface LearningOutcome {
  _key: string;
  icon: string | null;
  title: string;
  description: string | null;
}

function toIconName(name: string | null): IconName {
  return name && (iconNames as string[]).includes(name) ? (name as IconName) : "check-circle";
}

/** "What you'll learn" — the course's stored learning outcomes in a 2-column grid. */
export function LearningOutcomes({ outcomes }: { outcomes: LearningOutcome[] }) {
  if (outcomes.length === 0) return null;
  return (
    <section
      aria-labelledby="what-youll-learn"
      className="rounded-lg border border-neutral-200 bg-white/60 p-6 md:p-7"
    >
      <h2 id="what-youll-learn" className="font-display text-[26px] leading-9 font-normal text-neutral-900">
        What you&rsquo;ll learn
      </h2>
      <ul className="mt-6 grid gap-5 md:grid-cols-2">
        {outcomes.map((o) => (
          <li key={o._key} className="flex gap-6 rounded-lg border border-neutral-200 bg-white p-6 shadow-sm">
            <Icon name={toIconName(o.icon)} size={48} strokeWidth={1.5} className="mt-0.5 text-primary-500" />
            <div>
              <h3 className="font-display text-[20px] leading-7 font-normal text-neutral-900">{o.title}</h3>
              {o.description && <p className="mt-2 text-[15px] leading-6 text-neutral-500">{o.description}</p>}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
