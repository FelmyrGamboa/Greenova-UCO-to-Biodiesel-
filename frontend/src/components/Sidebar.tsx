import type { ReactNode } from "react";
import { Link, NavLink } from "react-router";
import { useLiveData } from "../contexts/LiveContext";
import GreenovaLogo from "./GreenovaLogo";
import { Button, Status } from "./ui";

interface SidebarProps {
  open: boolean;
  onClose: () => void;
}

const Icon = ({ children }: { children: ReactNode }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" className="h-5 w-5" strokeWidth="1.7">
    {children}
  </svg>
);

const navItems = [
  {
    to: "/dashboard",
    label: "Dashboard",
    icon: <Icon><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></Icon>,
  },
  {
    to: "/process",
    label: "Process",
    icon: <Icon><path d="M5 4h14v5H5zM5 15h14v5H5zM12 9v6" strokeLinecap="round" strokeLinejoin="round" /></Icon>,
  },
  {
    to: "/batches",
    label: "Batch History",
    icon: <Icon><path d="M5 4h14v16H5zM8 8h8M8 12h8M8 16h5" strokeLinecap="round" strokeLinejoin="round" /></Icon>,
  },
  {
    to: "/settings",
    label: "Settings",
    icon: <Icon><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 00.3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 00-1.9-.3 1.7 1.7 0 00-1 1.6v.2h-4V21a1.7 1.7 0 00-1-1.6 1.7 1.7 0 00-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 00.3-1.9A1.7 1.7 0 003 14H2.8v-4H3a1.7 1.7 0 001.6-1 1.7 1.7 0 00-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 001.9.3A1.7 1.7 0 0010 3V2.8h4V3a1.7 1.7 0 001 1.6 1.7 1.7 0 001.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 00-.3 1.9 1.7 1.7 0 001.6 1h.2v4H21a1.7 1.7 0 00-1.6 1z" /></Icon>,
  },
];

function readOperator() {
  try {
    const settings = JSON.parse(localStorage.getItem("greenova_settings") || "{}") as Record<string, unknown>;
    return String(settings.operator || "Operator 01");
  } catch {
    return "Operator 01";
  }
}

export default function Sidebar({ open, onClose }: SidebarProps) {
  const { backend, mock, connecting } = useLiveData();
  const operator = readOperator();
  return (
    <>
      {open && <div className="fixed inset-0 z-40 bg-black/70 lg:hidden" onClick={onClose} />}
      <aside className={`fixed inset-y-0 left-0 z-50 flex w-64 flex-col border-r border-white/[0.07] bg-[#0b120d] transition-transform lg:translate-x-0 ${open ? "translate-x-0" : "-translate-x-full"}`}>
        <div className="flex h-20 items-center justify-between border-b border-white/[0.07] px-6">
          <Link
            to="/"
            onClick={onClose}
            aria-label="Return to Greenova landing page"
            className="rounded-sm transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500/50"
          >
            <GreenovaLogo size="md" />
          </Link>
          <Button variant="ghost" className="!p-2 lg:hidden" onClick={onClose} aria-label="Close navigation">×</Button>
        </div>
        <nav className="flex-1 px-3 py-6">
          <div className="mb-3 px-3 text-[10px] font-semibold uppercase tracking-[0.18em] text-gray-600">Workspace</div>
          <div className="space-y-1">
            {navItems.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                onClick={onClose}
                className={({ isActive }) => `flex items-center gap-3 rounded-lg px-3 py-3 text-sm font-medium transition-colors ${isActive ? "bg-green-500/10 text-green-400" : "text-gray-400 hover:bg-white/[0.04] hover:text-white"}`}
              >
                {item.icon}
                {item.label}
              </NavLink>
            ))}
          </div>
        </nav>
        <div className="border-t border-white/[0.07] p-5">
          <div className="mb-4 flex items-center justify-between">
            <span className="text-xs text-gray-500">System</span>
            {backend && !mock ? (
              <Status>Connected</Status>
            ) : backend ? (
              <Status tone="yellow">Backend · demo</Status>
            ) : connecting ? (
              <Status tone="neutral">Connecting…</Status>
            ) : (
              <Status tone="neutral">Local demo</Status>
            )}
          </div>
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-green-500/10 text-xs font-bold text-green-400">OP</div>
            <div>
              <div className="text-sm font-medium text-gray-200">{operator}</div>
              <div className="text-xs text-gray-600">Production session</div>
            </div>
          </div>
        </div>
      </aside>
    </>
  );
}
