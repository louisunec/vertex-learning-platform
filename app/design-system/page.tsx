import type { Metadata } from "next";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import {
  Badge,
  Breadcrumbs,
  Button,
  CourseCard,
  Icon,
  Input,
  LessonCard,
  Logo,
  Navbar,
  Pagination,
  ProgressBar,
  ResourceCard,
  Select,
  Status,
  type IconName,
} from "@/components/ui";

export const metadata: Metadata = {
  title: "Design System",
  description:
    "A unified design language for the Vertex learning platform. Clean, modern and focused on clarity, consistency and intuitive learning experiences.",
};

/* ------------------------------------------------------------------ */
/*  Reference data                                                     */
/* ------------------------------------------------------------------ */

const primaryColors = [
  { name: "Primary 500", hex: "#31FBB8", cls: "bg-primary-500" },
  { name: "Primary 400", hex: "#31FBB8 · 60%", cls: "bg-primary-400" },
  { name: "Primary 300", hex: "#31FBB8 · 35%", cls: "bg-primary-300" },
  { name: "Primary 200", hex: "#31FBB8 · 18%", cls: "bg-primary-200" },
  { name: "Primary 100", hex: "#31FBB8 · 10%", cls: "bg-primary-100" },
];

const neutralColors = [
  { name: "Neutral 900", hex: "#EDEDED", cls: "bg-neutral-900" },
  { name: "Neutral 700", hex: "#CAD5E2", cls: "bg-neutral-700" },
  { name: "Neutral 500", hex: "#9EAABF", cls: "bg-neutral-500" },
  { name: "Neutral 300", hex: "#51555C", cls: "bg-neutral-300" },
  { name: "Neutral 200", hex: "#2E3238", cls: "bg-neutral-200" },
  { name: "Neutral 100", hex: "#16171B", cls: "bg-neutral-100" },
  { name: "Neutral 50", hex: "#101115", cls: "bg-neutral-50" },
  { name: "Canvas", hex: "#0D0E11", cls: "bg-canvas" },
];

const typeScale = [
  { style: "Display 1", font: "Geist", size: "48 / 56", weight: "Bold", use: "Page titles", cls: "font-display text-display-1" },
  { style: "Display 2", font: "Geist", size: "36 / 44", weight: "Bold", use: "Section titles", cls: "font-display text-display-2" },
  { style: "Heading 1", font: "Geist", size: "28 / 36", weight: "Semi Bold", use: "Card titles", cls: "text-h1" },
  { style: "Heading 2", font: "Geist", size: "22 / 30", weight: "Semi Bold", use: "Sub section", cls: "text-h2" },
  { style: "Heading 3", font: "Geist", size: "18 / 26", weight: "Medium", use: "Small titles", cls: "text-h3" },
  { style: "Body Large", font: "Geist", size: "16 / 24", weight: "Regular", use: "Body copy", cls: "text-body-lg" },
  { style: "Body", font: "Geist", size: "14 / 20", weight: "Regular", use: "Supporting text", cls: "text-body" },
  { style: "Small", font: "Geist", size: "12 / 16", weight: "Regular", use: "Captions, meta", cls: "text-small" },
];

const spacing = [4, 8, 12, 16, 24, 32, 40, 48, 64];

const radii = [
  { px: "4px", name: "xs", cls: "rounded-xs" },
  { px: "8px", name: "sm", cls: "rounded-sm" },
  { px: "12px", name: "md", cls: "rounded-md" },
  { px: "16px", name: "lg", cls: "rounded-lg" },
  { px: "24px", name: "xl", cls: "rounded-xl" },
  { px: "Full", name: "circle", cls: "rounded-full" },
];

const shadows = [
  { name: "Sm", value: "0 1px 2px 0", alpha: "rgba(0, 0, 0, 0.30)", cls: "shadow-sm" },
  { name: "Md", value: "0 4px 12px -2px", alpha: "rgba(0, 0, 0, 0.40)", cls: "shadow-md" },
  { name: "Lg", value: "0 12px 24px -4px", alpha: "rgba(0, 0, 0, 0.50)", cls: "shadow-lg" },
  { name: "Xl", value: "0 20px 40px -8px", alpha: "rgba(0, 0, 0, 0.60)", cls: "shadow-xl" },
];

