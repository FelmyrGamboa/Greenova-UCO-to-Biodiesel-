import { Link } from 'react-router';
import { useData } from '../../contexts/DataContext';
import { useAuth } from '../../contexts/AuthContext';
import { formatDateTime } from '../../lib/utils';
import StatusBadge from '../../components/StatusBadge';

export default function AdminDashboard() {
  const { store } = useData();
  const { user } = useAuth();

  const totalUsers = store.users.length;
  const activeUsers = store.users.filter((u) => u.account_status === 'active').length;
  const totalBatches = store.batches.length;
  const completedBatches = store.batches.filter((b) => b.status === 'Completed').length;
  const activeBatches = store.batches.filter((b) => b.status === 'In Progress').length;
  const unacknowledgedAlerts = store.alerts.filter((a) => !a.acknowledged).length;

  const recentLogs = store.audit_logs
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    .slice(0, 6);

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <div>
        <div className="flex items-center gap-2 mb-1">
          <svg viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5 text-green-400">
            <path fillRule="evenodd" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" clipRule="evenodd" />
          </svg>
          <span className="text-green-400 text-xs font-semibold uppercase tracking-wider">Administrator Panel</span>
        </div>
        <h1 className="font-display font-bold text-2xl text-white">Admin Dashboard</h1>
        <p className="text-gray-500 text-sm mt-0.5">System overview and management</p>
      </div>

      {/* Quick links */}
      <div className="flex flex-wrap gap-3">
        <Link to="/admin/users" className="btn-secondary text-sm py-2 px-4">Manage Users</Link>
        <Link to="/admin/configuration" className="btn-secondary text-sm py-2 px-4">Process Configuration</Link>
        <Link to="/admin/logs" className="btn-secondary text-sm py-2 px-4">Audit Logs</Link>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
        {[
          { label: 'Total Users', value: totalUsers, color: 'text-white', icon: '👥' },
          { label: 'Active Users', value: activeUsers, color: 'text-green-400', icon: '✅' },
          { label: 'Total Batches', value: totalBatches, color: 'text-white', icon: '📋' },
          { label: 'Completed Batches', value: completedBatches, color: 'text-green-400', icon: '✓' },
          { label: 'Active Processes', value: activeBatches, color: 'text-blue-400', icon: '▶' },
          { label: 'Unacknowledged Alerts', value: unacknowledgedAlerts, color: unacknowledgedAlerts > 0 ? 'text-yellow-400' : 'text-gray-500', icon: '⚠' },
        ].map((s) => (
          <div key={s.label} className="glass rounded-2xl p-5">
            <div className="text-2xl mb-1">{s.icon}</div>
            <div className={`font-display font-bold text-2xl ${s.color}`}>{s.value}</div>
            <div className="text-gray-500 text-xs mt-0.5">{s.label}</div>
          </div>
        ))}
      </div>

      {/* Users */}
      <div className="glass rounded-2xl">
        <div className="flex items-center justify-between px-6 pt-5 pb-3">
          <h2 className="font-display font-semibold text-white">Users</h2>
          <Link to="/admin/users" className="text-green-400 text-xs hover:text-green-300">Manage All →</Link>
        </div>
        <div className="overflow-x-auto">
          <table className="gv-table">
            <thead>
              <tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th></tr>
            </thead>
            <tbody>
              {store.users.map((u) => (
                <tr key={u.id}>
                  <td className="text-white font-medium">{u.full_name}</td>
                  <td className="text-gray-400 text-xs">{u.email}</td>
                  <td className="text-gray-300 text-xs">{u.role}</td>
                  <td><StatusBadge status={u.account_status} size="sm" /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Recent audit logs */}
      <div className="glass rounded-2xl p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-display font-semibold text-white">Recent Activity</h2>
          <Link to="/admin/logs" className="text-green-400 text-xs hover:text-green-300">View All →</Link>
        </div>
        <div className="space-y-2">
          {recentLogs.map((log) => (
            <div key={log.id} className="flex items-center gap-3 text-xs py-2 border-b" style={{ borderColor: 'rgba(34,197,94,0.05)' }}>
              <div className="text-gray-600 font-mono whitespace-nowrap">{formatDateTime(log.timestamp)}</div>
              <div className="text-green-400 font-medium whitespace-nowrap">{log.event_type}</div>
              <div className="text-gray-400 flex-1 truncate">{log.description}</div>
              <div className="text-gray-600 whitespace-nowrap">{log.user_name}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
