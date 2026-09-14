"use client";

import { useId, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Button, Select } from "@/components/ui";

export type GoalCourseOption = { id: string; title: string };

const ERRORS: Record<string, string> = {
  unauthenticated: "Sign in again to save your goal.",
  not_found: "That course isn’t available any more. Choose another one.",
  unavailable: "Your goal couldn’t be saved just now. Try again.",
};

/**
 * Chooses the learner's goal course. Only this explicit choice saves a goal
 * (`POST /api/goal`, which resolves the learner on the server); the page is
 * then re-rendered on the server with the new plan.
 */
export function GoalPicker({
  courses,
  currentCourseId,
  submitLabel,
}: {
  courses: GoalCourseOption[];
  currentCourseId: string | null;
  submitLabel: string;
}) {
  const router = useRouter();
  const id = useId();
  const [courseId, setCourseId] = useState(currentCourseId ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!courseId || saving) return;
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/goal", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ courseId }),
      });
      if (response.ok) {
        router.refresh();
      } else {
        const body = (await response.json().catch(() => null)) as { code?: string } | null;
        setError(ERRORS[body?.code ?? ""] ?? "Your goal couldn’t be saved. Try again.");
      }
    } catch {
      setError("Your goal couldn’t be saved. Check your connection and try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={save} className="flex flex-col gap-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <label htmlFor={id} className="sr-only">
          Goal course
        </label>
        <Select
          id={id}
          value={courseId}
          onChange={(event) => setCourseId(event.target.value)}
          options={[{ value: "", label: "Choose a course" }, ...courses.map((course) => ({ value: course.id, label: course.title }))]}
          className="min-w-0 flex-1"
        />
        <Button type="submit" size="md" disabled={!courseId || courseId === currentCourseId || saving}>
          {saving ? "Saving…" : submitLabel}
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-small text-neutral-700">
          {error}
        </p>
      )}
    </form>
  );
}
