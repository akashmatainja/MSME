"use client";

/**
 * Shows a number as-is (no count-up animation between values).
 * Trailing zeros are dropped: 2 → "2", 2.5 → "2.5", 2.345 → "2.35" (with decimals = 2).
 */
export default function AnimatedNumber({
  value,
  decimals = 1,
  className,
}: {
  value: number;
  decimals?: number;
  /** Kept for API compatibility; no longer used. */
  duration?: number;
  className?: string;
}) {
  const text = value.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: decimals });
  return <span className={className}>{text}</span>;
}
