import Image from "next/image";
import { cn } from "@/lib/cn";

export interface SearchCourseIconProps {
  /** Stored course cover asset URL; null when the course has no image. */
  coverImageUrl: string | null;
  /** Rendered size in CSS px; the image is requested at 2× for retina. */
  size?: number;
  className?: string;
}

/**
 * Small square course mark shown beside the course title on a search result
 * row. Falls back to a neutral tile when no asset is stored — never an
 * invented logo (mirrors `CourseCoverTile`).
 */
export function SearchCourseIcon({ coverImageUrl, size = 24, className }: SearchCourseIconProps) {
  return (
    <span
      className={cn("relative block shrink-0 overflow-hidden rounded-sm bg-neutral-100", className)}
      style={{ width: size, height: size }}
    >
      {coverImageUrl && (
        <Image
          src={coverImageUrl}
          alt=""
          fill
          sizes={`${size}px`}
          className="object-cover"
        />
      )}
    </span>
  );
}
