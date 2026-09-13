import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { Button, Card, Icon } from "@/components/ui";
import { SiteHeader } from "@/components/home/site-header";
import { LoadError } from "@/components/my-learning/card-parts";
import { ConceptMap, type MapNodeView } from "@/components/my-learning/knowledge-map/concept-map";
import { CourseSelect } from "@/components/my-learning/knowledge-map/course-select";
import { EvidencePanel, type AttemptView } from "@/components/my-learning/knowledge-map/evidence-panel";
import { MapLegend } from "@/components/my-learning/knowledge-map/map-legend";
import { monogram } from "@/components/my-learning/knowledge-map/states";
import { LearningTabs } from "@/components/my-learning/learning-tabs";
import { SignedOut } from "@/components/my-learning/signed-out";
import { getDb } from "@/lib/db/client";
import { isKnowledgeMapEnabled, isReviewEnabled } from "@/lib/flags";
import { formatClock, formatRelativeTime } from "@/lib/format";
import {
  ATTEMPT_BADGES,
  ATTEMPT_LABELS,
  MAP_LAYOUT,
  attemptReason,
  countedAttempts,
  drawableEdges,
  evidenceIdsFor,
  evidenceSummary,
  firstSource,
  layoutMap,
  mapState,
  numberedLessons,
  orderConcepts,
  pickSelected,
  resolveEvidence,
  type AttemptFeedbackItem,
  type ConceptSource,
} from "@/lib/knowledge-map";
import { sanityLearnerContent } from "@/lib/learner/content";
import { EMPTY_COUNTS } from "@/lib/learner/evidence";
import { readConceptAttempts, readMapEvidence } from "@/lib/learner/knowledge-map";
import { pickActiveCourse } from "@/lib/my-learning";
import {
  getAttemptFeedback,
  getCoursesContainingLessons,
  getKnowledgeMapConcepts,
  getKnowledgeMapEdges,
  getProgressForUser,
} from "@/sanity/data";

export const metadata: Metadata = {
  title: "Knowledge map",
  description: "See what to practise next on Vertex, and why.",
};

type Props = {
  searchParams: Promise<{ course?: string | string[]; concept?: string | string[] }>;
};

/** Selectors only: each must also match a set the server derives for this learner. */
const COURSE_SLUG = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const CONCEPT_ID = /^cpt-[a-z0-9]+(?:-[a-z0-9]+)*$/;

function param(value: string | string[] | undefined, pattern: RegExp): string | null {
  return typeof value === "string" && pattern.test(value) ? value : null;
}

export default async function KnowledgeMapPage({ searchParams }: Props) {
  const [{ userId }, sp] = await Promise.all([auth(), searchParams]);
  const [mapEnabled, reviews] = userId
    ? await Promise.all([isKnowledgeMapEnabled(userId), isReviewEnabled(userId)])
    : [true, false];
  if (!mapEnabled) notFound();

  return (
    <div className="bg-hatch flex flex-1 flex-col">
      <div className="mx-auto flex w-full max-w-[1200px] flex-1 flex-col border-x border-neutral-200 bg-canvas">
        <SiteHeader activeHref="/my-learning" returnTo="/my-learning/knowledge-map" />
        <LearningTabs active="knowledge-map" knowledgeMap reviews={reviews} />

        <main className="flex flex-col px-6 pt-10 pb-16 md:px-12" aria-labelledby="knowledge-map">
          <Link
            href="/my-learning"
            className="inline-flex w-fit items-center gap-2 text-body text-neutral-500 hover:text-neutral-900"
          >
            <Icon name="arrow-left" size={16} />
            Back to My Learning
          </Link>
          {userId ? (
            <KnowledgeMap userId={userId} course={param(sp.course, COURSE_SLUG)} concept={param(sp.concept, CONCEPT_ID)} />
          ) : (
            <>
              <Heading />
              <SignedOut message="Sign in to see your knowledge map." returnTo="/my-learning/knowledge-map" />
            </>
          )}
        </main>
      </div>
    </div>
  );
}

