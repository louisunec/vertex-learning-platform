import { Button, Card, Icon } from "@/components/ui";
import type { PlanItemResponse } from "@/lib/learner/next-action-contracts";
import { KindBadge, PlanMeta } from "./plan-parts";

/** One step of the `/learn` plan: what to do, why, where it leads, and the action. */
export function PlanItemCard({ item, position }: { item: PlanItemResponse; position: number }) {
  const titleId = `plan-item-${position}`;
  return (
    <li>
      <Card className="flex flex-col gap-5 p-6 md:flex-row md:items-start" aria-labelledby={titleId}>
        <span
          aria-hidden="true"
          className="flex size-9 shrink-0 items-center justify-center rounded-full border border-neutral-200 text-body font-medium text-neutral-700"
        >
          {position}
        </span>
        <div className="min-w-0 flex-1">
          <KindBadge item={item} />
          <h2 id={titleId} className="mt-2 text-[20px] leading-7 font-semibold text-neutral-900">
            <span className="sr-only">Step {position}: </span>
            {item.title}
          </h2>
          <p className="mt-1 text-[15px] leading-[21px] text-neutral-500">{item.reason}</p>
          <PlanMeta item={item} className="mt-3" />
        </div>
        <Button
          href={item.href}
          size="md"
          variant={position === 1 ? "primary" : "secondary"}
          iconRight={<Icon name="arrow-right" size={16} />}
          className="self-start"
        >
          {item.actionLabel}
        </Button>
      </Card>
    </li>
  );
}