const iconSet: IconName[] = ["bell", "search", "play", "file", "bookmark", "chart", "clock", "user", "chevron-right"];

const principles: Array<{ icon: IconName; title: string; body: string }> = [
  { icon: "eye", title: "Clarity First", body: "Every element should communicate clearly." },
  { icon: "grid", title: "Consistency", body: "Use components and patterns consistently across the platform." },
  { icon: "target", title: "Focus & Calm", body: "Remove noise and help learners focus on what matters." },
  { icon: "accessibility", title: "Accessible", body: "Design with accessibility and inclusivity in mind." },
];

/* ------------------------------------------------------------------ */
/*  Layout helpers                                                     */
/* ------------------------------------------------------------------ */

function Panel({ className, children }: { className?: string; children: ReactNode }) {
  return <section className={cn("rounded-lg border border-neutral-200 bg-surface/60 p-6", className)}>{children}</section>;
}

function SectionTitle({ n, children }: { n: string; children: ReactNode }) {
  return (
    <h2 className="mb-5 flex items-center gap-3 text-small font-semibold tracking-[0.14em] text-neutral-900 uppercase">
      <span className="text-primary-500">{n}</span>
      {children}
    </h2>
  );
}

function Label({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn("mb-3 text-body text-neutral-900", className)}>{children}</p>;
}

