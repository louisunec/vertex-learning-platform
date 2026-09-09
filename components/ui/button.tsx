import type { ButtonHTMLAttributes, ReactNode } from "react";
import React from "react";
import Link from "next/link";
import { cn } from "@/lib/cn";

/**
 * 07 · Buttons — height 44px, radius 12px, Inter Medium.
 * Padding: 0 16px (lg, default) · 0 12px (md).
 */
export type ButtonVariant = "primary" | "secondary" | "tertiary" | "text";
export type ButtonSize = "md" | "lg";

const variants: Record<ButtonVariant, string> = {
  primary:
    "bg-primary-500 text-white hover:bg-primary-600 disabled:bg-primary-100 disabled:text-primary-300",
  secondary:
    "border border-primary-500 bg-white text-primary-500 hover:bg-primary-100 disabled:border-primary-200 disabled:text-primary-300 disabled:hover:bg-white",
  tertiary:
    "border border-neutral-200 bg-white text-neutral-900 hover:border-neutral-300 hover:bg-neutral-50 disabled:text-neutral-300 disabled:hover:border-neutral-200 disabled:hover:bg-white",
  text: "h-auto px-0 text-primary-500 hover:text-primary-600 disabled:text-primary-300",
};

const sizes: Record<ButtonSize, string> = {
  md: "px-3 text-body",
  lg: "px-4 text-body-lg",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  iconLeft?: ReactNode;
  iconRight?: ReactNode;
  /** Render a Next.js `Link` with button styling instead of a `<button>`. */
  href?: string;
}

export function Button({
  variant = "primary",
  size = "lg",
  iconLeft,
  iconRight,
  href,
  className,
  children,
  type = "button",
  ...props
}: ButtonProps) {
  const classes = cn(
    "inline-flex h-11 items-center justify-center gap-2 rounded-md font-medium whitespace-nowrap transition-colors",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400 focus-visible:ring-offset-2",
    "disabled:pointer-events-none",
    variants[variant],
    variant === "text" ? (size === "md" ? "text-body" : "text-body-lg") : sizes[size],
    className,
  );
  const content = (
    <>
      {iconLeft}
      {children}
      {iconRight}
    </>
  );

  if (href) {
    return (
      <Link href={href} className={classes} aria-label={props["aria-label"]} onClick={props.onClick as unknown as React.MouseEventHandler<HTMLAnchorElement>}>
        {content}
      </Link>
    );
  }

  return (
    <button type={type} className={classes} {...props}>
      {content}
    </button>
  );
}
