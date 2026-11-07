import { Link } from "react-router";
import { useSession } from "@/lib/session";

export function BrandMark({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden className="shrink-0">
      <rect width="32" height="32" rx="7" fill="#f6821f" />
      <path
        d="M9 21.5h14M16 8v10.5m0-10.5-4.5 4.5M16 8l4.5 4.5"
        stroke="#fff"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}

/** Logo + site name; the name hides when the sidebar collapses to icons (unless `compact`). */
export function Brand({ compact = false }: { compact?: boolean }) {
  const { info } = useSession();
  return (
    <Link to="/projects" className="flex min-w-0 items-center gap-2.5 px-0.5 no-underline">
      <BrandMark />
      <span
        className={
          compact
            ? "truncate text-base font-semibold text-kumo-strong"
            : "truncate text-base font-semibold text-kumo-strong group-data-[state=collapsed]/sidebar:hidden"
        }
      >
        {info.name}
      </span>
    </Link>
  );
}
