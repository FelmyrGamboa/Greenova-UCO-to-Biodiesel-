import { useState } from 'react';
import { useData } from '../../contexts/DataContext';
import { formatDateTime } from '../../lib/utils';
import type { AuditEventType } from '../../lib/types';

const EVENT_TYPES: AuditEventType[] = [
  'Login', 'Logout', 'Batch Created', 'Batch Updated', 'Batch Completed',
  'Batch Stopped', 'Stage Completed', 'Parameter Changed', 'Process Paused',
  'Process Resumed', 'Override Logged', 'Report Generated', 'Config Changed',
  'User Created', 'User Updated', 'Password Changed',
];

export default function AdminLogs() {
  const { getAuditLogs, store } = useData();
  const [userFilter, setUserFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [search, setSearch] = useState('');

  const logs = getAuditLogs();

  const filtered = logs.filter((l) => {
    if (userFilter && l.user_id !== userFilter) return false;
    if (typeFilter && l.event_type !== typeFilter) return false;
    if (search && !l.description.toLowerCase().includes(search.toLowerCase()) && !l.event_type.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const eventColors: Partial<Record<AuditEventType, string>> = {
    Login: 'text-green-400',
    Logout: 'text-gray-400',
    'Batch Completed': 'text-green-400',
    'Batch Stopped': 'text-red-400',
    'Config Changed': 'text-yellow-400',
    'Override Logged': 'text-yellow-400',
    'User Created': 'text-blue-400',
  };

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <div>
        <h1 className="font-display font-bold text-2xl text-white">System Logs</h1>
        <p className="text-gray-500 text-sm mt-0.5">{logs.length} total audit records</p>
      </div>

      {/* Filters */}
      <div className="glass rounded-2xl p-4 flex flex-wrap gap-3">
        <input type="search" placeholder="Search logs…" value={search} onChange={(e) => setSearch(e.target.value)} className="gv-input flex-1 min-w-48" />
        <select value={userFilter} onChange={(e) => setUserFilter(e.target.value)} className="gv-select w-auto min-w-44">
          <option value="">All Users</option>
          {store.users.map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}
        </select>
        <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} className="gv-select w-auto min-w-44">
          <option value="">All Event Types</option>
          {EVENT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        {(userFilter || typeFilter || search) && (
          <button onClick={() => { setUserFilter(''); setTypeFilter(''); setSearch(''); }} className="btn-ghost text-sm py-2 px-3">Clear</button>
        )}
      </div>

      {/* Log table */}
      <div className="glass rounded-2xl overflow-hidden">
        {filtered.length === 0 ? (
          <div className="text-center py-12 text-gray-500">No log entries found.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="gv-table">
              <thead>
                <tr>
                  <th>Timestamp</th>
                  <th>Event</th>
                  <th>User</th>
                  <th>Description</th>
                  <th className="hidden md:table-cell">Batch</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((log) => (
                  <tr key={log.id}>
                    <td className="text-gray-500 text-xs font-mono whitespace-nowrap">{formatDateTime(log.timestamp)}</td>
                    <td>
                      <span className={`text-xs font-medium ${eventColors[log.event_type] ?? 'text-gray-400'}`}>
                        {log.event_type}
                      </span>
                    </td>
                    <td className="text-gray-300 text-xs">{log.user_name}</td>
                    <td className="text-gray-400 text-xs max-w-xs truncate">{log.description}</td>
                    <td className="hidden md:table-cell text-gray-600 text-xs font-mono">{log.batch_id ? log.batch_id.slice(0, 10) + '…' : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <p className="text-gray-600 text-xs">Showing {filtered.length} of {logs.length} records</p>
    </div>
  );
}
