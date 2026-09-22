import { useState } from 'react';
import { Link } from 'react-router';
import { useData } from '../contexts/DataContext';
import StatusBadge from '../components/StatusBadge';
import { formatDate, formatDuration } from '../lib/utils';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  ScatterChart, Scatter, Legend,
} from 'recharts';
import type { Batch } from '../lib/types';

// --- Stat summary ---
function RateSummary({ batches }: { batches: Batch[] }) {
  const total = batches.length;
  const completed = batches.filter((b) => b.status === 'Completed').length;
  const stopped = batches.filter((b) => b.status === 'Stopped').length;
  const errored = batches.filter((b) => b.status === 'Error').length;
  const failed = stopped + errored;
  const successRate = total > 0 ? Math.round((completed / total) * 100) : 0;
  const failRate = total > 0 ? Math.round((failed / total) * 100) : 0;

  const stats = [
    { label: 'Total Batches', value: total, color: 'text-white' },
    { label: 'Completed', value: completed, color: 'text-green-400' },
    { label: 'Failed / Stopped', value: failed, color: 'text-red-400' },
    { label: 'Success Rate', value: `${successRate}%`, color: 'text-green-400' },
    { label: 'Failure Rate', value: `${failRate}%`, color: 'text-red-400' },
  ];

  return (
    <div className="glass rounded-2xl p-5">
      <div className="flex items-center justify-between mb-4">
        <h2 className="font-display font-semibold text-base text-white">Production Performance</h2>
        <span className="text-[10px] text-gray-600 uppercase tracking-widest font-medium">Sample Data</span>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-4">
        {stats.map((s) => (
          <div key={s.label} className="rounded-xl p-3" style={{ background: 'rgba(4,14,8,0.6)', border: '1px solid rgba(255,255,255,0.06)' }}>
            <div className="text-gray-600 text-[10px] uppercase tracking-wider mb-1.5">{s.label}</div>
            <div className={`font-display font-bold text-xl ${s.color}`}>{s.value}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// --- Chart tooltip ---
const ChartTooltip = ({ active, payload, label }: { active?: boolean; payload?: Array<{ value: number; name?: string }>; label?: string }) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg px-3 py-2 text-xs" style={{ background: 'rgba(13,20,15,0.97)', border: '1px solid rgba(255,255,255,0.1)' }}>
      {label && <div className="text-gray-400 mb-1">{label}</div>}
      {payload.map((p, i) => (
        <div key={i} className="text-green-300 font-mono">{p.name ? `${p.name}: ` : ''}{p.value}</div>
      ))}
    </div>
  );
};

// --- Correlation analysis ---
function CorrelationAnalysis({ batches }: { batches: Batch[] }) {
  const completed = batches.filter((b) => b.status === 'Completed' && b.ffa_test);

  // FFA vs process selection — bar chart by process type
  const processCount: Record<string, { esterification: number; transesterification: number }> = {};
  for (const b of batches) {
    const pt = b.process_type ?? 'Unknown';
    if (!processCount[pt]) processCount[pt] = { esterification: 0, transesterification: 0 };
    if (pt.toLowerCase().includes('esterification') && !pt.toLowerCase().includes('trans')) {
      processCount[pt].esterification++;
    } else if (pt.toLowerCase().includes('trans')) {
      processCount[pt].transesterification++;
    }
  }

  const ffaGroups: Record<string, number> = {};
  for (const b of batches) {
    if (!b.ffa_test) continue;
    const pct = b.ffa_test.result;
    const bucket = pct <= 1 ? '≤1%' : pct <= 2 ? '1–2%' : pct <= 3 ? '2–3%' : pct <= 5 ? '3–5%' : '>5%';
    ffaGroups[bucket] = (ffaGroups[bucket] ?? 0) + 1;
  }
  const ffaData = ['≤1%', '1–2%', '2–3%', '3–5%', '>5%']
    .filter((k) => ffaGroups[k])
    .map((k) => ({ ffa: k, batches: ffaGroups[k] }));

  // Process type distribution
  const ptCounts: Record<string, number> = {};
  for (const b of batches) {
    const pt = b.process_type ?? 'Unknown';
    ptCounts[pt] = (ptCounts[pt] ?? 0) + 1;
  }
  const ptData = Object.entries(ptCounts).map(([name, count]) => ({ name, count }));

  // Temperature vs volume (scatter, completed batches with params)
  const scatterData = completed
    .filter((b) => b.parameters && b.initial_volume > 0)
    .map((b) => ({
      temp: b.parameters!.temperature_target,
      volume: b.initial_volume,
      name: b.batch_code,
    }));

  const axisStyle = { fill: '#6b7280', fontSize: 11 };
  const gridStyle = { stroke: 'rgba(255,255,255,0.04)' };

  return (
    <div className="glass rounded-2xl p-5 space-y-7">
      <div className="flex items-center justify-between">
        <h2 className="font-display font-semibold text-base text-white">Batch Correlations</h2>
        <span className="text-[10px] text-gray-600 uppercase tracking-widest font-medium">Sample Data</span>
      </div>

      <div className="grid md:grid-cols-2 gap-6">
        {/* FFA distribution */}
        <div>
          <div className="text-xs text-gray-500 mb-3 font-medium">FFA Result Distribution</div>
          {ffaData.length === 0 ? (
            <div className="text-gray-600 text-xs py-8 text-center">No FFA data available</div>
          ) : (
            <ResponsiveContainer width="100%" height={180}>
              <BarChart data={ffaData} margin={{ top: 4, right: 4, left: -24, bottom: 0 }}>
                <CartesianGrid vertical={false} strokeDasharray="3 3" {...gridStyle} />
                <XAxis dataKey="ffa" tick={axisStyle} axisLine={false} tickLine={false} />
                <YAxis tick={axisStyle} axisLine={false} tickLine={false} allowDecimals={false} />
                <Tooltip content={<ChartTooltip />} />
                <Bar dataKey="batches" fill="#16a34a" radius={[3, 3, 0, 0]} name="Batches" />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>

        {/* Process type distribution */}
        <div>
          <div className="text-xs text-gray-500 mb-3 font-medium">Process Type Usage</div>
          {ptData.length === 0 ? (
            <div className="text-gray-600 text-xs py-8 text-center">No process data available</div>
          ) : (
            <ResponsiveContainer width="100%" height={180}>
              <BarChart data={ptData} layout="vertical" margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                <CartesianGrid horizontal={false} strokeDasharray="3 3" {...gridStyle} />
                <XAxis type="number" tick={axisStyle} axisLine={false} tickLine={false} allowDecimals={false} />
                <YAxis type="category" dataKey="name" tick={{ ...axisStyle, fontSize: 10 }} axisLine={false} tickLine={false} width={110} />
                <Tooltip content={<ChartTooltip />} />
                <Bar dataKey="count" fill="#15803d" radius={[0, 3, 3, 0]} name="Count" />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>

        {/* Temperature vs volume scatter */}
        <div className="md:col-span-2">
          <div className="text-xs text-gray-500 mb-3 font-medium">Temperature Target vs Oil Volume (completed batches)</div>
          {scatterData.length < 2 ? (
            <div className="text-gray-600 text-xs py-8 text-center">
              {scatterData.length === 0 ? 'No completed batches with parameter data' : 'More completed batches needed for scatter analysis'}
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={180}>
              <ScatterChart margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" {...gridStyle} />
                <XAxis dataKey="temp" name="Temperature (°C)" tick={axisStyle} axisLine={false} tickLine={false} label={{ value: 'Temp (°C)', position: 'insideBottomRight', offset: -4, style: { fill: '#4b5563', fontSize: 10 } }} />
                <YAxis dataKey="volume" name="Volume (mL)" tick={axisStyle} axisLine={false} tickLine={false} label={{ value: 'Volume (mL)', angle: -90, position: 'insideLeft', style: { fill: '#4b5563', fontSize: 10 } }} />
                <Tooltip content={({ active, payload }) => {
                  if (!active || !payload?.length) return null;
                  const d = payload[0]?.payload as { temp: number; volume: number; name: string } | undefined;
                  if (!d) return null;
                  return (
                    <div className="rounded-lg px-3 py-2 text-xs" style={{ background: 'rgba(13,20,15,0.97)', border: '1px solid rgba(255,255,255,0.1)' }}>
                      <div className="text-gray-400 mb-1">{d.name}</div>
                      <div className="text-green-300 font-mono">Temp: {d.temp}°C</div>
                      <div className="text-green-300 font-mono">Volume: {d.volume} mL</div>
                    </div>
                  );
                }} />
                <Scatter data={scatterData} fill="#22c55e" fillOpacity={0.7} />
              </ScatterChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>
    </div>
  );
}

// --- Main page ---
export default function BatchHistory() {
  const { store } = useData();
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [processFilter, setProcessFilter] = useState('');

  const allBatches = [...store.batches].sort((a, b) => b.created_at.localeCompare(a.created_at));

  const filtered = allBatches.filter((b) => {
    if (search && !b.batch_code.toLowerCase().includes(search.toLowerCase())) return false;
    if (statusFilter && b.status !== statusFilter) return false;
    if (processFilter && b.process_type !== processFilter) return false;
    return true;
  });

  const processTypes = [...new Set(allBatches.map((b) => b.process_type).filter(Boolean))];
  const statuses = ['Draft', 'Ready', 'In Progress', 'Paused', 'Completed', 'Stopped', 'Error'];

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="font-display font-bold text-2xl text-white">Batch History</h1>
          <p className="text-gray-500 text-sm mt-0.5">{allBatches.length} total batches recorded</p>
        </div>
        <Link to="/batch/new" className="btn-primary text-sm self-start sm:self-auto">+ New Batch</Link>
      </div>

      {/* Performance summary */}
      <RateSummary batches={allBatches} />

      {/* Correlation analysis */}
      <CorrelationAnalysis batches={allBatches} />

      {/* Filters */}
      <div className="glass rounded-2xl p-4 flex flex-col sm:flex-row gap-3">
        <div className="flex-1">
          <input
            type="search"
            placeholder="Search by Batch ID…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="gv-input"
          />
        </div>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="gv-select sm:w-44">
          <option value="">All Statuses</option>
          {statuses.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select value={processFilter} onChange={(e) => setProcessFilter(e.target.value)} className="gv-select sm:w-56">
          <option value="">All Processes</option>
          {processTypes.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        {(search || statusFilter || processFilter) && (
          <button onClick={() => { setSearch(''); setStatusFilter(''); setProcessFilter(''); }} className="btn-ghost text-sm py-2 px-3 whitespace-nowrap">Clear</button>
        )}
      </div>

      {/* Table */}
      <div className="glass rounded-2xl overflow-hidden">
        {filtered.length === 0 ? (
          <div className="text-center py-16 text-gray-500">
            <div className="text-4xl mb-3">📋</div>
            <div className="font-medium">No batches found</div>
            <p className="text-sm text-gray-600 mt-1">Try adjusting your filters or start a new batch.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="gv-table">
              <thead>
                <tr>
                  <th>Batch ID</th>
                  <th>Process</th>
                  <th className="hidden md:table-cell">FFA Result</th>
                  <th className="hidden sm:table-cell">Volume</th>
                  <th className="hidden lg:table-cell">Duration</th>
                  <th>Status</th>
                  <th className="hidden sm:table-cell">Date</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((b) => (
                  <tr key={b.id}>
                    <td className="font-mono text-green-400 text-xs font-semibold">{b.batch_code}</td>
                    <td className="text-gray-300 text-xs max-w-[120px] truncate">{b.process_type || '—'}</td>
                    <td className="hidden md:table-cell text-gray-400 text-xs">{b.ffa_test ? `${b.ffa_test.result}%` : '—'}</td>
                    <td className="hidden sm:table-cell text-gray-400 text-xs">{b.initial_volume > 0 ? `${b.initial_volume} mL` : '—'}</td>
                    <td className="hidden lg:table-cell text-gray-400 text-xs">{b.duration ? formatDuration(b.duration) : '—'}</td>
                    <td><StatusBadge status={b.status} size="sm" /></td>
                    <td className="hidden sm:table-cell text-gray-500 text-xs">{formatDate(b.created_at)}</td>
                    <td>
                      <div className="flex items-center gap-2">
                        <Link to={`/batches/${b.id}`} className="text-green-400 text-xs hover:text-green-300 font-medium transition-colors">View</Link>
                        {(b.status === 'Draft' || b.status === 'Paused') && (
                          <Link to={`/batch/${b.id}/continue`} className="text-blue-400 text-xs hover:text-blue-300 font-medium transition-colors">Continue</Link>
                        )}
                        {b.status === 'Completed' && (
                          <Link to={`/reports?batch=${b.id}`} className="text-gray-400 text-xs hover:text-gray-300 font-medium transition-colors">Report</Link>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <p className="text-gray-600 text-xs">Showing {filtered.length} of {allBatches.length} batches</p>
    </div>
  );
}
