import { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router';
import { useData } from '../contexts/DataContext';
import StatusBadge from '../components/StatusBadge';
import ProcessTimeline from '../components/ProcessTimeline';
import SimBadge from '../components/SimBadge';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';

interface DataPoint {
  time: string;
  temperature: number;
  stirring: number;
  progress: number;
}

export default function Monitor() {
  const { getActiveBatch } = useData();
  const activeBatch = getActiveBatch();
  const [data, setData] = useState<DataPoint[]>([]);
  const [elapsed, setElapsed] = useState(0);
  const tickRef = useRef(0);

  const targetTemp = activeBatch?.parameters?.temperature_target ?? 60;
  const targetStirring = activeBatch?.parameters?.stirring_speed ?? 450;
  const totalDuration = (activeBatch?.parameters?.reaction_duration ?? 60) * 60;

  useEffect(() => {
    if (!activeBatch) return;
    const id = setInterval(() => {
      tickRef.current++;
      const t = tickRef.current;
      const simTemp = Math.min(targetTemp, 22 + (targetTemp - 22) * Math.min(1, t / 30)) + (Math.random() - 0.5) * 0.5;
      const simStir = targetStirring + (Math.random() - 0.5) * 10;
      const pct = Math.min(100, Math.round((t / (totalDuration / 10)) * 100));
      const point: DataPoint = {
        time: `${t * 10}s`,
        temperature: +simTemp.toFixed(1),
        stirring: +simStir.toFixed(0),
        progress: pct,
      };
      setData((prev) => [...prev.slice(-30), point]);
      setElapsed((e) => e + 10);
    }, 1000);
    return () => clearInterval(id);
  }, [activeBatch?.id, targetTemp, targetStirring, totalDuration]);

  const latest = data[data.length - 1];

  if (!activeBatch) {
    return (
      <div className="p-6 max-w-3xl mx-auto text-center">
        <div className="glass rounded-2xl p-12">
          <div className="w-16 h-16 rounded-full border border-gray-700 flex items-center justify-center mx-auto mb-4">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-8 h-8 text-gray-600">
              <path d="M9 3H5a2 2 0 00-2 2v4m6-6h10a2 2 0 012 2v4M9 3v18m0 0h10a2 2 0 002-2V9M9 21H5a2 2 0 01-2-2V9m0 0h18" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          <h2 className="font-display font-bold text-xl text-white mb-2">No Active Process</h2>
          <p className="text-gray-500 text-sm mb-6">Start a batch to begin live monitoring.</p>
          <Link to="/batch/new" className="btn-primary">+ Start New Batch</Link>
        </div>
      </div>
    );
  }

  const fmt = (s: number) => [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map((v) => String(v).padStart(2, '0')).join(':');
  const currentProgress = latest?.progress ?? Math.round(((activeBatch.current_step - 1) / 12) * 100);
  const currentStageName = activeBatch.stages.find((s) => s.status === 'current')?.stage_name ?? '—';

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="font-display font-bold text-2xl text-white">Live Process Monitoring</h1>
          <div className="flex items-center gap-3 mt-1">
            <span className="font-mono text-green-400 text-sm">{activeBatch.batch_code}</span>
            <StatusBadge status={activeBatch.status} size="sm" />
            <SimBadge />
          </div>
        </div>
        <Link to={`/batch/${activeBatch.id}/continue`} className="btn-primary text-sm">Continue Process →</Link>
      </div>

      <div className="grid lg:grid-cols-3 gap-6">
        {/* Live params */}
        <div className="lg:col-span-2 space-y-5">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            {[
              { label: 'Temperature', value: latest ? `${latest.temperature}°C` : `${targetTemp}°C`, sub: 'Target', color: 'text-orange-400' },
              { label: 'Stirring', value: latest ? `${latest.stirring} RPM` : `${targetStirring} RPM`, sub: 'Active', color: 'text-blue-400' },
              { label: 'Elapsed', value: fmt(elapsed), sub: 'Running', color: 'text-white' },
              { label: 'Progress', value: `${currentProgress}%`, sub: currentStageName, color: 'text-green-400' },
            ].map((m) => (
              <div key={m.label} className="glass rounded-2xl p-4">
                <div className="gv-label">{m.label}</div>
                <div className={`font-mono font-bold text-xl ${m.color}`}>{m.value}</div>
                <div className="text-gray-600 text-xs mt-1">{m.sub}</div>
              </div>
            ))}
          </div>

          {/* Overall progress */}
          <div className="glass rounded-2xl p-5">
            <div className="flex items-center justify-between mb-3">
              <span className="text-sm text-white font-medium">Overall Progress</span>
              <span className="font-mono text-green-400 text-sm">{currentProgress}%</span>
            </div>
            <div className="progress-track h-3">
              <div className="progress-fill h-full" style={{ width: `${currentProgress}%` }} />
            </div>
          </div>

          {/* Charts */}
          {data.length > 2 && (
            <div className="glass rounded-2xl p-5 space-y-5">
              <h3 className="font-display font-semibold text-white text-sm">Temperature vs Time <span className="text-yellow-400 text-xs font-normal">(Simulation Data)</span></h3>
              <ResponsiveContainer width="100%" height={180}>
                <LineChart data={data} margin={{ top: 5, right: 10, left: -15, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(34,197,94,0.06)" />
                  <XAxis dataKey="time" tick={{ fill: '#6b7280', fontSize: 10 }} />
                  <YAxis tick={{ fill: '#6b7280', fontSize: 10 }} domain={[20, targetTemp + 5]} />
                  <Tooltip contentStyle={{ background: '#071410', border: '1px solid rgba(34,197,94,0.2)', borderRadius: 8, color: '#f0fdf4', fontSize: 12 }} />
                  <Line type="monotone" dataKey="temperature" stroke="#f97316" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>

              <h3 className="font-display font-semibold text-white text-sm">Process Progress vs Time <span className="text-yellow-400 text-xs font-normal">(Simulation Data)</span></h3>
              <ResponsiveContainer width="100%" height={150}>
                <LineChart data={data} margin={{ top: 5, right: 10, left: -15, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(34,197,94,0.06)" />
                  <XAxis dataKey="time" tick={{ fill: '#6b7280', fontSize: 10 }} />
                  <YAxis tick={{ fill: '#6b7280', fontSize: 10 }} domain={[0, 100]} />
                  <Tooltip contentStyle={{ background: '#071410', border: '1px solid rgba(34,197,94,0.2)', borderRadius: 8, color: '#f0fdf4', fontSize: 12 }} />
                  <Line type="monotone" dataKey="progress" stroke="#22c55e" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}

          {data.length <= 2 && (
            <div className="glass rounded-2xl p-8 text-center text-gray-500 text-sm">
              <div className="w-2 h-2 rounded-full bg-blue-400 gv-pulse mx-auto mb-3" />
              Collecting simulation data…
            </div>
          )}
        </div>

        {/* Timeline */}
        <div className="glass rounded-2xl p-5">
          <h3 className="font-display font-semibold text-white mb-4">Process Timeline</h3>
          <ProcessTimeline stages={activeBatch.stages} compact />
        </div>
      </div>
    </div>
  );
}
