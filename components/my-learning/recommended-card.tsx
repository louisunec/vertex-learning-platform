import Link from "next/link";
import { Button, Card, Icon } from "@/components/ui";
import { KindBadge, kindIcon, PlanMeta } from "@/components/learn/plan-parts";
import type { PlanItemResponse } from "@/lib/learner/next-action-contracts";
import { IconTile } from "./card-parts";

/**
 * The overview's single primary action when next actions are on: the first
 * item of the learner's plan, with its evidence-based reason. A started
 * lesson elsewhere stays one click away as a secondary action.
 */
export function RecommendedCard({
  item,
  continueLesson,
}: {
  item: PlanItemResponse;
  /** The existing "Continue learning" lesson, offered when it isn't already the recommendation. */
  continueLesson: { title: string; href: string } | null;
}) {
  return (
    <Card className="flex min-w-0 flex-col p-6 md:p-8" role="region" aria-labelledby="recommended-next">
      <div className="flex items-center justify-between gap-4">
        <h2 id="recommended-next" className="text-small font-medium tracking-[0.14em] text-neutral-500 uppercase">
          Recommended next
        </h2>
        <Link
          href="/learn"
          className="inline-flex shrink-0 items-center gap-1.5 text-body font-medium text-primary-500 hover:text-primary-600"
        >
          See your plan
          <Icon name="arrow-right" size={14} />
        </Link>
      </div>
      <div className="mt-5 flex items-start gap-5">
        <IconTile icon={kindIcon(item)} tone="primary" size="lg" />
        <div className="min-w-0">
          <KindBadge item={item} />
          <h3 className="mt-2 text-[24px] leading-8 font-semibold text-neutral-900">{item.title}</h3>
          <p className="mt-1 text-[15px] leading-[21px] text-neutral-500">{item.reason}</p>
        </div>
      </div>
      <PlanMeta item={item} className="mt-5" />
      <div className="mt-6 flex flex-wrap gap-3">
        <Button href={item.href} iconRight={<Icon name="arrow-right" size={18} />}>
          {item.actionLabel}
        </Button>
        {continueLesson && (
          <Button href={continueLesson.href} variant="secondary" aria-label={`Continue ${continueLesson.title} instead`}>
            Continue lesson instead
          </Button>
        )}
      </div>
    </Card>
  );
}