function Spec({ title, items }: { title: string; items: string[] }) {
  return (
    <div>
      <p className="mb-2 text-body font-medium text-neutral-900">{title}</p>
      <ul className="space-y-1 text-small text-neutral-700">
        {items.map((i) => (
          <li key={i} className="flex gap-2">
            <span aria-hidden="true" className="text-neutral-300">•</span>
            {i}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Swatch({ name, hex, cls }: { name: string; hex: string; cls: string }) {
  return (
    <div className="min-w-0">
      <div className={cn("mb-2 h-14 rounded-sm border border-neutral-200/70", cls)} />
      <p className="text-small text-neutral-900">{name}</p>
      <p className="text-small text-neutral-500">{hex}</p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Page                                                               */
/* ------------------------------------------------------------------ */

export default function DesignSystemPage() {
  return (
    <main className="mx-auto w-full max-w-7xl space-y-4 px-4 py-6 md:px-6">
      {/* Hero + 01 Colors */}
      <div className="grid gap-4 lg:grid-cols-[400px_1fr]">
        <Panel className="flex flex-col justify-between bg-surface">
          <div>
            <Logo size={32} />
            <h1 className="mt-8 font-display text-display-1 text-neutral-900">Design System</h1>
            <p className="mt-6 text-body-lg text-neutral-700">
              A unified design language for Vertex learning platform. Clean, modern and focused on clarity, consistency
              and intuitive learning experiences.
            </p>
          </div>
          <p className="mt-10 text-small tracking-[0.14em] text-neutral-500 uppercase">
            Version 2.0 <span className="mx-2">·</span> September 2026
          </p>
        </Panel>

        <Panel>
          <SectionTitle n="01">Colors</SectionTitle>
          <Label>Primary</Label>
          <div className="mb-8 grid grid-cols-5 gap-3">
            {primaryColors.map((c) => (
              <Swatch key={c.name} {...c} />
            ))}
          </div>
          <Label>Neutral</Label>
          <div className="grid grid-cols-4 gap-3 md:grid-cols-8">
            {neutralColors.map((c) => (
              <Swatch key={c.name} {...c} />
            ))}
          </div>
        </Panel>
      </div>

      {/* 02 Typography + 03 Type scale */}
      <div className="grid gap-4 lg:grid-cols-[400px_1fr]">
        <Panel>
          <SectionTitle n="02">Typography</SectionTitle>
          <div className="space-y-10 pt-2">
            <div className="flex items-center gap-8">
              <span className="w-24 font-display text-[64px] leading-none font-bold tracking-tight text-neutral-900">Ag</span>
              <div>
                <p className="font-display text-h2 font-bold text-neutral-900">Geist Bold</p>
                <p className="mt-1 text-small text-neutral-500">Display · Tight · Confident</p>
              </div>
            </div>
            <div className="flex items-center gap-8">
              <span className="w-24 text-[64px] leading-none font-medium text-neutral-900">Ag</span>
              <div>
                <p className="text-h3 font-medium text-neutral-900">Geist</p>
                <p className="mt-1 text-small text-neutral-500">Clean · Modern · Highly legible</p>
              </div>
            </div>
          </div>
        </Panel>

        <Panel className="overflow-x-auto">
          <SectionTitle n="03">Type Scale</SectionTitle>
          <table className="w-full min-w-[560px] text-left text-small">
            <thead>
              <tr className="text-neutral-500">
                <th className="pb-3 font-normal">Style</th>
                <th className="pb-3 font-normal">Font</th>
                <th className="pb-3 font-normal">Size / Line Height</th>
                <th className="pb-3 font-normal">Weight</th>
                <th className="pb-3 font-normal">Use</th>
              </tr>
            </thead>
            <tbody>
              {typeScale.map((t) => (
                <tr key={t.style} className="align-middle">
                  <td className="py-1.5 pr-4">
                    <span className={cn(t.cls, "block !text-[16px] !leading-6 whitespace-nowrap text-neutral-900")}>
                      {t.style}
                    </span>
                  </td>
                  <td className="py-1.5 pr-4 text-neutral-700">{t.font}</td>
                  <td className="py-1.5 pr-4 text-neutral-700">{t.size}</td>
                  <td className="py-1.5 pr-4 text-neutral-700">{t.weight}</td>
                  <td className="py-1.5 text-neutral-700">{t.use}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      </div>

      {/* 04 Spacing + 05 Radius & Shadows */}
      <div className="grid gap-4 lg:grid-cols-[1.1fr_1fr]">
        <Panel className="overflow-x-auto">
          <SectionTitle n="04">Spacing System</SectionTitle>
          <Label>Base unit: 4px</Label>
          <div className="flex items-end justify-between gap-2 pt-4">
            {spacing.map((s) => (
              <div key={s} className="flex flex-col items-center gap-3">
                <div className="flex h-16 items-end">
                  <div className="rounded-xs bg-primary-200" style={{ width: s, height: s }} />
                </div>
                <div className="text-center">
                  <p className="text-body font-medium text-neutral-900">{s}</p>
                  <p className="text-small text-neutral-500">({s / 16}rem)</p>
                </div>
              </div>
            ))}
          </div>
        </Panel>

        <Panel>
          <SectionTitle n="05">Radius &amp; Shadows</SectionTitle>
          <Label>Radius</Label>
          <div className="mb-8 flex flex-wrap gap-6">
            {radii.map((r) => (
              <div key={r.name} className="flex flex-col items-center gap-3">
                <div className={cn("size-11 border border-neutral-300 bg-neutral-50", r.cls)} />
                <div className="text-center text-small text-neutral-700">
                  <p>{r.px}</p>
                  <p className="text-neutral-500">({r.name})</p>
                </div>
              </div>
            ))}
          </div>
          <Label>Shadows</Label>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {shadows.map((s) => (
              <div key={s.name} className={cn("rounded-sm border border-neutral-100 bg-surface p-3", s.cls)}>
                <p className="text-body font-semibold text-neutral-900">{s.name}</p>
                <p className="mt-2 text-[11px] leading-4 whitespace-nowrap text-neutral-700">{s.value}</p>
                <p className="text-[11px] leading-4 text-neutral-500">{s.alpha}</p>
              </div>
            ))}
          </div>
        </Panel>
      </div>

      {/* 06 Icons + 07 Buttons + 08 Inputs */}
      <div className="grid gap-4 lg:grid-cols-[290px_1fr_270px]">
        <Panel>
          <SectionTitle n="06">Icons</SectionTitle>
          <Label>Outline Style</Label>
          <div className="mb-6 flex justify-between text-neutral-900">
            {iconSet.map((n) => (
              <Icon key={n} name={n} size={20} />
            ))}
          </div>
          <Label>Filled Style</Label>
          <div className="mb-8 flex justify-between text-neutral-900">
            {iconSet.map((n) => (
              <Icon key={n} name={n} filled size={20} />
            ))}
          </div>
          <Spec
            title="Icon Specs"
            items={["24x24px grid", "2px stroke width (outline)", "Rounded line caps", "Consistent optical balance"]}
          />
        </Panel>

        <Panel className="overflow-x-auto">
          <SectionTitle n="07">Buttons</SectionTitle>
          <div className="grid w-max grid-cols-[60px_repeat(4,auto)] items-center gap-x-3 gap-y-4">
            <span />
            {["Primary", "Secondary", "Tertiary", "Text"].map((h) => (
              <span key={h} className="text-small text-neutral-500">
                {h}
              </span>
            ))}
            {(["Default", "Hover", "Disabled"] as const).map((state) => {
              const disabled = state === "Disabled";
              const hover = state === "Hover";
              return (
                <div key={state} className="contents">
                  <span className="text-small text-neutral-700">{state}</span>
                  <div>
                    <Button
                      variant="primary"
                      size="md"
                      disabled={disabled}
                      className={cn(hover && "bg-primary-600")}
                    >
                      Get Started
                    </Button>
                  </div>
                  <div>
                    <Button
                      variant="secondary"
                      size="md"
                      disabled={disabled}
                      className={cn(hover && "bg-primary-100")}
                    >
                      Explore Courses
                    </Button>
                  </div>
                  <div>
                    <Button
                      variant="tertiary"
                      size="md"
                      disabled={disabled}
                      className={cn(hover && "border-neutral-300 bg-neutral-50")}
                      iconRight={<Icon name="external-link" size={16} />}
                    >
                      View Lesson
                    </Button>
                  </div>
                  <div>
                    <Button
                      variant="text"
                      size="md"
                      disabled={disabled}
                      className={cn(hover && "text-primary-600")}
                      iconRight={<Icon name="play" size={18} />}
                    >
                      Watch Video
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
          <div className="mt-8">
            <Spec
              title="Button Specs"
              items={[
                "Height: 44px (default)",
                "Padding: 0 16px (lg), 0 12px (md)",
                "Radius: 12px",
                "Font: Geist Medium (14–16px)",
              ]}
            />
          </div>
        </Panel>

        <Panel>
          <SectionTitle n="08">Inputs</SectionTitle>
          <Label>Search / Text Input</Label>
          <Input search shortcut="⌘ K" placeholder="Search anything..." aria-label="Search" className="mb-6" />
          <Label>Select</Label>
          <Select
            aria-label="Sort"
            defaultValue="relevant"
            className="mb-8"
            options={[
              { value: "relevant", label: "Most Relevant" },
              { value: "newest", label: "Newest" },
              { value: "popular", label: "Most Popular" },
            ]}
          />
          <Spec
            title="Field Specs"
            items={[
              "Height: 44px",
              "Radius: 12px",
              "Border: 1px solid #2E3238",
              "Padding: 0 16px",
              "Focus: Border color #31FBB8 · 60%",
            ]}
          />
        </Panel>
      </div>

      {/* 09 Badges + 10 Status + 11 Progress */}
      <div className="grid gap-4 lg:grid-cols-[290px_1.25fr_1fr]">
        <Panel>
          <SectionTitle n="09">Badges / Tags</SectionTitle>
          <div className="flex gap-10">
            {(["video", "lesson", "popular"] as const).map((v) => (
              <div key={v} className="flex flex-col gap-3">
                <span className="text-small text-neutral-700 capitalize">{v}</span>
                <Badge variant={v}>{v}</Badge>
              </div>
            ))}
          </div>
        </Panel>

        <Panel>
          <SectionTitle n="10">Status / Indicators</SectionTitle>
          <div className="flex flex-wrap gap-x-6 gap-y-3">
            <Status kind="in-progress" />
            <Status kind="completed" />
            <Status kind="now-playing" />
            <Status kind="locked" />
          </div>
        </Panel>

        <Panel>
          <SectionTitle n="11">Progress Bar</SectionTitle>
          <ProgressBar value={35} />
        </Panel>
      </div>

      {/* 12 Cards */}
      <Panel>
        <SectionTitle n="12">Cards</SectionTitle>
        <div className="grid gap-5 md:grid-cols-2 lg:grid-cols-4">
          <div>
            <Label className="text-small text-neutral-700">Course Card</Label>
            <CourseCard
              title="Next.js for Production"
              description="Build scalable, high-performance web applications with Next.js."
              icon={
                <span className="flex size-10 items-center justify-center rounded-sm border border-neutral-200 bg-black text-[22px] font-semibold text-white">
                  N
                </span>
              }
              level="Intermediate"
              duration="18h 24m"
              modules="12 modules"
            />
          </div>
          <div>
            <Label className="text-small text-neutral-700">Lesson Card (Video)</Label>
            <LessonCard
              badge="video"
              title="Data Fetching in Server Components"
              description="Learn how to fetch data on the server using async/await and Next.js best practices."
              meta={["Lesson 5.1", "12:45"]}
              action={
                <Button variant="text" size="md" iconLeft={<Icon name="play" size={18} />}>
                  Watch from 12:45
                </Button>
              }
            />
          </div>
          <div>
            <Label className="text-small text-neutral-700">Lesson Card (Lesson)</Label>
            <LessonCard
              badge="lesson"
              title="Data Fetching & Caching"
              description="Explore different data fetching methods in Next.js and how to cache and revalidate data for optimal performance."
              meta={["Module 5"]}
              action={
                <Button variant="text" size="md" iconRight={<Icon name="external-link" size={16} />}>
                  View lesson
                </Button>
              }
            />
          </div>
          <div>
            <Label className="text-small text-neutral-700">Resource Card</Label>
            <ResourceCard
              title="Caching and Revalidation Guide"
              description="Deep dive into Next.js caching strategies."
              meta={["PDF", "1.2 MB"]}
            />
          </div>
        </div>
      </Panel>

      {/* 13 Navigation */}
      <Panel>
        <SectionTitle n="13">Navigation</SectionTitle>
        <div className="grid items-center gap-6 lg:grid-cols-[auto_auto_1fr_auto_auto]">
          <Navbar
            items={[
              { label: "Courses", href: "#", active: true },
              { label: "My Learning", href: "#" },
            ]}
          />
          <div className="hidden h-12 w-px bg-neutral-200 lg:block" />
          <div>
            <Label className="text-small text-neutral-700">Breadcrumbs</Label>
            <Breadcrumbs
              items={[
                { label: "All Courses", href: "#" },
                { label: "Next.js for Production", href: "#" },
                { label: "Data Fetching & Caching" },
              ]}
            />
          </div>
          <div className="hidden h-12 w-px bg-neutral-200 lg:block" />
          <div>
            <Label className="text-small text-neutral-700">Pagination</Label>
            <Pagination page={1} totalPages={8} hrefFor={() => "#"} />
          </div>
        </div>
      </Panel>

      {/* 14 Principles */}
      <Panel>
        <div className="grid items-start gap-6 lg:grid-cols-[160px_repeat(4,1fr)]">
          <SectionTitle n="14">Principles</SectionTitle>
          {principles.map((p) => (
            <div key={p.title} className="flex gap-3">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-neutral-100 text-neutral-900">
                <Icon name={p.icon} size={20} />
              </span>
              <div>
                <p className="text-body font-medium text-neutral-900">{p.title}</p>
                <p className="mt-0.5 text-small leading-5 text-neutral-700">{p.body}</p>
              </div>
            </div>
          ))}
        </div>
      </Panel>
    </main>
  );
}