function Heading({ children }: { children?: ReactNode }) {
  return (
    <div className="mt-10 flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h1 id="knowledge-map" className="font-display text-display-1 text-neutral-900">
          Knowledge map
        </h1>
        <p className="mt-3 text-[20px] leading-7 text-neutral-500">See what to practise next — and why.</p>
      </div>
      {children}
    </div>
  );
}

/** Everything below is keyed by the server-resolved Clerk user id. */
async function KnowledgeMap({ userId, course: requestedCourse, concept: requestedConcept }: { userId: string; course: string | null; concept: string | null }) {
  if (!process.env.DATABASE_URL?.trim()) {
    console.error("[knowledge-map] enabled but DATABASE_URL is not set");
    return <Failure message="Learning evidence isn’t available on this server, so the knowledge map can’t be shown." />;
  }

  const progress = await attempt("progress", getProgressForUser(userId));
  if (!progress.ok) return <Failure />;
  const progressLessonIds = [...new Set(progress.value.map((row) => row.lessonId))];
  const courses = progressLessonIds.length > 0 ? await attempt("courses", getCoursesContainingLessons(progressLessonIds)) : null;
  if (courses && !courses.ok) return <Failure />;
  if (!courses || courses.value.length === 0) return <NoCourses />;

  const course =
    courses.value.find((candidate) => candidate.slug === requestedCourse) ??
    pickActiveCourse(courses.value, progress.value)?.course ??
    courses.value[0];
  const selector = <CourseSelect courses={courses.value.map(({ slug, title }) => ({ slug, title }))} value={course.slug} />;
  const lessons = numberedLessons(course);

  const [concepts, index] = await Promise.all([
    lessons.size > 0 ? attempt("concepts", getKnowledgeMapConcepts([...lessons.keys()])) : Promise.resolve({ ok: true as const, value: [] }),
    attempt("concept index", sanityLearnerContent.loadConceptIndex()),
  ]);
  if (!concepts.ok || !index.ok) return <Failure selector={selector} />;
  if (concepts.value.length === 0) {
    return (
      <>
        <Heading>{selector}</Heading>
        <Card className="mt-8 p-6">
          <p className="text-body-lg text-neutral-700">No reviewed concepts for {course.title} yet.</p>
          <p className="mt-2 text-body text-neutral-500">Concepts appear here once the course team has reviewed them.</p>
        </Card>
      </>
    );
  }

  const mapConcepts = concepts.value.map((concept) => ({
    ...concept,
    summary: concept.summary ?? "",
    sources: (concept.sources ?? []).filter(
      (source): source is ConceptSource => typeof source.lessonId === "string" && typeof source.startSeconds === "number",
    ),
  }));
  // Evidence is read for this map's concepts only, including concepts merged into them.
  const evidenceIds = [...new Set(mapConcepts.flatMap((concept) => evidenceIdsFor(concept, index.value)))];
  const [edgeRows, evidence] = await Promise.all([
    attempt("prerequisites", getKnowledgeMapEdges(mapConcepts.map((concept) => concept.id))),
    attempt("learner evidence", readMapEvidence(getDb(), userId, evidenceIds)),
  ]);
  if (!edgeRows.ok || !evidence.ok) return <Failure selector={selector} />;
  const { edges, dropped } = drawableEdges(mapConcepts, edgeRows.value);
  if (dropped.length > 0) console.warn("[knowledge-map] prerequisite edges failed validation and are not drawn:", dropped.join(", "));

  const now = new Date();
  const byConcept = resolveEvidence(evidence.value.mastery, evidence.value.latestIndependent, index.value);
  const ordered = orderConcepts(mapConcepts, lessons).map((concept) => {
    const summary = byConcept.get(concept.id);
    return {
      ...concept,
      counts: summary?.counts ?? EMPTY_COUNTS,
      state: mapState(summary?.counts ?? EMPTY_COUNTS, summary?.latestIndependent ?? null, now),
    };
  });
  const selected = pickSelected(ordered, requestedConcept)!;
  const layout = layoutMap(
    ordered.map((concept) => concept.id),
    edges,
  );
  const placed = new Map(layout.nodes.map((node) => [node.id, node]));
  const nodes: MapNodeView[] = ordered.map((concept) => ({
    id: concept.id,
    name: concept.name,
    letter: monogram(concept.name),
    state: concept.state,
    x: placed.get(concept.id)!.x,
    y: placed.get(concept.id)!.y,
    href: `/my-learning/knowledge-map?course=${encodeURIComponent(course.slug)}&concept=${concept.conceptId}`,
    selected: concept.id === selected.id,
  }));

  const attempts = await readAttempts(userId, evidenceIdsFor(selected, index.value), now);
  const source = firstSource(selected.sources, lessons);

  return (
    <>
      <Heading>{selector}</Heading>
      <div className="mt-8 grid gap-6 lg:grid-cols-[minmax(0,1fr)_368px]">
        <Card className="min-w-0 p-6" aria-labelledby="concept-map">
          <ConceptMap
            width={layout.width}
            height={layout.height}
            nodeWidth={MAP_LAYOUT.nodeWidth}
            nodeHeight={MAP_LAYOUT.nodeHeight}
            nodes={nodes}
            edges={layout.edges}
          />
          <MapLegend />
        </Card>
        <EvidencePanel
          name={selected.name}
          letter={monogram(selected.name)}
          summary={selected.summary}
          state={selected.state}
          evidenceSummary={evidenceSummary(countedAttempts(selected.counts), selected.state)}
          attempts={attempts}
          source={
            source && {
              lessonLabel: `Lesson ${source.lesson.number} · ${formatClock(Math.floor(source.startSeconds), { pad: true })}`,
              lessonTitle: source.lesson.title,
              href: source.href,
            }
          }
          courseHref={`/courses/${course.slug}`}
        />
      </div>
    </>
  );
}

