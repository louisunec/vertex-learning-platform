import Image from "next/image";
import { PortableText, type PortableTextComponents } from "next-sanity";
import { cn } from "@/lib/cn";
import { urlFor } from "@/sanity/lib/image";
import type { BlockContent } from "@/sanity.types";

/**
 * Renders stored lesson notes (Portable Text). Styling follows the lesson
 * design: serif headings, quiet body copy. Notes are authored content — this
 * component only presents what is stored.
 */
const components: PortableTextComponents = {
  block: {
    normal: ({ children }) => (
      <p className="mt-4 text-[15px] leading-7 text-neutral-500 first:mt-0">{children}</p>
    ),
    h2: ({ children }) => (
      <h3 className="mt-8 font-display text-[22px] leading-8 font-normal text-neutral-900 first:mt-0">
        {children}
      </h3>
    ),
    h3: ({ children }) => (
      <h4 className="mt-6 font-display text-[19px] leading-7 font-normal text-neutral-900 first:mt-0">
        {children}
      </h4>
    ),
    h4: ({ children }) => (
      <h5 className="mt-5 text-body-lg font-semibold text-neutral-900 first:mt-0">{children}</h5>
    ),
    blockquote: ({ children }) => (
      <blockquote className="mt-4 border-l-2 border-primary-200 pl-4 text-[15px] leading-7 text-neutral-700 italic">
        {children}
      </blockquote>
    ),
  },
  list: {
    bullet: ({ children }) => (
      <ul className="mt-4 list-disc space-y-2 pl-5 text-[15px] leading-7 text-neutral-500 marker:text-neutral-300">
        {children}
      </ul>
    ),
    number: ({ children }) => (
      <ol className="mt-4 list-decimal space-y-2 pl-5 text-[15px] leading-7 text-neutral-500 marker:text-neutral-400">
        {children}
      </ol>
    ),
  },
  marks: {
    strong: ({ children }) => <strong className="font-semibold text-neutral-900">{children}</strong>,
    code: ({ children }) => (
      <code className="rounded-xs bg-neutral-100 px-1.5 py-0.5 font-mono text-[13px] text-neutral-900">
        {children}
      </code>
    ),
    link: ({ children, value }) => (
      <a
        href={value?.href}
        rel="noreferrer noopener"
        className="text-primary-500 underline underline-offset-2 hover:text-primary-600"
      >
        {children}
      </a>
    ),
  },
  types: {
    image: ({ value }) =>
      value?.asset ? (
        <Image
          src={urlFor(value).width(1280).fit("max").auto("format").url()}
          alt={value.alt ?? ""}
          width={640}
          height={360}
          className="mt-6 h-auto w-full rounded-lg border border-neutral-200"
        />
      ) : null,
  },
};

export function LessonNotes({ value, className }: { value: BlockContent; className?: string }) {
  return (
    <div className={cn("max-w-[640px]", className)}>
      <PortableText value={value} components={components} />
    </div>
  );
}
