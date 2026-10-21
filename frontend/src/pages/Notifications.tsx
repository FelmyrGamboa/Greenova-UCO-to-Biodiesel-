import { useAuth } from '../contexts/AuthContext';
import { useData } from '../contexts/DataContext';
import { formatDateTime, severityColor } from '../lib/utils';

const categoryIcons: Record<string, React.ReactNode> = {
  'Process Update': <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4"><path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-12a1 1 0 10-2 0v4a1 1 0 00.293.707l2.828 2.829a1 1 0 101.415-1.415L11 9.586V6z" clipRule="evenodd" /></svg>,
  'Process Complete': <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4"><path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" /></svg>,
  'Parameter Warning': <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4"><path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" /></svg>,
  'System Warning': <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4"><path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" /></svg>,
  'System Connection': <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4"><path fillRule="evenodd" d="M17.778 8.222c-4.296-4.296-11.26-4.296-15.556 0A1 1 0 00.808 9.636a9.994 9.994 0 0114.142 0 1 1 0 001.414 0 1 1 0 000-1.414zm-2.829 2.828c-2.731-2.73-7.159-2.73-9.89 0a1 1 0 101.415 1.414 5.995 5.995 0 018.484 0 1 1 0 001.414-1.414l-.001-.001zm-2.828 2.83a3.997 3.997 0 00-5.657 0 1 1 0 001.414 1.414 1.998 1.998 0 012.829 0 1 1 0 001.414-1.414zM10 14a1 1 0 110 2 1 1 0 010-2z" clipRule="evenodd" /></svg>,
  default: <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4"><path d="M10 2a6 6 0 00-6 6v3.586l-.707.707A1 1 0 004 14h12a1 1 0 00.707-1.707L16 11.586V8a6 6 0 00-6-6zM10 18a3 3 0 01-3-3h6a3 3 0 01-3 3z" /></svg>,
};

export default function Notifications() {
  const { user } = useAuth();
  const { getNotifications, markNotificationRead, markAllNotificationsRead } = useData();

  const notifications = user ? getNotifications(user.id) : [];
  const unread = notifications.filter((n) => !n.read).length;

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-display font-bold text-2xl text-white">Notifications</h1>
          <p className="text-gray-500 text-sm mt-0.5">{unread} unread</p>
        </div>
        {unread > 0 && user && (
          <button onClick={() => markAllNotificationsRead(user.id)} className="btn-ghost text-sm py-2 px-3">
            Mark All as Read
          </button>
        )}
      </div>

      {notifications.length === 0 ? (
        <div className="glass rounded-2xl py-16 text-center text-gray-500">
          <div className="text-4xl mb-3">🔔</div>
          <div className="font-medium">No notifications yet</div>
        </div>
      ) : (
        <div className="space-y-2">
          {notifications.map((n) => (
            <div
              key={n.id}
              className={`glass glass-hover rounded-2xl p-4 transition-all cursor-pointer ${!n.read ? 'border-l-2 border-green-500/60' : ''}`}
              onClick={() => markNotificationRead(n.id)}
            >
              <div className="flex items-start gap-3">
                <div className={`w-8 h-8 rounded-xl flex items-center justify-center flex-shrink-0 mt-0.5 ${
                  n.severity === 'warning' ? 'bg-yellow-500/10 text-yellow-400' :
                  n.severity === 'critical' ? 'bg-red-500/10 text-red-400' :
                  'bg-green-500/10 text-green-400'
                }`}>
                  {categoryIcons[n.category] ?? categoryIcons.default}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className={`text-sm font-semibold ${!n.read ? 'text-white' : 'text-gray-300'}`}>{n.title}</span>
                    {!n.read && <div className="w-1.5 h-1.5 rounded-full bg-green-400 flex-shrink-0" />}
                  </div>
                  <p className="text-sm text-gray-400 leading-relaxed">{n.message}</p>
                  <div className="flex items-center gap-2 mt-2">
                    <span className="text-xs text-gray-600">{formatDateTime(n.timestamp)}</span>
                    <span className="text-gray-700">·</span>
                    <span className="text-xs text-gray-600">{n.category}</span>
                  </div>
                </div>
                {!n.read && (
                  <button
                    onClick={(e) => { e.stopPropagation(); markNotificationRead(n.id); }}
                    className="text-gray-600 hover:text-green-400 transition-colors flex-shrink-0"
                    title="Mark as read"
                  >
                    <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                      <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                    </svg>
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
