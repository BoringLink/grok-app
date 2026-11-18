import { cn } from "@/lib/utils";

type SpinnerProps = {
  className?: string;
  size?: number;
  /** 会话活动状态使用圆环样式。 */
  variant?: "ring";
};

/** 加载指示器；会话活动状态使用圆环变体。 */
export function Spinner({
  className,
  size = 14,
  variant,
}: SpinnerProps) {
  if (variant === "ring") {
    return (
      <span
        className={cn("session-activity-spinner", className)}
        style={{ width: size, height: size }}
        aria-hidden
      />
    );
  }

  return (
    <svg
      className={cn("animate-spin text-[var(--text-tertiary)]", className)}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
    >
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="3"
      />
      <path
        className="opacity-90"
        fill="currentColor"
        d="M4 12a8 8 0 018-8v3a5 5 0 00-5 5H4z"
      />
    </svg>
  );
}
