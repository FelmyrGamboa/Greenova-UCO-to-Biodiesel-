import { useState } from 'react';
import { useData } from '../../contexts/DataContext';
import { useToast } from '../../contexts/ToastContext';

const CONFIG_GROUPS = [
  {
    title: 'FFA Classification Rules',
    items: [
      { key: 'ffa_standard_max', label: 'Low FFA Max (%)', desc: 'FFA at or below this value → Standard Transesterification', unit: '%' },
      { key: 'ffa_twopass_max', label: 'Medium FFA Max (%)', desc: 'FFA above Low Max and at/below this value → Two-Pass Process', unit: '%' },
    ],
  },
  {
    title: 'Volume Limits',
    items: [
      { key: 'oil_volume_min', label: 'Oil Volume Min (mL)', desc: '', unit: 'mL' },
      { key: 'oil_volume_max', label: 'Oil Volume Max (mL)', desc: '', unit: 'mL' },
      { key: 'methanol_ratio_min', label: 'Methanol Ratio Min', desc: 'Numerator of ratio (X:1)', unit: '' },
      { key: 'methanol_ratio_max', label: 'Methanol Ratio Max', desc: '', unit: '' },
      { key: 'catalyst_pct_min', label: 'Catalyst Min (wt%)', desc: '', unit: 'wt%' },
      { key: 'catalyst_pct_max', label: 'Catalyst Max (wt%)', desc: '', unit: 'wt%' },
    ],
  },
  {
    title: 'Default Process Parameters',
    items: [
      { key: 'temp_default', label: 'Default Temperature (°C)', desc: 'Research-approved preset value', unit: '°C' },
      { key: 'temp_min', label: 'Temperature Min (°C)', desc: 'Custom parameter lower bound', unit: '°C' },
      { key: 'temp_max', label: 'Temperature Max (°C)', desc: 'Custom parameter upper bound', unit: '°C' },
      { key: 'duration_default', label: 'Default Duration (min)', desc: 'Research-approved preset value', unit: 'min' },
      { key: 'duration_min', label: 'Duration Min (min)', desc: '', unit: 'min' },
      { key: 'duration_max', label: 'Duration Max (min)', desc: '', unit: 'min' },
      { key: 'stirring_default', label: 'Default Stirring (RPM)', desc: '', unit: 'RPM' },
      { key: 'stirring_min', label: 'Stirring Min (RPM)', desc: '', unit: 'RPM' },
      { key: 'stirring_max', label: 'Stirring Max (RPM)', desc: '', unit: 'RPM' },
    ],
  },
  {
    title: 'Alert Thresholds',
    items: [
      { key: 'alert_temp_warning', label: 'Temperature Warning (°C)', desc: 'Alert when temperature exceeds this value', unit: '°C' },
      { key: 'alert_temp_critical', label: 'Temperature Critical (°C)', desc: 'Critical alert threshold', unit: '°C' },
    ],
  },
];

export default function AdminConfiguration() {
  const { store, updateConfig, getConfig } = useData();
  const { toast } = useToast();
  const [editing, setEditing] = useState<string | null>(null);
  const [editVal, setEditVal] = useState('');

  function startEdit(key: string) {
    setEditing(key);
    setEditVal(String(getConfig(key)));
  }

  function save(key: string) {
    if (!editVal || isNaN(parseFloat(editVal))) { toast('Please enter a valid number.', 'error'); return; }
    updateConfig(key, editVal);
    setEditing(null);
    toast('Configuration updated.', 'success');
  }

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      <div>
        <h1 className="font-display font-bold text-2xl text-white">Process Configuration</h1>
        <p className="text-gray-500 text-sm mt-0.5">Configure research-approved process parameters and validation rules</p>
      </div>

      <div className="glass rounded-xl p-4 border border-yellow-500/15">
        <div className="text-yellow-400 text-xs font-semibold mb-1">Administrator Notice</div>
        <p className="text-gray-500 text-xs">All configuration changes are recorded in the audit log with timestamp, user, and the old and new values. Changes to process parameters affect all future batch validations.</p>
      </div>

      {CONFIG_GROUPS.map((group) => (
        <div key={group.title} className="glass rounded-2xl overflow-hidden">
          <div className="px-6 py-4 border-b" style={{ borderColor: 'rgba(34,197,94,0.1)' }}>
            <h2 className="font-display font-semibold text-white">{group.title}</h2>
          </div>
          <div className="divide-y" style={{ borderColor: 'rgba(34,197,94,0.05)' }}>
            {group.items.map((item) => (
              <div key={item.key} className="px-6 py-4 flex items-center gap-4">
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-white">{item.label}</div>
                  {item.desc && <div className="text-xs text-gray-500 mt-0.5">{item.desc}</div>}
                </div>
                <div className="flex items-center gap-3">
                  {editing === item.key ? (
                    <>
                      <input
                        type="number"
                        value={editVal}
                        onChange={(e) => setEditVal(e.target.value)}
                        className="gv-input w-24 text-right"
                        autoFocus
                        onKeyDown={(e) => { if (e.key === 'Enter') save(item.key); if (e.key === 'Escape') setEditing(null); }}
                      />
                      <button onClick={() => save(item.key)} className="btn-primary text-xs py-1.5 px-3">Save</button>
                      <button onClick={() => setEditing(null)} className="btn-ghost text-xs py-1.5 px-3">×</button>
                    </>
                  ) : (
                    <>
                      <span className="font-mono text-green-400 font-semibold">{getConfig(item.key)}{item.unit}</span>
                      <button onClick={() => startEdit(item.key)} className="btn-secondary text-xs py-1.5 px-3">Edit</button>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
