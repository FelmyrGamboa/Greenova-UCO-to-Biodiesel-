import { useParams, Link } from 'react-router';
import { useData } from '../contexts/DataContext';
import { useAuth } from '../contexts/AuthContext';
import StatusBadge from '../components/StatusBadge';
import ProcessTimeline from '../components/ProcessTimeline';
import { formatDateTime, formatDuration } from '../lib/utils';

export default function BatchDetails() {
  const { batchId } = useParams();
  const { getBatch, getAuditLogs, store } = useData();
  const { user } = useAuth();

  const batch = getBatch(batchId ?? '');
  const auditLogs = getAuditLogs().filter((l) => l.batch_id === batchId);
  const batchUser = store.users.find((u) => u.id === batch?.user_id);

  if (!batch) {
    return (
      <div className="p-6 text-center text-gray-500">
        <div className="text-4xl mb-3">🔍</div>
        <div>Batch not found.</div>
        <Link to="/batches" className="btn-secondary text-sm mt-4 inline-flex">← Back to Batches</Link>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-3 mb-1">
            <Link to="/batches" className="text-gray-500 hover:text-green-400 transition-colors">
              <svg viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5">
                <path fillRule="evenodd" d="M9.707 16.707a1 1 0 01-1.414 0l-6-6a1 1 0 010-1.414l6-6a1 1 0 011.414 1.414L5.414 9H17a1 1 0 110 2H5.414l4.293 4.293a1 1 0 010 1.414z" clipRule="evenodd" />
              </svg>
            </Link>
            <h1 className="font-display font-bold text-2xl text-white">{batch.batch_code}</h1>
            <StatusBadge status={batch.status} />
          </div>
          <p className="text-gray-500 text-sm">Created {formatDateTime(batch.created_at)} · by {batchUser?.full_name ?? '—'}</p>
        </div>
        <div className="flex gap-2">
          {(batch.status === 'Draft' || batch.status === 'Paused') && (
            <Link to={`/batch/${batch.id}/continue`} className="btn-primary text-sm py-2 px-4">Continue Process</Link>
          )}
          {batch.status === 'Completed' && (
            <Link to={`/reports?batch=${batch.id}`} className="btn-secondary text-sm py-2 px-4">View Report</Link>
          )}
        </div>
      </div>

      <div className="grid lg:grid-cols-3 gap-6">
        {/* Left column */}
        <div className="lg:col-span-2 space-y-5">
          {/* Batch info */}
          <div className="glass rounded-2xl p-5">
            <h2 className="font-display font-semibold text-white mb-4">Batch Information</h2>
            <div className="grid sm:grid-cols-2 gap-4 text-sm">
              <div><div className="gv-label">Batch Code</div><div className="font-mono text-green-400 font-semibold">{batch.batch_code}</div></div>
              <div><div className="gv-label">Status</div><StatusBadge status={batch.status} size="sm" /></div>
              <div><div className="gv-label">Operator</div><div className="text-white">{batchUser?.full_name ?? '—'}</div></div>
              <div><div className="gv-label">Started</div><div className="text-white">{batch.started_at ? formatDateTime(batch.started_at) : '—'}</div></div>
              {batch.completed_at && <div><div className="gv-label">Completed</div><div className="text-white">{formatDateTime(batch.completed_at)}</div></div>}
              {batch.duration && <div><div className="gv-label">Duration</div><div className="text-white">{formatDuration(batch.duration)}</div></div>}
            </div>
          </div>

          {/* Process info */}
          <div className="glass rounded-2xl p-5">
            <h2 className="font-display font-semibold text-white mb-4">Process Information</h2>
            <div className="grid sm:grid-cols-2 gap-4 text-sm">
              <div><div className="gv-label">Process Type</div><div className="text-white">{batch.process_type || '—'}</div></div>
              {batch.override_reason && (
                <div className="sm:col-span-2">
                  <div className="gv-label">Override Reason</div>
                  <div className="text-yellow-400 text-sm">{batch.override_reason}</div>
                </div>
              )}
              <div><div className="gv-label">Oil Volume</div><div className="text-white">{batch.initial_volume > 0 ? `${batch.initial_volume} mL` : '—'}</div></div>
              <div><div className="gv-label">Methanol Ratio</div><div className="text-white">{batch.methanol_ratio || '—'}</div></div>
              <div><div className="gv-label">Catalyst %</div><div className="text-white">{batch.catalyst_percentage ? `${batch.catalyst_percentage} wt%` : '—'}</div></div>
            </div>
          </div>

          {/* FFA Testing */}
          {batch.ffa_test && (
            <div className="glass rounded-2xl p-5">
              <h2 className="font-display font-semibold text-white mb-4">FFA Testing</h2>
              <div className="grid sm:grid-cols-3 gap-4 text-sm">
                <div><div className="gv-label">Result</div><div className="font-mono text-green-400 text-lg font-bold">{batch.ffa_test.result}%</div></div>
                <div><div className="gv-label">Classification</div><div className="text-white">{batch.ffa_test.classification}</div></div>
                <div><div className="gv-label">Recommended Process</div><div className="text-green-400 font-medium">{batch.ffa_test.recommended_process}</div></div>
                <div><div className="gv-label">Recorded</div><div className="text-gray-400">{formatDateTime(batch.ffa_test.recorded_at)}</div></div>
              </div>
            </div>
          )}

          {/* Parameters */}
          {batch.parameters && (
            <div className="glass rounded-2xl p-5">
              <h2 className="font-display font-semibold text-white mb-4">Process Parameters</h2>
              <div className="grid grid-cols-3 gap-4 text-sm">
                <div><div className="gv-label">Temperature</div><div className="font-mono text-orange-400 font-semibold">{batch.parameters.temperature_target}°C</div></div>
                <div><div className="gv-label">Duration</div><div className="font-mono text-blue-400 font-semibold">{batch.parameters.reaction_duration} min</div></div>
                <div><div className="gv-label">Stirring Speed</div><div className="font-mono text-purple-400 font-semibold">{batch.parameters.stirring_speed} RPM</div></div>
              </div>
              <div className="mt-3">
                <span className={`text-xs px-2 py-1 rounded-full font-medium ${batch.parameters.preset_type === 'default' ? 'text-green-400 bg-green-400/10' : 'text-yellow-400 bg-yellow-400/10'}`}>
                  {batch.parameters.preset_type === 'default' ? '✓ Research-Approved Preset' : '⚠ Custom Parameters'}
                </span>
              </div>
            </div>
          )}

          {/* Preparation checklist */}
          {batch.preparation_checklist.length > 0 && (
            <div className="glass rounded-2xl p-5">
              <h2 className="font-display font-semibold text-white mb-4">Preparation Checklist</h2>
              <div className="space-y-2">
                {batch.preparation_checklist.map((item) => (
                  <div key={item.id} className="flex items-center gap-3 text-sm">
                    <div className={`w-5 h-5 rounded flex items-center justify-center flex-shrink-0 ${item.completed ? 'bg-green-500' : 'border border-gray-700'}`}>
                      {item.completed && (
                        <svg viewBox="0 0 20 20" fill="currentColor" className="w-3 h-3 text-black">
                          <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                        </svg>
                      )}
                    </div>
                    <span className={item.completed ? 'text-green-400' : 'text-gray-500'}>{item.label}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Audit log */}
          {auditLogs.length > 0 && (
            <div className="glass rounded-2xl p-5">
              <h2 className="font-display font-semibold text-white mb-4">Audit Log</h2>
              <div className="space-y-2">
                {auditLogs.map((log) => (
                  <div key={log.id} className="flex items-start gap-3 text-xs py-2 border-b" style={{ borderColor: 'rgba(34,197,94,0.05)' }}>
                    <div className="text-gray-600 font-mono whitespace-nowrap">{formatDateTime(log.timestamp)}</div>
                    <div className="text-green-400 font-medium whitespace-nowrap">{log.event_type}</div>
                    <div className="text-gray-400">{log.description}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Right column — timeline */}
        <div className="glass rounded-2xl p-5 h-fit">
          <h2 className="font-display font-semibold text-white mb-4">Process Timeline</h2>
          <ProcessTimeline stages={batch.stages} />
        </div>
      </div>
    </div>
  );
}
