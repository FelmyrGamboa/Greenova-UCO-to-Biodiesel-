import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react";

export function Card({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={`glass rounded-2xl ${className}`}>{children}</div>;
}

export function Heading({
  as = "h2",
  children,
  className = "",
}: {
  as?: "h1" | "h2" | "h3";
  children: ReactNode;
  className?: string;
}) {
  const Tag = as;
  return <Tag className={`font-display text-white ${className}`}>{children}</Tag>;
}

export function Button({
  variant = "primary",
  className = "",
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
}) {
  return (
    <button className={`btn-${variant} ${className}`} {...props}>
      {children}
    </button>
  );
}

export function Field({
  label,
  unit,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: string; unit?: string }) {
  return (
    <label className="block">
      <span className="gv-label">{label}</span>
      <span className="relative block">
        <input className="gv-input pr-14" {...props} />
        {unit && (
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-gray-500">
            {unit}
          </span>
        )}
      </span>
    </label>
  );
}

export function SelectField({
  label,
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="gv-label">{label}</span>
      <select className="gv-select" {...props}>
        {children}
      </select>
    </label>
  );
}

export function Status({
  tone = "green",
  children,
}: {
  tone?: "green" | "blue" | "yellow" | "red" | "neutral";
  children: ReactNode;
}) {
  const tones = {
    green: "border-green-500/20 bg-green-500/10 text-green-400",
    blue: "border-blue-500/20 bg-blue-500/10 text-blue-400",
    yellow: "border-yellow-500/20 bg-yellow-500/10 text-yellow-400",
    red: "border-red-500/20 bg-red-500/10 text-red-400",
    neutral: "border-white/10 bg-white/5 text-gray-400",
  };
  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-semibold ${tones[tone]}`}>
      {children}
    </span>
  );
}

/** Badge color of a batch status: Completed green, In Progress blue, Cancelled yellow, Failed red. */
export function batchTone(status: string): "green" | "blue" | "yellow" | "red" {
  return status === "Completed" ? "green" : status === "In Progress" ? "blue" : status === "Cancelled" ? "yellow" : "red";
}

export function Metric({
  label,
  value,
  sub,
  accent = false,
}: {
  label: string;
  value: ReactNode;
  sub?: string;
  accent?: boolean;
}) {
  return (
    <div className="min-w-0">
      <div className="gv-label">{label}</div>
      <div className={`font-display text-xl font-bold ${accent ? "text-green-400" : "text-white"}`}>
        {value}
      </div>
      {sub && <div className="mt-1 text-xs text-gray-500">{sub}</div>}
    </div>
  );
}

/** A message on top of the page, with its own buttons (actions). */
export function Dialog({
  title,
  children,
  actions,
  onClose,
}: {
  title: string;
  children: ReactNode;
  actions: ReactNode;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
      onKeyDown={(event) => { if (event.key === "Escape") onClose(); }}
    >
      <div className="glass w-full max-w-md rounded-2xl bg-gv-surface p-6">
        <Heading as="h2" className="text-lg font-semibold">{title}</Heading>
        <div className="mt-2 text-sm leading-6 text-gray-400">{children}</div>
        <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">{actions}</div>
      </div>
    </div>
  );
}

export function Progress({ value }: { value: number }) {
  return (
    <div className="progress-track h-2">
      <div className="progress-fill h-full" style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </div>
  );
}
