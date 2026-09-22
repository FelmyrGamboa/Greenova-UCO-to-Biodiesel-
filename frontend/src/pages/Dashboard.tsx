import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useAuth } from '../contexts/AuthContext';
import { useData } from '../contexts/DataContext';
import StatusBadge from '../components/StatusBadge';
import ProcessTimeline from '../components/ProcessTimeline';
import SimBadge from '../components/SimBadge';
import { formatDate, formatDuration } from '../lib/utils';

function StatCard({ title, value, sub, icon, color = 'green' }: { title: string; value: string | number; sub?: string; icon: React.ReactNode; color?: string }) {
  const colors: Record<string, string> = {
    green: 'text-green-400 bg-green-500/10 border-green-500/20',
    blue: 'text-blue-400 bg-blue-500/10 border-blue-500/20',
    yellow: 'text-yellow-400 bg-yellow-500/10 border-yellow-500/20',
    purple: 'text-purple-400 bg-purple-500/10 border-purple-500/20',
  };
  return (
    <div className="glass rounded-2xl p-5">
      <div className="flex items-start justify-between mb-3">
        <div className={`w-10 h-10 rounded-xl flex items-center justify-center border ${colors[color]}`}>
          {icon}
        </div>
      </div>
      <div className="font-display font-bold text-2xl text-white mb-0.5">{value}</div>
      <div className="text-gray-500 text-xs">{title}</div>
      {sub && <div className="text-green-400 text-[11px] mt-1 font-medium">{sub}</div>}
    </div>
  );
}

function MachineConnectionWidget() {
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);

  function handleConnect() {
    setConnecting(true);
    setTimeout(() => {
      setConnecting(false);
      setConnected(true);
    }, 1800);
  }

  return (
    <div className="glass rounded-2xl p-5 fade-in-up">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div
            className={`w-9 h-9 rounded-lg flex items-center justify-center border transition-colors ${
              connected
                ? 'bg-green-500/10 border-green-500/20'
                : 'bg-gray-800 border-gray-700'
            }`}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className={`w-5 h-5 ${connected ? 'text-green-400' : 'text-gray-500'}`}>
              <path d="M5 12H3m18 0h-2M12 5V3m0 18v-2M7.05 7.05 5.636 5.636m12.728 12.728-1.414-1.414M7.05 16.95l-1.414 1.414M18.364 5.636l-1.414 1.414" strokeLinecap="round" strokeLinejoin="round" />
              <circle cx="12" cy="12" r="4" />
            </svg>
          </div>
          <div>
            <div className="text-sm font-medium text-white">
              {connected ? 'Machine Connected' : 'Processing Machine'}
            </div>
            <div className={`text-xs mt-0.5 flex items-center gap-1.5 ${connected ? 'text-green-400' : 'text-gray-500'}`}>
              <span className={`w-1.5 h-1.5 rounded-full inline-block ${connected ? 'bg-green-400 gv-pulse' : 'bg-gray-600'}`} />
              {connected ? 'Connected · Simulation Mode' : 'Not connected'}
            </div>
          </div>
        </div>

        {!connected ? (
          <button
            onClick={handleConnect}
            disabled={connecting}
            className="btn-primary text-xs py-2 px-4 disabled:opacity-60"
          >
            {connecting ? (
              <>
                <svg className="animate-spin w-3.5 h-3.5" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Connecting…
              </>
            ) : 'Connect to Machine'}
          </button>
        ) : (
          <button
            onClick={() => setConnected(false)}
            className="btn-ghost text-xs py-2 px-4"
          >
            Disconnect
          </button>
        )}
      </div>
    </div>
  );
}

