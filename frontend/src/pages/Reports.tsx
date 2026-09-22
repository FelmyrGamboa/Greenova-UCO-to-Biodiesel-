import { useState } from 'react';
import { useSearchParams, Link } from 'react-router';
import { useData } from '../contexts/DataContext';
import { useToast } from '../contexts/ToastContext';
import StatusBadge from '../components/StatusBadge';
import { formatDate, formatDateTime, formatDuration } from '../lib/utils';

export default function Reports() {
  const { store } = useData();
  const { toast } = useToast();
  const [searchParams] = useSearchParams();
  const preselectedBatch = searchParams.get('batch');
  const [selectedBatch, setSelectedBatch] = useState(preselectedBatch ?? '');
  const [reportType, setReportType] = useState<'individual' | 'summary'>('individual');

  const completedBatches = store.batches.filter((b) => b.status === 'Completed');
  const batch = store.batches.find((b) => b.id === selectedBatch);
  const batchUser = batch ? store.users.find((u) => u.id === batch.user_id) : null;

  const totalBatches = store.batches.length;
  const completedCount = completedBatches.length;
  const stoppedCount = store.batches.filter((b) => b.status === 'Stopped').length;
  const avgDuration = completedBatches.length
    ? Math.round(completedBatches.reduce((a, b) => a + (b.duration ?? 0), 0) / completedBatches.length)
    : 0;
  const totalVolume = completedBatches.reduce((a, b) => a + b.initial_volume, 0);
  const processCounts: Record<string, number> = {};
  completedBatches.forEach((b) => { if (b.process_type) processCounts[b.process_type] = (processCounts[b.process_type] ?? 0) + 1; });
  const mostUsed = Object.entries(processCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '—';

  function handleGenerate() {
    toast('Report generated. PDF export requires a print dialog.', 'info');
    setTimeout(() => window.print(), 300);
  }

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-display font-bold text-2xl text-white">Reports</h1>
          <p className="text-gray-500 text-sm mt-0.5">Generate and view production reports</p>
        </div>
      </div>

      {/* Report type selector */}
      <div className="glass rounded-2xl p-4 flex gap-3">
        {([['individual', 'Individual Batch Report'], ['summary', 'Production Summary']] as const).map(([type, label]) => (
          <button
            key={type}
            onClick={() => setReportType(type)}
            className={`px-4 py-2 rounded-xl text-sm font-medium transition-all ${reportType === type ? 'bg-green-500 text-black' : 'glass text-gray-400 hover:text-gray-200'}`}
          >
            {label}
          </button>
        ))}
      </div>

      {reportType === 'individual' ? (
        <div className="space-y-5">
          {/* Batch selector */}
          <div className="glass rounded-2xl p-4">
            <label className="gv-label">Select Batch</label>
            <select value={selectedBatch} onChange={(e) => setSelectedBatch(e.target.value)} className="gv-select">
              <option value="">— Select a completed batch —</option>
              {completedBatches.map((b) => (
                <option key={b.id} value={b.id}>{b.batch_code} — {formatDate(b.created_at)}</option>
              ))}
            </select>
          </div>

          {batch ? (
            <div className="glass rounded-2xl">
              {/* Report header */}
              <div className="p-6 border-b" style={{ borderColor: 'rgba(34,197,94,0.1)' }}>
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <div className="flex items-center gap-3 mb-2">
                      <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: 'linear-gradient(135deg, #16a34a, #22c55e)' }}>
                        <svg viewBox="0 0 24 24" fill="none" className="w-5 h-5"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 15v-4H7l5-8v4h4l-5 8z" fill="white" /></svg>
                      </div>
                      <div>
                        <div className="font-display font-extrabold text-green-400 tracking-wider">GREENOVA</div>
                        <div className="text-gray-500 text-xs">Biodiesel Production Monitoring Report</div>
                      </div>
                    </div>
                    <div className="text-gray-600 text-xs">Generated: {formatDateTime(new Date().toISOString())}</div>
                  </div>
                  <StatusBadge status={batch.status} />
                </div>
              </div>

              <div className="p-6 space-y-6">
                {/* Batch info */}
                <div>
                  <h3 className="font-display font-bold text-white text-sm mb-3 uppercase tracking-wider">Batch Information</h3>
                  <div className="grid sm:grid-cols-2 gap-3 text-sm">
                    <div><span className="text-gray-500">Batch ID: </span><span className="font-mono text-green-400">{batch.batch_code}</span></div>
                    <div><span className="text-gray-500">Operator: </span><span className="text-white">{batchUser?.full_name ?? '—'}</span></div>
                    <div><span className="text-gray-500">Started: </span><span className="text-white">{batch.started_at ? formatDateTime(batch.started_at) : '—'}</span></div>
                    <div><span className="text-gray-500">Completed: </span><span className="text-white">{batch.completed_at ? formatDateTime(batch.completed_at) : '—'}</span></div>
                    <div><span className="text-gray-500">Duration: </span><span className="text-white">{batch.duration ? formatDuration(batch.duration) : '—'}</span></div>
                    <div><span className="text-gray-500">Final Status: </span><StatusBadge status={batch.status} size="sm" /></div>
                  </div>
                </div>

                <hr style={{ borderColor: 'rgba(34,197,94,0.1)' }} />

                {/* FFA */}
                {batch.ffa_test && (
                  <div>
                    <h3 className="font-display font-bold text-white text-sm mb-3 uppercase tracking-wider">FFA Test</h3>
                    <div className="grid sm:grid-cols-3 gap-3 text-sm">
                      <div><span className="text-gray-500">Result: </span><span className="font-mono text-green-400 font-bold">{batch.ffa_test.result}%</span></div>
                      <div><span className="text-gray-500">Classification: </span><span className="text-white">{batch.ffa_test.classification}</span></div>
                      <div><span className="text-gray-500">Process Selected: </span><span className="text-white">{batch.process_type}</span></div>
                    </div>
                  </div>
                )}

                <hr style={{ borderColor: 'rgba(34,197,94,0.1)' }} />

                {/* Parameters */}
                {batch.parameters && (
                  <div>
                    <h3 className="font-display font-bold text-white text-sm mb-3 uppercase tracking-wider">Parameter Summary</h3>
                    <div className="grid grid-cols-3 gap-3 text-sm">
                      <div><span className="text-gray-500">Temperature: </span><span className="font-mono text-orange-400">{batch.parameters.temperature_target}°C</span></div>
                      <div><span className="text-gray-500">Duration: </span><span className="font-mono text-blue-400">{batch.parameters.reaction_duration} min</span></div>
                      <div><span className="text-gray-500">Stirring: </span><span className="font-mono text-purple-400">{batch.parameters.stirring_speed} RPM</span></div>
                    </div>
                    <div className="mt-2 text-xs text-gray-500">
                      Preset: {batch.parameters.preset_type === 'default' ? 'Research-Approved Default' : 'Custom (validated)'}
                    </div>
                  </div>
                )}

                <hr style={{ borderColor: 'rgba(34,197,94,0.1)' }} />

                {/* Stage Timeline */}
                <div>
                  <h3 className="font-display font-bold text-white text-sm mb-3 uppercase tracking-wider">Stage Timeline</h3>
                  <div className="space-y-2">
                    {batch.stages.map((s) => (
                      <div key={s.stage_number} className="flex items-center gap-3 text-xs">
                        <div className={`w-2 h-2 rounded-full flex-shrink-0 ${s.status === 'completed' ? 'bg-green-400' : s.status === 'current' ? 'bg-blue-400' : 'bg-gray-700'}`} />
                        <span className="text-gray-400 w-4">{s.stage_number}.</span>
                        <span className={`flex-1 ${s.status === 'completed' ? 'text-green-400' : 'text-gray-600'}`}>{s.stage_name}</span>
                        {s.completed_at && <span className="text-gray-600">{formatDateTime(s.completed_at)}</span>}
                      </div>
                    ))}
                  </div>
                </div>

                <hr style={{ borderColor: 'rgba(34,197,94,0.1)' }} />

                {/* Quality */}
                <div className="glass rounded-xl p-4 border border-yellow-500/15">
                  <div className="text-yellow-400 text-xs font-semibold mb-1">Laboratory Quality Results</div>
                  <p className="text-gray-500 text-xs">Quality testing pending — results must be entered by laboratory personnel following approved analytical procedures.</p>
                </div>

                <div className="text-xs text-gray-600 border-t pt-4" style={{ borderColor: 'rgba(34,197,94,0.1)' }}>
                  <p>System-recorded data · Greenova v1.0 · © 2026</p>
                  <p className="mt-1">This report is generated from system-recorded data. Simulation data is clearly labeled. Researcher-entered values are noted as such.</p>
                </div>
              </div>
            </div>
          ) : (
            <div className="glass rounded-2xl py-12 text-center text-gray-500">
              <div className="text-4xl mb-3">📄</div>
              <div className="font-medium">Select a batch to generate a report</div>
            </div>
          )}

          {batch && (
            <div className="flex gap-3">
              <button onClick={handleGenerate} className="btn-primary text-sm">
                <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                  <path fillRule="evenodd" d="M3 17a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm3.293-7.707a1 1 0 011.414 0L9 10.586V3a1 1 0 112 0v7.586l1.293-1.293a1 1 0 111.414 1.414l-3 3a1 1 0 01-1.414 0l-3-3a1 1 0 010-1.414z" clipRule="evenodd" />
                </svg>
                Generate PDF / Print
              </button>
              <Link to={`/batches/${batch.id}`} className="btn-secondary text-sm">View Full Details</Link>
            </div>
          )}
        </div>
      ) : (
        /* Summary report */
        <div className="space-y-5">
          <div className="glass rounded-2xl p-6">
            <h2 className="font-display font-bold text-white mb-5">Production Summary Report</h2>
            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {[
                { label: 'Total Batches', value: totalBatches, color: 'text-white' },
                { label: 'Completed', value: completedCount, color: 'text-green-400' },
                { label: 'Stopped', value: stoppedCount, color: 'text-red-400' },
                { label: 'Avg Duration', value: avgDuration ? `${avgDuration} min` : '—', color: 'text-blue-400' },
                { label: 'Total Oil Volume', value: totalVolume > 0 ? `${totalVolume} mL` : '—', color: 'text-purple-400' },
                { label: 'Most Used Process', value: mostUsed, color: 'text-yellow-400' },
              ].map((s) => (
                <div key={s.label} className="glass rounded-xl p-4">
                  <div className="gv-label">{s.label}</div>
                  <div className={`font-display font-bold text-xl ${s.color} mt-1`}>{s.value}</div>
                </div>
              ))}
            </div>
          </div>

          <div className="glass rounded-2xl p-6">
            <h3 className="font-display font-semibold text-white mb-4">Recent Activity</h3>
            {completedBatches.length === 0 ? (
              <p className="text-gray-500 text-sm">No completed batches yet.</p>
            ) : (
              <div className="space-y-2">
                {completedBatches.slice(0, 8).map((b) => (
                  <div key={b.id} className="flex items-center gap-3 text-sm py-2 border-b" style={{ borderColor: 'rgba(34,197,94,0.05)' }}>
                    <span className="font-mono text-green-400 text-xs">{b.batch_code}</span>
                    <span className="text-gray-400 flex-1">{b.process_type}</span>
                    <span className="text-gray-500 text-xs">{formatDate(b.completed_at ?? b.created_at)}</span>
                    <StatusBadge status={b.status} size="sm" />
                  </div>
                ))}
              </div>
            )}
          </div>

          <button onClick={handleGenerate} className="btn-primary text-sm">Generate PDF / Print</button>
        </div>
      )}
    </div>
  );
}
