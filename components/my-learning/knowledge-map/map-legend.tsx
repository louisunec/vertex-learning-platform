import { Icon } from "@/components/ui";
import { cn } from "@/lib/cn";
import { LEGEND_ORDER, STATE_UI } from "./states";

export function MapLegend() {
  return (
    <div className="mt-6 border-t border-neutral-200 pt-6">
      <p className="flex items-center gap-2 text-small text-neutral-500">
        <Icon name="arrow-right" size={14} />
        Arrows show prerequisites
      </p>
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
