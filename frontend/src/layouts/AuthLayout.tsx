import { useState } from "react";
import { Link, Outlet } from "react-router";
import Sidebar from "../components/Sidebar";
import GreenovaLogo from "../components/GreenovaLogo";
import { Button } from "../components/ui";
import { useLiveData } from "../contexts/LiveContext";
import { clearAlarm } from "../lib/api";

export default function AuthLayout() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const { live } = useLiveData();

  return (
    <div className="min-h-screen bg-gv-bg text-white">
      <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />
      <div className="min-h-screen lg:pl-64">
        <div className="sticky top-0 z-30 flex items-center justify-between border-b border-white/[0.07] bg-gv-bg/90 px-4 py-3 backdrop-blur lg:hidden">
          <Link to="/" aria-label="Return to Greenova landing page" className="transition-opacity hover:opacity-80">
            <GreenovaLogo size="sm" />
          </Link>
          <Button variant="ghost" className="!p-2" onClick={() => setSidebarOpen(true)} aria-label="Open navigation">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" className="h-5 w-5">
              <path d="M4 7h16M4 12h16M4 17h16" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </Button>
        </div>
        <main className="mx-auto w-full max-w-[1440px] p-4 sm:p-6 lg:p-8">
          {live?.alarm && (
            <div role="alert" className="mb-6 flex flex-col gap-3 rounded-xl border border-red-500/30 bg-red-500/[0.08] p-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <div className="font-display text-sm font-semibold text-red-400">Safety alarm</div>
                <p className="mt-1 text-sm text-gray-300">{live.alarm}</p>
              </div>
              <Button variant="secondary" onClick={() => { clearAlarm().catch(() => undefined); }}>Clear</Button>
            </div>
          )}
          <Outlet />
        </main>
      </div>
    </div>
  );
}
