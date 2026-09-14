"use client";

import { useId, useState, type KeyboardEvent } from "react";
import Link from "next/link";
import { Icon } from "@/components/ui";
import { cn } from "@/lib/cn";
import type { MapState } from "@/lib/knowledge-map";
import { STATE_UI } from "./states";

export type MapNodeView = {
  id: string;
  name: string;
  letter: string;
  state: MapState;
  x: number;
  y: number;
  href: string;
  selected: boolean;
};

/** A cited moment behind an edge: "Lesson 2 · 03:15", the lesson title, and its deep link. */
export type EdgeSourceView = { label: string; title: string; href: string };

/**
 * An arrow from the `from` concept to the `to` concept (node ids): an
 * approved prerequisite, or an unreviewed AI proposal shown for display only.
 */
export type MapEdgeView = {
  id: string;
  from: string;
  to: string;
  path: string;
  kind: "approved" | "proposed";
  rationale: string | null;
  sources: EdgeSourceView[];
};

const EDGE_UI = {
  approved: { color: "text-neutral-500", dash: undefined, label: "Prerequisite" },
  proposed: { color: "text-lesson", dash: "6 4", label: "AI-proposed relationship · not reviewed" },
} as const;

const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5];

const DOT_GRID = {
  backgroundImage: "radial-gradient(circle, rgb(255 255 255 / 0.07) 1px, transparent 1px)",
  backgroundSize: "16px 16px",
};

/**
 * The concept graph for one course: server-laid-out nodes and prerequisite
 * arrows, with a client-side zoom. Selecting a node is a navigation, so the
 * evidence panel is rendered on the server. Selecting an arrow shows its
 * rationale and source moments below the map.
 */