export default function Dashboard() {
  const { user } = useAuth();
  const { store, getActiveBatch } = useData();
  const navigate = useNavigate();

  const activeBatch = getActiveBatch();
  const allBatches = store.batches;
  const completedBatches = allBatches.filter((b) => b.status === 'Completed');
  const recentBatches = [...allBatches]
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, 5);

  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';

  const activeProgress = activeBatch ? Math.round(((activeBatch.current_step - 1) / 12) * 100) : 0;
  const currentStageName = activeBatch?.stages.find((s) => s.status === 'current')?.stage_name
    ?? activeBatch?.stages[activeBatch.current_step - 1]?.stage_name
    ?? '—';

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 fade-in-up">
        <div>
          <h1 className="font-display font-bold text-2xl text-white">{greeting}, {user?.full_name?.split(' ')[0]}.</h1>
          <p className="text-gray-500 text-sm mt-0.5">Monitor your biodiesel production process.</p>
        </div>
        <Link to="/batch/new" className="btn-primary text-sm py-2.5 px-5 self-start sm:self-auto">
          <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
            <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-11a1 1 0 10-2 0v2H7a1 1 0 100 2h2v2a1 1 0 102 0v-2h2a1 1 0 100-2h-2V7z" clipRule="evenodd" />
          </svg>
          Start New Batch
        </Link>
      </div>

      {/* Machine connection */}
      <MachineConnectionWidget />

      {/* Stats row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 fade-in-up" style={{ animationDelay: '0.05s' }}>
        <StatCard
          title="Active Batch"
          value={activeBatch ? '1' : '0'}
          sub={activeBatch ? activeBatch.batch_code : 'No active batch'}
          color="blue"
          icon={<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="w-5 h-5"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 3" strokeLinecap="round" /></svg>}
        />
        <StatCard
          title="Completed Batches"
          value={completedBatches.length}
          color="green"
          icon={<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="w-5 h-5"><path d="M9 12l2 2 4-4" strokeLinecap="round" /><circle cx="12" cy="12" r="9" /></svg>}
        />
        <StatCard
          title="Total Batches"
          value={allBatches.length}
          color="purple"
          icon={<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="w-5 h-5"><path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" strokeLinecap="round" strokeLinejoin="round" /></svg>}
        />
        <StatCard
          title="System Status"
          value="Online"
          sub="Simulation Mode"
          color="yellow"
          icon={<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="w-5 h-5"><path d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17H3a2 2 0 01-2-2V5a2 2 0 012-2h14a2 2 0 012 2v10a2 2 0 01-2 2h-2" strokeLinecap="round" strokeLinejoin="round" /></svg>}
        />
      </div>

      {/* Main content grid */}
      <div className="grid lg:grid-cols-3 gap-6">
        {/* Active batch + live monitoring */}
        <div className="lg:col-span-2 space-y-5">
          {/* Current batch */}
          <div className="glass rounded-2xl p-6 fade-in-up" style={{ animationDelay: '0.1s' }}>
            <div className="flex items-center justify-between mb-5">
              <h2 className="font-display font-bold text-base text-white">Current Batch</h2>
              <SimBadge />
            </div>

            {activeBatch ? (
              <div className="space-y-5">
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                  {[
                    { label: 'Batch ID', value: activeBatch.batch_code },
                    { label: 'Process', value: activeBatch.process_type || '—' },
                    { label: 'Status', value: <StatusBadge status={activeBatch.status} size="sm" /> },
                    { label: 'Stage', value: <span className="text-green-400 font-medium text-xs">{currentStageName}</span> },
                  ].map((d) => (
                    <div key={d.label}>
                      <div className="gv-label">{d.label}</div>
                      <div className="text-sm text-white">{d.value}</div>
                    </div>
                  ))}
                </div>

                {/* Progress bar */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs text-gray-500">Overall Progress</span>
                    <span className="text-xs font-mono text-green-400">{activeProgress}%</span>
                  </div>
                  <div className="progress-track h-2">
                    <div className="progress-fill h-full" style={{ width: `${activeProgress}%` }} />
                  </div>
                </div>

                <button
                  onClick={() => navigate(`/batch/${activeBatch.id}/continue`)}
                  className="btn-primary text-sm py-2.5 px-5"
                >
                  Continue Process →
                </button>
              </div>
            ) : (
              <div className="text-center py-8">
                <div className="w-12 h-12 rounded-full bg-gray-800 border border-gray-700 flex items-center justify-center mx-auto mb-3">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-6 h-6 text-gray-600">
                    <circle cx="12" cy="12" r="9" />
                    <path d="M12 8v4M12 16h.01" strokeLinecap="round" />
                  </svg>
                </div>
                <div className="text-gray-400 font-medium mb-1">No Active Batch</div>
                <p className="text-gray-600 text-sm mb-4">Start a new biodiesel production batch to begin monitoring.</p>
                <Link to="/batch/new" className="btn-primary text-sm py-2.5 px-5">+ Start New Batch</Link>
              </div>
            )}
          </div>

          {/* Live monitoring */}
          <div className="glass rounded-2xl p-6 fade-in-up" style={{ animationDelay: '0.15s' }}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-display font-bold text-base text-white">Live Monitoring</h2>
              <SimBadge />
            </div>

            {activeBatch ? (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                {[
                  { label: 'Temperature', value: `${activeBatch.parameters?.temperature_target ?? '—'}°C`, sub: 'Target', color: 'text-orange-400' },
                  { label: 'Stirring', value: `${activeBatch.parameters?.stirring_speed ?? '—'} RPM`, sub: 'Active', color: 'text-blue-400' },
                  { label: 'Progress', value: `${activeProgress}%`, sub: 'Reaction', color: 'text-green-400' },
                  { label: 'Status', value: activeBatch.status, sub: '● Running', color: 'text-green-400' },
                ].map((m) => (
                  <div key={m.label} className="glass rounded-xl p-4" style={{ background: 'rgba(4,14,8,0.7)' }}>
                    <div className="gv-label">{m.label}</div>
                    <div className={`font-mono font-semibold text-base ${m.color}`}>{m.value}</div>
                    <div className="text-gray-600 text-[10px] mt-1">{m.sub}</div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-center py-6 text-gray-600 text-sm">
                No active batch. Start a batch to see live monitoring.
              </div>
            )}
          </div>
        </div>

        {/* Process timeline */}
        <div className="glass rounded-2xl p-6 fade-in-up" style={{ animationDelay: '0.12s' }}>
          <h2 className="font-display font-bold text-base text-white mb-4">Process Timeline</h2>
          {activeBatch ? (
            <ProcessTimeline stages={activeBatch.stages} compact />
          ) : (
            <div className="text-gray-600 text-sm text-center py-4">
              Start a batch to see the process timeline.
            </div>
          )}
        </div>
      </div>

      {/* Recent batches */}
      <div className="glass rounded-2xl fade-in-up" style={{ animationDelay: '0.2s' }}>
        <div className="flex items-center justify-between px-6 pt-5 pb-3">
          <h2 className="font-display font-bold text-base text-white">Recent Batches</h2>
          <Link to="/batches" className="text-green-400 text-xs hover:text-green-300 transition-colors font-medium">
            View All →
          </Link>
        </div>

        {recentBatches.length === 0 ? (
          <div className="px-6 pb-6 text-gray-600 text-sm text-center py-6">No batches yet.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="gv-table">
              <thead>
                <tr>
                  <th>Batch ID</th>
                  <th>Process</th>
                  <th>Status</th>
                  <th className="hidden sm:table-cell">Date</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {recentBatches.map((b) => (
                  <tr key={b.id}>
                    <td className="font-mono text-green-400 text-xs">{b.batch_code}</td>
                    <td className="text-gray-300 max-w-[140px] truncate">{b.process_type || '—'}</td>
                    <td><StatusBadge status={b.status} size="sm" /></td>
                    <td className="hidden sm:table-cell text-gray-500 text-xs">{formatDate(b.created_at)}</td>
                    <td>
                      <Link to={`/batches/${b.id}`} className="text-green-400 text-xs hover:text-green-300 font-medium transition-colors">
                        View
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
