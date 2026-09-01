import { cn } from "@/lib/cn";

/** Soft orange "skyline" bars along the bottom edge: [left %, width %, height %]. */
const bars: Array<[number, number, number]> = [
  [0, 5, 46],
  [5, 4, 30],
  [9, 5, 68],
  [14, 4, 52],
  [18, 5, 100],
  [23, 4, 84],
  [27, 5, 62],
  [32, 4, 40],
  [36, 4, 26],
  [58, 4, 30],
  [62, 5, 50],
  [67, 4, 74],
  [71, 5, 100],
  [76, 4, 60],
  [80, 5, 88],
  [85, 4, 44],
  [89, 5, 72],
  [94, 6, 56],
];

/** Decorative page-frame footer; pin it to the bottom of the column with `mt-auto`. */
export function Skyline({ className }: { className?: string }) {
  return (
    <div aria-hidden="true" className={cn("relative mt-auto h-[210px] overflow-hidden pt-6", className)}>
      {bars.map(([left, width, height], i) => (
        <span
          key={i}
          className="absolute bottom-0 bg-gradient-to-t from-primary-300/70 via-primary-200/45 to-primary-100/0 blur-[3px]"
          style={{ left: `${left}%`, width: `${width}%`, height: `${height}%` }}
        />
      ))}
    </div>
  );
}