export function ConceptMap({
  width,
  height,
  nodeWidth,
  nodeHeight,
  nodes,
  edges,
}: {
  width: number;
  height: number;
  nodeWidth: number;
  nodeHeight: number;
  nodes: MapNodeView[];
  edges: MapEdgeView[];
}) {
  const [step, setStep] = useState(ZOOM_STEPS.indexOf(1));
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const zoom = ZOOM_STEPS[step];
  const idPrefix = useId().replace(/:/g, "");
  const markerId = (kind: MapEdgeView["kind"]) => `${idPrefix}-arrow-${kind}`;

  // Each node also describes its prerequisites in text, approved and proposed apart.
  const names = new Map(nodes.map((node) => [node.id, node.name]));
  const prerequisites = new Map<string, { approved: string[]; proposed: string[] }>();
  for (const edge of edges) {
    const name = names.get(edge.from);
    if (!name) continue;
    const entry = prerequisites.get(edge.to) ?? { approved: [], proposed: [] };
    entry[edge.kind].push(name);
    prerequisites.set(edge.to, entry);
  }
  const selectedEdge = edges.find((edge) => edge.id === selectedEdgeId) ?? null;
  const toggleEdge = (id: string) => setSelectedEdgeId((current) => (current === id ? null : id));
  const onEdgeKey = (id: string) => (event: KeyboardEvent<SVGPathElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      toggleEdge(id);
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between gap-4">
        <h2 id="concept-map" className="text-h3 text-neutral-900">
          Concept map
        </h2>
        <div className="flex items-center gap-2 text-small text-neutral-700" role="group" aria-label="Zoom">
          <ZoomButton label="Zoom out" disabled={step === 0} onClick={() => setStep(step - 1)}>
            −
          </ZoomButton>
          <span className="w-10 text-center tabular-nums" aria-live="polite">
            {Math.round(zoom * 100)}%
          </span>
          <ZoomButton label="Zoom in" disabled={step === ZOOM_STEPS.length - 1} onClick={() => setStep(step + 1)}>
            +
          </ZoomButton>
        </div>
      </div>

      <div className="mt-4 overflow-auto rounded-md" style={DOT_GRID}>
        <div className="relative" style={{ width: width * zoom, height: height * zoom }}>
          <div className="absolute top-0 left-0 origin-top-left" style={{ width, height, transform: `scale(${zoom})` }}>
            <svg width={width} height={height} className="absolute inset-0" role="group" aria-label="Relationships">
              <defs aria-hidden="true">
                {(["approved", "proposed"] as const).map((kind) => (
                  <marker
                    key={kind}
                    id={markerId(kind)}
                    className={EDGE_UI[kind].color}
                    viewBox="0 0 10 10"
                    refX="1"
                    refY="5"
                    markerUnits="userSpaceOnUse"
                    markerWidth="7"
                    markerHeight="7"
                    orient="auto"
                  >
                    <path d="M0 0 10 5 0 10Z" fill="currentColor" />
                  </marker>
                ))}
              </defs>
              {edges.map((edge) => {
                const ui = EDGE_UI[edge.kind];
                const selected = edge.id === selectedEdgeId;
                return (
                  <g key={edge.id} className={ui.color}>
                    <path
                      aria-hidden="true"
                      d={edge.path}
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={selected ? 2.25 : 1.25}
                      strokeDasharray={ui.dash}
                      markerEnd={`url(#${markerId(edge.kind)})`}
                      className="pointer-events-none"
                    />
                    {/* A wide transparent twin makes the thin line easy to click. */}
                    <path
                      d={edge.path}
                      fill="none"
                      stroke="currentColor"
                      strokeOpacity={0}
                      strokeWidth={14}
                      role="button"
                      tabIndex={0}
                      aria-pressed={selected}
                      aria-label={`${names.get(edge.from) ?? "?"} to ${names.get(edge.to) ?? "?"}: ${ui.label}`}
                      onClick={() => toggleEdge(edge.id)}
                      onKeyDown={onEdgeKey(edge.id)}
                      className="cursor-pointer outline-none hover:[stroke-opacity:0.15] focus-visible:[stroke-opacity:0.3]"
                      style={{ pointerEvents: "stroke" }}
                    />
                  </g>
                );
              })}
            </svg>

            <ul aria-labelledby="concept-map">
              {nodes.map((node, index) => {
                const ui = STATE_UI[node.state];
                const nodePrerequisites = prerequisites.get(node.id);
                const descriptionId = `${idPrefix}-prerequisites-${index}`;
                return (
                  <li key={node.id} className="absolute" style={{ left: node.x, top: node.y, width: nodeWidth, height: nodeHeight }}>
                    <Link
                      href={node.href}
                      scroll={false}
                      aria-current={node.selected ? "true" : undefined}
                      aria-label={`${node.name}: ${ui.label}`}
                      aria-describedby={nodePrerequisites ? descriptionId : undefined}
                      className={cn(
                        "flex size-full items-center gap-3 rounded-sm border px-3 transition-colors",
                        "focus-visible:ring-2 focus-visible:ring-primary-400 focus-visible:outline-none",
                        ui.border,
                        node.selected ? ui.fill : "bg-canvas hover:bg-neutral-100",
                      )}
                    >
                      <span
                        aria-hidden="true"
                        className={cn("flex size-7 shrink-0 items-center justify-center rounded-xs text-small font-semibold", ui.tile)}
                      >
                        {node.letter}
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate text-body font-medium text-neutral-900">{node.name}</span>
                        <span className={cn("block truncate text-small", ui.text)}>{ui.label}</span>
                      </span>
                    </Link>
                    {nodePrerequisites && (
                      <span id={descriptionId} className="sr-only">
                        {nodePrerequisites.approved.length > 0 && `Prerequisites: ${nodePrerequisites.approved.join(", ")}. `}
                        {nodePrerequisites.proposed.length > 0 &&
                          `AI-proposed prerequisites, not reviewed: ${nodePrerequisites.proposed.join(", ")}.`}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      </div>

      {selectedEdge ? (
        <EdgeDetails
          edge={selectedEdge}
          from={names.get(selectedEdge.from) ?? "?"}
          to={names.get(selectedEdge.to) ?? "?"}
          onClose={() => setSelectedEdgeId(null)}
        />
      ) : (
        edges.length > 0 && <p className="mt-3 text-small text-neutral-500">Select an arrow to see why it’s there.</p>
      )}
    </div>
  );
}

/** The selected arrow's rationale and source moments; proposals say they are unreviewed and unused. */
function EdgeDetails({ edge, from, to, onClose }: { edge: MapEdgeView; from: string; to: string; onClose: () => void }) {
  const titleId = `${useId().replace(/:/g, "")}-edge`;
  const proposed = edge.kind === "proposed";
  return (
    <section
      aria-labelledby={titleId}
      aria-live="polite"
      className={cn("mt-4 rounded-md border p-4", proposed ? "border-dashed border-lesson/50" : "border-neutral-200")}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className={cn("text-small font-medium", EDGE_UI[edge.kind].color)}>{EDGE_UI[edge.kind].label}</p>
          <h3 id={titleId} className="mt-1 text-body-lg font-medium break-words text-neutral-900">
            {from} → {to}
          </h3>
        </div>
        <button
          type="button"
          aria-label="Close relationship details"
          onClick={onClose}
          className="flex size-8 shrink-0 items-center justify-center rounded-sm text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-900"
        >
          <Icon name="x" size={16} />
        </button>
      </div>
      <p className="mt-3 text-body text-neutral-700">{edge.rationale ?? "No rationale was recorded for this relationship."}</p>
      {edge.sources.length > 0 && (
        <div className="mt-4">
          <p className="text-small text-neutral-500">Source moments</p>
          <ul className="mt-2 flex flex-col gap-2">
            {edge.sources.map((source) => (
              <li key={source.href} className="flex flex-wrap items-baseline gap-x-2">
                <Link href={source.href} className="text-body font-medium text-primary-500 hover:text-primary-600">
                  {source.label}
                </Link>
                <span className="min-w-0 text-small text-neutral-500">{source.title}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {proposed && (
        <p className="mt-4 text-small text-neutral-500">
          Suggested by AI from lesson evidence. It isn’t used for your recommendations or progress unless the course team
          approves it.
        </p>
      )}
    </section>
  );
}

function ZoomButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="flex size-8 items-center justify-center rounded-sm border border-neutral-200 text-body-lg text-neutral-900 transition-colors hover:bg-neutral-100 disabled:text-neutral-300 disabled:hover:bg-transparent"
    >
      {children}
    </button>
  );
}
