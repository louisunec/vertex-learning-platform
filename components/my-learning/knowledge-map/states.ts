import type { BadgeVariant } from "@/components/ui";
import type { MapState } from "@/lib/knowledge-map";

/** Labels and colours for each learner state, shared by the map, legend, and evidence panel. */
export const STATE_UI: Record<
  MapState,
  { label: string; description: string; dot: string; text: string; border: string; fill: string; tile: string; badge: BadgeVariant }
> = {
  not_assessed: {
    label: "Not assessed",
    description: "Not enough assessment evidence",
    dot: "bg-neutral-300",
    text: "text-neutral-500",
    border: "border-neutral-200",
    fill: "bg-neutral-200/30",
    tile: "bg-neutral-200/50 text-neutral-500",
    badge: "neutral",
  },
  developing: {
    label: "Developing",
    description: "Some correct understanding",
    dot: "bg-developing",
    text: "text-developing",
    border: "border-developing",
    fill: "bg-developing-bg",
    tile: "bg-developing-bg text-developing",
    badge: "developing",
  },
  needs_practice: {
    label: "Needs practice",
    description: "Focus on this next",
    dot: "bg-practice",
    text: "text-practice",
    border: "border-practice",
    fill: "bg-practice-bg",
    tile: "bg-practice-bg text-practice",
    badge: "practice",
  },
  recent_evidence: {
    label: "Recent evidence",
    description: "Recently demonstrated",
    dot: "bg-primary-500",
    text: "text-primary-500",
    border: "border-primary-500",
    fill: "bg-primary-100",
    tile: "bg-primary-100 text-primary-500",
    badge: "video",
  },
};

/** Legend order, as in the design. */
export const LEGEND_ORDER: MapState[] = ["not_assessed", "developing", "needs_practice", "recent_evidence"];

/** The node's monogram: the first letter or digit of its name. */
export function monogram(name: string): string {
  return (name.match(/[\p{L}\p{N}]/u)?.[0] ?? "?").toUpperCase();
}
