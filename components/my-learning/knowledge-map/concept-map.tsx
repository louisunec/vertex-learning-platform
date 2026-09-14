"use client";

import { useId, useState } from "react";
import Link from "next/link";
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

/** A prerequisite arrow from the `from` concept to the `to` concept (node ids). */
export type MapEdgeView = { id: string; from: string; to: string; path: string };

const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5];

const DOT_GRID = {
  backgroundImage: "radial-gradient(circle, rgb(255 255 255 / 0.07) 1px, transparent 1px)",
  backgroundSize: "16px 16px",
};

/**
 * The concept graph for one course: server-laid-out nodes and prerequisite
 * arrows, with a client-side zoom. Selecting a node is a navigation, so the
 * evidence panel is rendered on the server.
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
  const zoom = ZOOM_STEPS[step];
  const idPrefix = useId().replace(/:/g, "");
  const markerId = `${idPrefix}-arrow`;

  // The arrows are drawn for sighted users only; each node also describes its prerequisites in text.
  const names = new Map(nodes.map((node) => [node.id, node.name]));
  const prerequisites = new Map<string, string[]>();
  for (const edge of edges) {
    const name = names.get(edge.from);
    if (name) prerequisites.set(edge.to, [...(prerequisites.get(edge.to) ?? []), name]);
  }

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
            <svg aria-hidden="true" width={width} height={height} className="absolute inset-0 text-neutral-500">
              <defs>
                <marker
                  id={markerId}
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
              </defs>
              {edges.map((edge) => (
                <path
                  key={edge.id}
                  d={edge.path}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.25}
                  markerEnd={`url(#${markerId})`}
                />
              ))}
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
                        Prerequisites: {nodePrerequisites.join(", ")}.
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      </div>
    </div>
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
