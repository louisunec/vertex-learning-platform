import { Icon } from "@/components/ui";
import { cn } from "@/lib/cn";
import { LEGEND_ORDER, STATE_UI } from "./states";

/**
 * `proposed`: the map shows AI-proposed edges (display only), so the two line
 * styles are explained; `proposedUnavailable`: they could not be read.
 */
export function MapLegend({ proposed = false, proposedUnavailable = false }: { proposed?: boolean; proposedUnavailable?: boolean }) {
  return (
    <div className="mt-6 border-t border-neutral-200 pt-6">
      {proposed ? (
        <ul className="flex flex-wrap gap-x-6 gap-y-2 text-small text-neutral-500" aria-label="Arrows">
          <li className="flex items-center gap-2">
            <LineSample className="text-neutral-500" />
            Prerequisite, reviewed by the course team
          </li>
          <li className="flex items-center gap-2">
            <LineSample className="text-lesson" dashed />
            <span>
              <span className="text-lesson">AI-proposed relationships</span> · not reviewed, not used for recommendations
            </span>
          </li>
        </ul>
      ) : (
        <p className="flex items-center gap-2 text-small text-neutral-500">
          <Icon name="arrow-right" size={14} />
          Arrows show prerequisites
        </p>
      )}
      {proposedUnavailable && (
        <p className="mt-2 text-small text-neutral-500">AI-proposed relationships couldn’t be loaded. Refresh to try again.</p>
      )}
      <ul className="mt-4 grid grid-cols-2 gap-x-6 gap-y-4 md:grid-cols-4">
        {LEGEND_ORDER.map((state) => {
          const ui = STATE_UI[state];
          return (
            <li key={state} className="flex gap-3">
              <span aria-hidden="true" className={cn("mt-1.5 size-2.5 shrink-0 rounded-full", ui.dot)} />
              <span>
                <span className="block text-body text-neutral-900">{ui.label}</span>
                <span className="block text-small text-neutral-500">{ui.description}</span>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function LineSample({ className, dashed = false }: { className: string; dashed?: boolean }) {
  return (
    <svg aria-hidden="true" width="28" height="10" viewBox="0 0 28 10" className={cn("shrink-0", className)}>
      <path d="M1 5h20" stroke="currentColor" strokeWidth={1.5} strokeDasharray={dashed ? "4 3" : undefined} />
      <path d="M21 1.5 27 5l-6 3.5Z" fill="currentColor" />
    </svg>
  );
}
