import Image from "next/image";
import { cn } from "@/lib/cn";
import { urlFor } from "@/sanity/lib/image";
import type { COURSES_QUERY_RESULT } from "@/sanity.types";

type Cover = COURSES_QUERY_RESULT[number]["coverImage"];

export interface CourseCoverTileProps {
  cover: Cover;
  /** Rendered size in CSS px; the image is requested at 2× for retina. */
  size: number;
  alt?: string;
  className?: string;
}

/**
 * Square course cover for catalog cards. Crops the stored `coverImage` (hotspot-aware)
 * and falls back to a neutral tile when no asset exists — never an invented logo.
 */
export function CourseCoverTile({ cover, size, alt = "", className }: CourseCoverTileProps) {
  const hasAsset = Boolean(cover?.asset);
  return (
    <div
      className={cn("relative shrink-0 overflow-hidden rounded-lg bg-black", className)}
      style={{ width: size, height: size }}
    >
      {hasAsset && cover && (
        <Image
          src={urlFor(cover).width(size * 2).height(size * 2).fit("crop").auto("format").url()}
          alt={cover.alt ?? alt}
          fill
          sizes={`${size}px`}
          placeholder={cover.asset?.metadata?.lqip ? "blur" : "empty"}
          blurDataURL={cover.asset?.metadata?.lqip ?? undefined}
          className="object-cover"
        />
      )}
    </div>
  );
}
