import { useState } from 'react';
import { Outlet, Navigate } from 'react-router';
import { useAuth } from '../contexts/AuthContext';
import Sidebar from '../components/Sidebar';

export default function AuthLayout() {
  const { user, loading } = useAuth();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center bg-gv-bg">
        <div className="flex flex-col items-center gap-4">
          <div
            className="w-10 h-10 rounded-xl flex items-center justify-center"
            style={{ background: 'linear-gradient(135deg, #16a34a, #22c55e)' }}
          >
            <svg viewBox="0 0 24 24" fill="none" className="w-6 h-6">
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 15v-4H7l5-8v4h4l-5 8z" fill="white" />
            </svg>
          </div>
          <div className="text-green-400 text-sm font-medium">Loading Greenova…</div>
        </div>
      </div>
    );
  }

  if (!user) return <Navigate to="/login" replace />;

  return (
    <div className="h-full flex bg-gv-bg bg-blob bg-grid">
      <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Mobile top bar */}
        <header className="lg:hidden flex items-center gap-4 px-4 py-3 border-b" style={{ borderColor: 'rgba(34, 197, 94, 0.1)', background: 'rgba(4, 10, 6, 0.9)', backdropFilter: 'blur(12px)' }}>
          <button
            onClick={() => setSidebarOpen(true)}
            className="text-gray-400 hover:text-green-400 transition-colors"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-6 h-6">
              <path d="M4 6h16M4 12h16M4 18h16" strokeLinecap="round" />
            </svg>
          </button>
          <div className="font-display font-bold text-green-400 tracking-wider text-sm">GREENOVA</div>
        </header>

        <main className="flex-1 overflow-y-auto">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
