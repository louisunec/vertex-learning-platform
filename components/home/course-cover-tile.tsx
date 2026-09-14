import Image from "next/image";
import { cn } from "@/lib/cn";
import { urlFor } from "@/sanity/lib/image";
import type { COURSES_QUERY_RESULT } from "@/sanity.types";

type Cover = COURSES_QUERY_RESULT[number]["coverImage"];

export interface CourseCoverTileProps {
  cover: Cover;
  /** Rendered size in CSS px (the frame's width when `letterbox`); the image is requested at 2× for retina. */
  size: number;
  /**
   * Show the whole image — uncropped and unstretched — on a dark ground. The tile fills its
   * parent, so the parent frame sets the shape (e.g. a 16:9 box).
   */
  letterbox?: boolean;
  alt?: string;
  className?: string;
}

/**
 * Course cover. By default a square tile that crops the stored `coverImage` (hotspot-aware);
 * `letterbox` keeps the full image. Falls back to a neutral tile when no asset exists — never
 * an invented logo.
 */
export function CourseCoverTile({ cover, size, letterbox = false, alt = "", className }: CourseCoverTileProps) {
  const hasAsset = Boolean(cover?.asset);
  if (letterbox) {
    return (
      <div className={cn("relative size-full overflow-hidden rounded-lg bg-black", className)}>
        {hasAsset && cover && (
          <Image
            // Width only with fit=max keeps the source aspect ratio; width + height would crop on the CDN.
            src={urlFor(cover).width(size * 2).fit("max").auto("format").url()}
            alt={cover.alt ?? alt}
            fill
            sizes={`${size}px`}
            placeholder={cover.asset?.metadata?.lqip ? "blur" : "empty"}
            blurDataURL={cover.asset?.metadata?.lqip ?? undefined}
            className="object-contain"
          />
        )}
      </div>
    );
  }
  return (
    <div
      className={cn("relative shrink-0 overflow-hidden rounded-lg bg-neutral-900", className)}
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
