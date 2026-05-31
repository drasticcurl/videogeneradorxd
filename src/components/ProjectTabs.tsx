"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

export function ProjectTabs({ projectId }: { projectId: string }) {
  const pathname = usePathname();
  const tabs = [
    { href: `/project/${projectId}/pipeline`, label: "Pipeline" },
    { href: `/project/${projectId}/result`, label: "Resultado" },
  ];
  return (
    <nav className="flex gap-1 rounded-lg border border-slate-800 bg-panel p-1 text-sm">
      {tabs.map((t) => {
        const active = pathname === t.href;
        return (
          <Link
            key={t.href}
            href={t.href}
            className={`rounded-md px-4 py-1.5 ${
              active ? "bg-accent text-white" : "text-slate-300 hover:bg-slate-800"
            }`}
          >
            {t.label}
          </Link>
        );
      })}
      <Link
        href="/"
        className="ml-auto rounded-md px-4 py-1.5 text-slate-400 hover:bg-slate-800"
      >
        + Nuevo
      </Link>
    </nav>
  );
}
