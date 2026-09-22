import { useState } from 'react';
import { useToast } from '../contexts/ToastContext';

export default function Settings() {
  const { toast } = useToast();
  const [theme, setTheme] = useState('dark-green');
  const [emailNotifs, setEmailNotifs] = useState(true);
  const [processAlerts, setProcessAlerts] = useState(true);
  const [units, setUnits] = useState('metric');

  function handleSave() {
    toast('Settings saved.', 'success');
  }

  return (
    <div className="p-6 max-w-2xl mx-auto space-y-6">
      <h1 className="font-display font-bold text-2xl text-white">Settings</h1>

      {/* Appearance */}
      <div className="glass rounded-2xl p-6">
        <h2 className="font-display font-semibold text-white mb-4">Appearance</h2>
        <div className="space-y-3">
          {[
            { value: 'dark-green', label: 'Greenova Dark Green', desc: 'Primary branded theme (default)', recommended: true },
            { value: 'light', label: 'Light Theme', desc: 'High contrast light mode' },
            { value: 'system', label: 'System Default', desc: 'Follow your device preference' },
          ].map((t) => (
            <label key={t.value} className="flex items-start gap-3 glass rounded-xl p-4 cursor-pointer glass-hover transition-all">
              <input
                type="radio"
                name="theme"
                value={t.value}
                checked={theme === t.value}
                onChange={() => setTheme(t.value)}
                className="mt-0.5 accent-green-500"
              />
              <div>
                <div className="text-sm font-medium text-white flex items-center gap-2">
                  {t.label}
                  {t.recommended && <span className="text-xs text-green-400 bg-green-400/10 px-1.5 py-0.5 rounded">Recommended</span>}
                </div>
                <div className="text-xs text-gray-500 mt-0.5">{t.desc}</div>
              </div>
            </label>
          ))}
        </div>
      </div>

      {/* Notifications */}
      <div className="glass rounded-2xl p-6">
        <h2 className="font-display font-semibold text-white mb-4">Notifications</h2>
        <div className="space-y-3">
          {[
            { id: 'email', label: 'Email Notifications', desc: 'Receive process and system updates via email', value: emailNotifs, set: setEmailNotifs },
            { id: 'process', label: 'Process Alerts', desc: 'In-app alerts for parameter warnings and process events', value: processAlerts, set: setProcessAlerts },
          ].map((n) => (
            <div key={n.id} className="flex items-center justify-between glass rounded-xl p-4">
              <div>
                <div className="text-sm font-medium text-white">{n.label}</div>
                <div className="text-xs text-gray-500 mt-0.5">{n.desc}</div>
              </div>
              <button
                onClick={() => n.set(!n.value)}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${n.value ? 'bg-green-500' : 'bg-gray-700'}`}
              >
                <span className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${n.value ? 'translate-x-6' : 'translate-x-1'}`} />
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* System preferences */}
      <div className="glass rounded-2xl p-6">
        <h2 className="font-display font-semibold text-white mb-4">System Preferences</h2>
        <div className="space-y-4">
          <div>
            <label className="gv-label">Measurement Units</label>
            <select value={units} onChange={(e) => setUnits(e.target.value)} className="gv-select">
              <option value="metric">Metric (mL, °C, g)</option>
              <option value="imperial">Imperial</option>
            </select>
          </div>
        </div>
      </div>

      <button onClick={handleSave} className="btn-primary">Save Settings</button>
    </div>
  );
}
