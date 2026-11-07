import { Link } from "react-router";
import { useSession } from "@/lib/session";

export function BrandMark({ size = 28 }: { size?: number }) {
  return (
    <img
      src="/logo.svg"
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      className="shrink-0 motion-safe:transition-transform motion-safe:duration-200 motion-safe:ease-out motion-safe:group-hover/brand:-translate-y-0.5 motion-safe:group-hover/brand:-rotate-6 motion-safe:group-focus-visible/brand:-translate-y-0.5 motion-safe:group-focus-visible/brand:-rotate-6"
    />
  );
}

/** Logo + site name; the name hides when the sidebar collapses to icons (unless `compact`). */
export function Brand({ compact = false }: { compact?: boolean }) {
  const { info } = useSession();
  return (
    <Link
      to="/projects"
      aria-label={info.name}
      className="group/brand flex min-w-0 items-center gap-2.5 px-0.5 no-underline"
    >
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