/**
 * The selected concept's newest attempts, shown oldest first as in the
 * design, each with the reviewed reason for the option chosen. Only that one
 * string per attempt leaves the answer key; if the reasons can't be read,
 * the attempts are still shown without them.
 */
async function readAttempts(userId: string, conceptIds: string[], now: Date): Promise<AttemptView[] | null> {
  const rows = await attempt("concept attempts", readConceptAttempts(getDb(), userId, conceptIds));
  if (!rows.ok) return null;
  const assessmentIds = [...new Set(rows.value.map((row) => row.assessmentId))];
  const feedback = assessmentIds.length > 0 ? await attempt("attempt feedback", getAttemptFeedback(assessmentIds)) : null;
  const items = new Map<string, AttemptFeedbackItem>(feedback?.ok ? feedback.value.map((item) => [item.id, item]) : []);
  return rows.value.toReversed().map((row) => ({
    id: row.id,
    correct: row.correct,
    label: ATTEMPT_LABELS[row.evidenceReason],
    when: formatRelativeTime(row.createdAt, now),
    reason: attemptReason(row, items),
    badge: ATTEMPT_BADGES[row.evidenceKind],
  }));
}

type Attempted<T> = { ok: true; value: T } | { ok: false };

/** Settles a read; a failure is logged and reported as such, never as an empty result. */
async function attempt<T>(label: string, read: Promise<T>): Promise<Attempted<T>> {
  try {
    return { ok: true, value: await read };
  } catch (error) {
    console.error(`[knowledge-map] ${label} read failed:`, error instanceof Error ? error.message : error);
    return { ok: false };
  }
}

function Failure({ message, selector }: { message?: string; selector?: ReactNode }) {
  return (
    <>
      <Heading>{selector}</Heading>
      <LoadError>{message ?? "Your knowledge map couldn’t be loaded. Refresh to try again."}</LoadError>
    </>
  );
}

function NoCourses() {
  return (
    <>
      <Heading />
      <Card className="mt-8 flex flex-col items-start gap-4 p-6">
        <p className="text-body-lg text-neutral-700">Start a course to see its knowledge map.</p>
        <Button href="/courses" size="md">
          Browse courses
        </Button>
      </Card>
    </>
  );
}
