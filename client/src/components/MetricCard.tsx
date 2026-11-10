import React from "react";

interface MetricCardProps {
  title: string;
  value: string | number;
  subtitle?: string;
  icon?: React.ReactNode;
  delta?: { value: number; label?: string };
  tone?: "blue" | "amber" | "green" | "purple" | "slate";
}

const TONES = {
  blue: { bg: "bg-[#5A92C9]/10", border: "border-[#5A92C9]/30", icon: "text-[#5A92C9]" },
  amber: { bg: "bg-[#D58240]/10", border: "border-[#D58240]/30", icon: "text-[#D58240]" },
  green: { bg: "bg-emerald-500/10", border: "border-emerald-500/30", icon: "text-emerald-500" },
  purple: { bg: "bg-purple-500/10", border: "border-purple-500/30", icon: "text-purple-400" },
  slate: { bg: "bg-slate-500/10", border: "border-slate-500/30", icon: "text-slate-400" },
};

export function MetricCard({ title, value, subtitle, icon, delta, tone = "blue" }: MetricCardProps) {
  const t = TONES[tone];
  return (
    <article className="rounded-2xl bg-card border border-border p-5 panel-shadow flex flex-col justify-between gap-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-wider text-muted-foreground font-semibold">{title}</p>
          <div className="text-3xl sm:text-4xl font-bold tracking-tight text-foreground mt-1">
            {typeof value === "number" ? value.toLocaleString() : value}
          </div>
        </div>
        {icon && <div className={`rounded-xl p-2.5 ${t.bg} ${t.icon}`}>{icon}</div>}
      </div>
      {(subtitle || delta !== undefined) && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {delta !== undefined && (
            <span className={`font-semibold ${delta.value >= 0 ? "text-emerald-500" : "text-rose-500"}`}>
              {delta.value >= 0 ? "+" : ""}{delta.value}%
            </span>
          )}
          {subtitle && <span>{subtitle}</span>}
        </div>
      )}
    </article>
  );
}
