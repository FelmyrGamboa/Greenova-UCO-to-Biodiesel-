import { useState, useEffect, useRef } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useAuth } from '../contexts/AuthContext';
import { useData, classifyFFA } from '../contexts/DataContext';
import { useToast } from '../contexts/ToastContext';
import StatusBadge from '../components/StatusBadge';
import SimBadge from '../components/SimBadge';
import ConfirmModal from '../components/ConfirmModal';
import type { Batch, ChecklistItem } from '../lib/types';
import { formatDate } from '../lib/utils';

const STAGE_NAMES = [
  'Start', 'FFA Testing', 'Process Selection', 'Volume Input',
  'Preparation', 'Parameter Selection', 'Oil Loading + Preheat',
  'Reaction Stage', 'Automatic Separation', 'Dry Wash',
  'Filtration + Drain', 'Complete',
];

function StepIndicator({ current, total }: { current: number; total: number }) {
  const pct = Math.round(((current - 1) / (total - 1)) * 100);
  return (
    <div className="mb-6">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs text-gray-500 font-medium">Step {current} of {total}</span>
        <span className="text-xs font-mono text-green-400">{pct}%</span>
      </div>
      <div className="progress-track h-1.5">
        <div className="progress-fill h-full" style={{ width: `${pct}%` }} />
      </div>
      <div className="text-xs text-gray-500 mt-2">{STAGE_NAMES[current - 1]}</div>
    </div>
  );
}

// ─── Step 1 — Start ─────────────────────────────────────────────────────────
function Step1({ batch, onNext }: { batch: Batch; onNext: (b: Batch) => void }) {
  const { user } = useAuth();
  const [starting, setStarting] = useState(false);

  function handleStart() {
    setStarting(true);
    setTimeout(() => {
      const updated: Batch = {
        ...batch,
        status: 'Ready',
        started_at: new Date().toISOString(),
        stages: batch.stages.map((s) =>
          s.stage_number === 1 ? { ...s, status: 'current', started_at: new Date().toISOString() } : s
        ),
      };
      onNext(updated);
    }, 600);
  }

  return (
    <div className="space-y-6 fade-in-up">
      <div>
        <h2 className="font-display font-bold text-xl text-white mb-1">Start Process</h2>
        <p className="text-gray-500 text-sm">A new batch record has been created. Review the details below before starting.</p>
      </div>

      <div className="glass rounded-2xl p-5 space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <div className="gv-label">Batch ID</div>
            <div className="font-mono text-green-400 font-semibold">{batch.batch_code}</div>
          </div>
          <div>
            <div className="gv-label">Date / Time</div>
            <div className="text-white text-sm">{new Date().toLocaleString()}</div>
          </div>
          <div>
            <div className="gv-label">Operator</div>
            <div className="text-white text-sm">{user?.full_name}</div>
          </div>
          <div>
            <div className="gv-label">Process Status</div>
            <StatusBadge status="Draft" />
          </div>
        </div>
      </div>

      <div className="glass rounded-xl p-4 border-l-2 border-green-500/50" style={{ background: 'rgba(34,197,94,0.04)' }}>
        <p className="text-sm text-gray-400">
          Clicking <strong className="text-white">Start Process</strong> will initialize this batch record,
          set the status to Ready, and save the start timestamp.
        </p>
      </div>

      <button onClick={handleStart} disabled={starting} className="btn-primary">
        {starting ? (
          <><svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg> Starting…</>
        ) : 'Start Process →'}
      </button>
    </div>
  );
}

// ─── Step 2 — FFA Testing ────────────────────────────────────────────────────
function Step2({ batch, store, onNext }: { batch: Batch; store: any; onNext: (b: Batch) => void }) {
  const { user } = useAuth();
  const [ffaStatus, setFfaStatus] = useState<'Not Started' | 'Testing' | 'Complete'>('Not Started');
  const [ffaResult, setFfaResult] = useState('');
  const [error, setError] = useState('');
  const [confirmed, setConfirmed] = useState(false);

  const parsed = parseFloat(ffaResult);
  const classified = !isNaN(parsed) && ffaResult !== '' ? classifyFFA(store, parsed) : null;

  function handleConfirm() {
    setError('');
    if (!ffaResult || isNaN(parsed)) { setError('Please enter a valid numeric FFA result.'); return; }
    if (parsed < 0) { setError('FFA result cannot be negative.'); return; }
    if (!classified) return;
    const updated: Batch = {
      ...batch,
      ffa_test: {
        result: parsed,
        unit: '%',
        classification: classified.classification,
        recommended_process: classified.process.name,
        recorded_at: new Date().toISOString(),
        recorded_by: user?.id ?? '',
      },
      stages: batch.stages.map((s) =>
        s.stage_number === 2 ? { ...s, status: 'completed', completed_at: new Date().toISOString() } :
        s.stage_number === 3 ? { ...s, status: 'current', started_at: new Date().toISOString() } : s
      ),
    };
    onNext(updated);
  }

  return (
    <div className="space-y-5 fade-in-up">
      <div>
        <h2 className="font-display font-bold text-xl text-white mb-1">FFA Testing</h2>
        <p className="text-gray-500 text-sm">The FFA test result is used to determine the appropriate research-approved processing pathway.</p>
      </div>

      <div className="glass rounded-xl p-4">
        <div className="gv-label">FFA Test Status</div>
        <div className="flex gap-2 flex-wrap mt-1">
          {(['Not Started', 'Testing', 'Complete'] as const).map((s) => (
            <button
              key={s}
              onClick={() => setFfaStatus(s)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                ffaStatus === s
                  ? 'bg-green-500 text-black'
                  : 'glass text-gray-400 hover:text-gray-200'
              }`}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      <div>
        <label className="gv-label">FFA Test Result (%)</label>
        <input
          type="number"
          min="0"
          max="100"
          step="0.01"
          placeholder="e.g. 1.5"
          value={ffaResult}
          onChange={(e) => { setFfaResult(e.target.value); setError(''); }}
          className="gv-input"
        />
        <p className="text-xs text-gray-600 mt-1">Enter the recorded FFA percentage from your laboratory analysis.</p>
      </div>

      {classified && (
        <div className="glass rounded-2xl p-5 space-y-3 border border-green-500/15">
          <h3 className="font-semibold text-white text-sm">Classification Result</h3>
          <div className="grid grid-cols-3 gap-4">
            <div>
              <div className="gv-label">FFA Result</div>
              <div className="font-mono text-green-400 font-semibold">{parsed}%</div>
            </div>
            <div>
              <div className="gv-label">Classification</div>
              <div className="text-white text-sm">{classified.classification}</div>
            </div>
            <div>
              <div className="gv-label">Recommended Process</div>
              <div className="text-green-400 text-sm font-medium">{classified.process.name}</div>
            </div>
          </div>
          <p className="text-xs text-gray-500">{classified.process.description}</p>
        </div>
      )}

      {error && <div className="text-red-400 text-sm glass rounded-lg px-3 py-2 border border-red-500/20">{error}</div>}

      <button onClick={handleConfirm} className="btn-primary" disabled={!ffaResult || isNaN(parsed)}>
        Confirm Result →
      </button>
    </div>
  );
}

// ─── Step 3 — Process Selection ──────────────────────────────────────────────
function Step3({ batch, store, onNext }: { batch: Batch; store: any; onNext: (b: Batch) => void }) {
  const [override, setOverride] = useState(false);
  const [overrideReason, setOverrideReason] = useState('');
  const [selectedProcess, setSelectedProcess] = useState(batch.ffa_test?.recommended_process ?? '');
  const [error, setError] = useState('');

  const processTypes = store.process_types;

  function handleContinue() {
    setError('');
    if (!selectedProcess) { setError('Please select a process.'); return; }
    if (override && !overrideReason.trim()) { setError('Override reason is required.'); return; }
    const updated: Batch = {
      ...batch,
      process_type: selectedProcess,
      override_reason: override ? overrideReason : undefined,
      stages: batch.stages.map((s) =>
        s.stage_number === 3 ? { ...s, status: 'completed', completed_at: new Date().toISOString() } :
        s.stage_number === 4 ? { ...s, status: 'current', started_at: new Date().toISOString() } : s
      ),
    };
    onNext(updated);
  }

  return (
    <div className="space-y-5 fade-in-up">
      <div>
        <h2 className="font-display font-bold text-xl text-white mb-1">Process Selection</h2>
        <p className="text-gray-500 text-sm">Based on the recorded FFA test result and configured research criteria.</p>
      </div>

      <div className="glass rounded-2xl p-5">
        <div className="gv-label">Recommended Process</div>
        <div className="text-lg font-semibold text-green-400 mb-1">{batch.ffa_test?.recommended_process}</div>
        <div className="text-gray-500 text-xs">Based on FFA result: {batch.ffa_test?.result}% — {batch.ffa_test?.classification}</div>
      </div>

      {!override ? (
        <div className="flex gap-3">
          <button onClick={handleContinue} className="btn-primary">Accept Recommendation →</button>
          <button onClick={() => setOverride(true)} className="btn-ghost text-sm">Override</button>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="glass rounded-xl p-4 border border-yellow-500/20">
            <div className="text-yellow-400 text-xs font-semibold mb-2">Override Selected</div>
            <p className="text-gray-500 text-xs">Overriding the recommendation requires an audit log entry. Select a process and provide a reason.</p>
          </div>

          <div>
            <label className="gv-label">Select Process</label>
            <select value={selectedProcess} onChange={(e) => setSelectedProcess(e.target.value)} className="gv-select">
              <option value="">— Select a process —</option>
              {processTypes.map((p: any) => (
                <option key={p.id} value={p.name}>{p.name}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="gv-label">Override Reason (required)</label>
            <textarea value={overrideReason} onChange={(e) => setOverrideReason(e.target.value)} placeholder="Explain the reason for overriding the process recommendation..." className="gv-textarea" />
          </div>

          {error && <div className="text-red-400 text-sm">{error}</div>}

          <div className="flex gap-3">
            <button onClick={handleContinue} className="btn-primary">Confirm Override →</button>
            <button onClick={() => { setOverride(false); setSelectedProcess(batch.ffa_test?.recommended_process ?? ''); }} className="btn-ghost text-sm">Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Step 4 — Volume Input ───────────────────────────────────────────────────
function Step4({ batch, store, onNext }: { batch: Batch; store: any; onNext: (b: Batch) => void }) {
  const volMin = store.system_config.find((c: any) => c.config_name === 'oil_volume_min')?.config_value ?? '300';
  const volMax = store.system_config.find((c: any) => c.config_name === 'oil_volume_max')?.config_value ?? '1000';
  const methMin = store.system_config.find((c: any) => c.config_name === 'methanol_ratio_min')?.config_value ?? '3';
  const methMax = store.system_config.find((c: any) => c.config_name === 'methanol_ratio_max')?.config_value ?? '12';
  const catMin = store.system_config.find((c: any) => c.config_name === 'catalyst_pct_min')?.config_value ?? '0.25';
  const catMax = store.system_config.find((c: any) => c.config_name === 'catalyst_pct_max')?.config_value ?? '2.5';

  const [volume, setVolume] = useState(batch.initial_volume > 0 ? String(batch.initial_volume) : '');
  const [methRatioNum, setMethRatioNum] = useState('6');
  const [catalyst, setCatalyst] = useState(String(batch.catalyst_percentage || '1'));
  const [errors, setErrors] = useState<Record<string, string>>({});

  function validate() {
    const e: Record<string, string> = {};
    const v = parseFloat(volume);
    const m = parseFloat(methRatioNum);
    const c = parseFloat(catalyst);
    if (isNaN(v) || v < parseFloat(volMin) || v > parseFloat(volMax)) e.volume = `Oil volume must be between ${volMin}–${volMax} mL.`;
    if (isNaN(m) || m < parseFloat(methMin) || m > parseFloat(methMax)) e.methanol = `Methanol ratio must be between ${methMin}:1 – ${methMax}:1.`;
    if (isNaN(c) || c < parseFloat(catMin) || c > parseFloat(catMax)) e.catalyst = `Catalyst must be between ${catMin}–${catMax} wt%.`;
    return e;
  }

  function handleContinue() {
    const e = validate();
    setErrors(e);
    if (Object.keys(e).length > 0) return;
    const updated: Batch = {
      ...batch,
      initial_volume: parseFloat(volume),
      methanol_ratio: `${methRatioNum}:1`,
      catalyst_percentage: parseFloat(catalyst),
      stages: batch.stages.map((s) =>
        s.stage_number === 4 ? { ...s, status: 'completed', completed_at: new Date().toISOString() } :
        s.stage_number === 5 ? { ...s, status: 'current', started_at: new Date().toISOString() } : s
      ),
    };
    onNext(updated);
  }

  return (
    <div className="space-y-5 fade-in-up">
      <div>
        <h2 className="font-display font-bold text-xl text-white mb-1">Volume Input</h2>
        <p className="text-gray-500 text-sm">Enter the oil volume and production parameters for this batch.</p>
      </div>

      <div className="space-y-4">
        <div>
          <label className="gv-label">Oil Volume (mL) <span className="text-gray-600 normal-case font-normal">Range: {volMin}–{volMax} mL</span></label>
          <input type="number" min={volMin} max={volMax} placeholder="e.g. 500" value={volume} onChange={(e) => { setVolume(e.target.value); setErrors((p) => ({ ...p, volume: '' })); }} className="gv-input" />
          {errors.volume && <p className="text-red-400 text-xs mt-1">{errors.volume}</p>}
        </div>

        <div>
          <label className="gv-label">Methanol to Oil Ratio <span className="text-gray-600 normal-case font-normal">Default 6:1 · Range: {methMin}:1 – {methMax}:1</span></label>
          <div className="flex items-center gap-2">
            <input type="number" min={methMin} max={methMax} step="0.5" value={methRatioNum} onChange={(e) => { setMethRatioNum(e.target.value); setErrors((p) => ({ ...p, methanol: '' })); }} className="gv-input" />
            <span className="text-gray-400 text-sm whitespace-nowrap">: 1</span>
          </div>
          {errors.methanol && <p className="text-red-400 text-xs mt-1">{errors.methanol}</p>}
        </div>

        <div>
          <label className="gv-label">Catalyst to Methanol (wt%) <span className="text-gray-600 normal-case font-normal">Default 1% · Range: {catMin}–{catMax}%</span></label>
          <input type="number" min={catMin} max={catMax} step="0.05" value={catalyst} onChange={(e) => { setCatalyst(e.target.value); setErrors((p) => ({ ...p, catalyst: '' })); }} className="gv-input" />
          {errors.catalyst && <p className="text-red-400 text-xs mt-1">{errors.catalyst}</p>}
        </div>
      </div>

      {volume && methRatioNum && catalyst && Object.keys(validate()).length === 0 && (
        <div className="glass rounded-xl p-4 space-y-2">
          <div className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Batch Summary</div>
          <div className="grid grid-cols-3 gap-3">
            <div><div className="gv-label">Oil Volume</div><div className="font-mono text-green-400">{volume} mL</div></div>
            <div><div className="gv-label">Methanol Ratio</div><div className="font-mono text-green-400">{methRatioNum}:1</div></div>
            <div><div className="gv-label">Catalyst %</div><div className="font-mono text-green-400">{catalyst} wt%</div></div>
          </div>
          <div><div className="gv-label">Selected Process</div><div className="text-white text-sm">{batch.process_type}</div></div>
        </div>
      )}

      <button onClick={handleContinue} className="btn-primary">Continue →</button>
    </div>
  );
}

// ─── Step 5 — Preparation ────────────────────────────────────────────────────
function Step5({ batch, onNext }: { batch: Batch; onNext: (b: Batch) => void }) {
  const [items, setItems] = useState<ChecklistItem[]>(batch.preparation_checklist);
  const [error, setError] = useState('');

  function toggle(id: string) {
    setItems((prev) => prev.map((i) => i.id === id ? { ...i, completed: !i.completed, completed_at: !i.completed ? new Date().toISOString() : undefined } : i));
    setError('');
  }

  function handleConfirm() {
    if (items.some((i) => !i.completed)) { setError('Please complete all checklist items before proceeding.'); return; }
    const updated: Batch = {
      ...batch,
      preparation_checklist: items,
      stages: batch.stages.map((s) =>
        s.stage_number === 5 ? { ...s, status: 'completed', completed_at: new Date().toISOString() } :
        s.stage_number === 6 ? { ...s, status: 'current', started_at: new Date().toISOString() } : s
      ),
    };
    onNext(updated);
  }

  const allDone = items.every((i) => i.completed);

  return (
    <div className="space-y-5 fade-in-up">
      <div>
        <h2 className="font-display font-bold text-xl text-white mb-1">Preparation Checklist</h2>
        <p className="text-gray-500 text-sm">Complete all preparation steps before proceeding to process operation.</p>
      </div>

      <div className="glass rounded-xl p-4 border border-yellow-500/15" style={{ background: 'rgba(234,179,8,0.03)' }}>
        <p className="text-yellow-400 text-xs font-medium">Safety Note</p>
        <p className="text-gray-500 text-xs mt-1">Follow your approved laboratory and research safety protocol for all preparation steps. This checklist records that preparation has been confirmed, not the specific chemical handling procedures.</p>
      </div>

      <div className="space-y-2">
        {items.map((item) => (
          <label key={item.id} className="flex items-start gap-3 glass rounded-xl p-4 cursor-pointer glass-hover transition-all">
            <input type="checkbox" checked={item.completed} onChange={() => toggle(item.id)} className="gv-checkbox mt-0.5 flex-shrink-0" />
            <span className={`text-sm transition-colors ${item.completed ? 'text-green-400 line-through decoration-green-600' : 'text-gray-300'}`}>
              {item.label}
            </span>
          </label>
        ))}
      </div>

      <div className="flex items-center justify-between text-sm">
        <span className="text-gray-500">{items.filter((i) => i.completed).length} / {items.length} completed</span>
        {allDone && <span className="text-green-400 font-medium">All items confirmed ✓</span>}
      </div>

      {error && <div className="text-red-400 text-sm glass rounded-lg px-3 py-2 border border-red-500/20">{error}</div>}

      <button onClick={handleConfirm} className="btn-primary" disabled={!allDone}>
        Confirm Preparation →
      </button>
    </div>
  );
}

// ─── Step 6 — Parameter Selection ───────────────────────────────────────────
function Step6({ batch, store, onNext }: { batch: Batch; store: any; onNext: (b: Batch) => void }) {
  const getC = (name: string) => parseFloat(store.system_config.find((c: any) => c.config_name === name)?.config_value ?? '0');
  const defaults = { temp: getC('temp_default') || 60, duration: getC('duration_default') || 60, stirring: getC('stirring_default') || 450 };
  const ranges = {
    temp: [getC('temp_min') || 40, getC('temp_max') || 70],
    duration: [getC('duration_min') || 20, getC('duration_max') || 180],
    stirring: [getC('stirring_min') || 150, getC('stirring_max') || 900],
  };

  const [mode, setMode] = useState<'default' | 'custom'>(batch.parameters?.preset_type ?? 'default');
  const [temp, setTemp] = useState(String(batch.parameters?.temperature_target ?? defaults.temp));
  const [duration, setDuration] = useState(String(batch.parameters?.reaction_duration ?? defaults.duration));
  const [stirring, setStirring] = useState(String(batch.parameters?.stirring_speed ?? defaults.stirring));
  const [errors, setErrors] = useState<Record<string, string>>({});

  function validate() {
    if (mode === 'default') return {};
    const e: Record<string, string> = {};
    const t = parseFloat(temp), d = parseFloat(duration), s = parseFloat(stirring);
    if (isNaN(t) || t < ranges.temp[0] || t > ranges.temp[1]) e.temp = `Temperature: ${ranges.temp[0]}–${ranges.temp[1]}°C only`;
    if (isNaN(d) || d < ranges.duration[0] || d > ranges.duration[1]) e.duration = `Duration: ${ranges.duration[0]}–${ranges.duration[1]} min only`;
    if (isNaN(s) || s < ranges.stirring[0] || s > ranges.stirring[1]) e.stirring = `Stirring: ${ranges.stirring[0]}–${ranges.stirring[1]} RPM only`;
    return e;
  }

  function handleContinue() {
    const e = validate();
    setErrors(e);
    if (Object.keys(e).length > 0) return;
    const finalTemp = mode === 'default' ? defaults.temp : parseFloat(temp);
    const finalDuration = mode === 'default' ? defaults.duration : parseFloat(duration);
    const finalStirring = mode === 'default' ? defaults.stirring : parseFloat(stirring);
    const updated: Batch = {
      ...batch,
      parameters: { temperature_target: finalTemp, reaction_duration: finalDuration, stirring_speed: finalStirring, preset_type: mode },
      stages: batch.stages.map((s) =>
        s.stage_number === 6 ? { ...s, status: 'completed', completed_at: new Date().toISOString() } :
        s.stage_number === 7 ? { ...s, status: 'current', started_at: new Date().toISOString() } : s
      ),
    };
    onNext(updated);
  }

  return (
    <div className="space-y-5 fade-in-up">
      <div>
        <h2 className="font-display font-bold text-xl text-white mb-1">Parameter Selection</h2>
        <p className="text-gray-500 text-sm">Select research-approved process parameters or enter custom validated values.</p>
      </div>

      <div className="flex gap-2">
        {(['default', 'custom'] as const).map((m) => (
          <button
            key={m}
            onClick={() => { setMode(m); setErrors({}); }}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-all capitalize ${mode === m ? 'bg-green-500 text-black' : 'glass text-gray-400 hover:text-gray-200'}`}
          >
            {m}
          </button>
        ))}
      </div>

      {mode === 'default' ? (
        <div className="glass rounded-2xl p-5">
          <div className="flex items-center gap-2 mb-4">
            <span className="text-xs font-semibold text-green-400 uppercase tracking-wider">Research-Approved Preset</span>
          </div>
          <div className="grid grid-cols-3 gap-4">
            <div><div className="gv-label">Temperature Target</div><div className="font-mono text-green-400 text-lg font-bold">{defaults.temp}°C</div></div>
            <div><div className="gv-label">Reaction Duration</div><div className="font-mono text-green-400 text-lg font-bold">{defaults.duration} min</div></div>
            <div><div className="gv-label">Stirring Speed</div><div className="font-mono text-green-400 text-lg font-bold">{defaults.stirring} RPM</div></div>
          </div>
        </div>
      ) : (
        <div className="glass rounded-2xl p-5 space-y-4">
          <div className="text-xs text-yellow-400 font-medium">Custom values must be within approved research ranges.</div>
          <div>
            <label className="gv-label">Temperature Target <span className="text-gray-600 normal-case font-normal">({ranges.temp[0]}–{ranges.temp[1]}°C)</span></label>
            <input type="number" min={ranges.temp[0]} max={ranges.temp[1]} value={temp} onChange={(e) => { setTemp(e.target.value); setErrors((p) => ({...p, temp: ''})); }} className="gv-input" />
            {errors.temp && <p className="text-red-400 text-xs mt-1">{errors.temp}</p>}
          </div>
          <div>
            <label className="gv-label">Reaction Duration <span className="text-gray-600 normal-case font-normal">({ranges.duration[0]}–{ranges.duration[1]} min)</span></label>
            <input type="number" min={ranges.duration[0]} max={ranges.duration[1]} value={duration} onChange={(e) => { setDuration(e.target.value); setErrors((p) => ({...p, duration: ''})); }} className="gv-input" />
            {errors.duration && <p className="text-red-400 text-xs mt-1">{errors.duration}</p>}
          </div>
          <div>
            <label className="gv-label">Stirring Speed <span className="text-gray-600 normal-case font-normal">({ranges.stirring[0]}–{ranges.stirring[1]} RPM)</span></label>
            <input type="number" min={ranges.stirring[0]} max={ranges.stirring[1]} value={stirring} onChange={(e) => { setStirring(e.target.value); setErrors((p) => ({...p, stirring: ''})); }} className="gv-input" />
            {errors.stirring && <p className="text-red-400 text-xs mt-1">{errors.stirring}</p>}
          </div>
        </div>
      )}

      <button onClick={handleContinue} className="btn-primary">Confirm Parameters →</button>
    </div>
  );
}

// ─── Step 7 — Oil Loading + Preheat ─────────────────────────────────────────
function Step7({ batch, onNext }: { batch: Batch; onNext: (b: Batch) => void }) {
  const [simTemp, setSimTemp] = useState(22);
  const [status, setStatus] = useState<'Heating' | 'Ready' | 'Not Connected'>('Not Connected');
  const targetTemp = batch.parameters?.temperature_target ?? 60;
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    timerRef.current = setInterval(() => {
      setSimTemp((t) => {
        if (t >= targetTemp) { setStatus('Ready'); return targetTemp; }
        setStatus('Heating');
        return +(t + 0.5).toFixed(1);
      });
    }, 500);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [targetTemp]);

  function handleConfirm() {
    if (timerRef.current) clearInterval(timerRef.current);
    const updated: Batch = {
      ...batch,
      status: 'In Progress',
      stages: batch.stages.map((s) =>
        s.stage_number === 7 ? { ...s, status: 'completed', completed_at: new Date().toISOString() } :
        s.stage_number === 8 ? { ...s, status: 'current', started_at: new Date().toISOString() } : s
      ),
    };
    onNext(updated);
  }

  const pct = Math.min(100, Math.round(((simTemp - 22) / (targetTemp - 22)) * 100));

  return (
    <div className="space-y-5 fade-in-up">
      <div>
        <h2 className="font-display font-bold text-xl text-white mb-1">Oil Loading + Preheat</h2>
        <p className="text-gray-500 text-sm">Monitor oil loading and preheat progress.</p>
      </div>

      <SimBadge />

      <div className="glass rounded-2xl p-6">
        <div className="grid grid-cols-2 gap-6 mb-6">
          <div className="text-center">
            <div className="gv-label">Current Temperature</div>
            <div className="font-mono font-bold text-4xl text-orange-400">{simTemp.toFixed(1)}°C</div>
          </div>
          <div className="text-center">
            <div className="gv-label">Target Temperature</div>
            <div className="font-mono font-bold text-4xl text-green-400">{targetTemp}°C</div>
          </div>
        </div>

        {/* Gauge */}
        <div className="mb-4">
          <div className="flex justify-between text-xs text-gray-500 mb-1">
            <span>22°C</span>
            <span>{targetTemp}°C</span>
          </div>
          <div className="progress-track h-4 rounded-full">
            <div className="progress-fill h-full rounded-full" style={{ width: `${pct}%`, background: 'linear-gradient(90deg, #f97316, #fbbf24)' }} />
          </div>
          <div className="text-center text-xs text-gray-500 mt-1">{pct}% heated</div>
        </div>

        <div className="grid grid-cols-3 gap-4">
          <div><div className="gv-label">Oil Volume</div><div className="font-mono text-white">{batch.initial_volume} mL</div></div>
          <div><div className="gv-label">Elapsed Time</div><div className="font-mono text-white">{Math.floor(pct * 0.6)}s</div></div>
          <div>
            <div className="gv-label">Status</div>
            <span className={`text-sm font-medium ${status === 'Ready' ? 'text-green-400' : status === 'Heating' ? 'text-orange-400' : 'text-gray-500'}`}>
              ● {status}
            </span>
          </div>
        </div>
      </div>

      <button onClick={handleConfirm} className="btn-primary" disabled={status !== 'Ready'}>
        {status === 'Ready' ? 'Confirm Ready →' : `Heating… (${simTemp.toFixed(1)}°C / ${targetTemp}°C)`}
      </button>
    </div>
  );
}

// ─── Step 8 — Reaction Stage ─────────────────────────────────────────────────
function Step8({ batch, onNext, onPause, onStop }: {
  batch: Batch;
  onNext: (b: Batch) => void;
  onPause: () => void;
  onStop: () => void;
}) {
  const [paused, setPaused] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [confirmStop, setConfirmStop] = useState(false);
  const duration = (batch.parameters?.reaction_duration ?? 60) * 60;
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!paused) {
      timerRef.current = setInterval(() => setElapsed((e) => Math.min(e + 1, duration)), 1000);
    } else {
      if (timerRef.current) clearInterval(timerRef.current);
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [paused, duration]);

  const pct = Math.round((elapsed / duration) * 100);
  const remaining = duration - elapsed;
  const fmt = (s: number) => [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map((v) => String(v).padStart(2, '0')).join(':');

  function handleComplete() {
    if (timerRef.current) clearInterval(timerRef.current);
    const updated: Batch = {
      ...batch,
      stages: batch.stages.map((s) =>
        s.stage_number === 8 ? { ...s, status: 'completed', completed_at: new Date().toISOString() } :
        s.stage_number === 9 ? { ...s, status: 'current', started_at: new Date().toISOString() } : s
      ),
    };
    onNext(updated);
  }

  return (
    <div className="space-y-5 fade-in-up">
      <div>
        <h2 className="font-display font-bold text-xl text-white mb-1">Reaction Stage</h2>
        <p className="text-gray-500 text-sm">Process: {batch.process_type}</p>
      </div>

      <SimBadge />

      <div className="glass rounded-2xl p-6 space-y-5">
        <div className="flex items-center gap-3">
          <div className={`w-2.5 h-2.5 rounded-full ${paused ? 'bg-yellow-400' : 'bg-green-400 gv-pulse'}`} />
          <span className="text-sm font-medium text-white">{paused ? 'Paused' : 'Running'}</span>
        </div>

        {/* Progress */}
        <div>
          <div className="flex justify-between text-xs text-gray-500 mb-2">
            <span>Reaction Progress</span>
            <span className="font-mono text-green-400">{pct}%</span>
          </div>
          <div className="progress-track h-3">
            <div className="progress-fill h-full" style={{ width: `${pct}%` }} />
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <div><div className="gv-label">Elapsed</div><div className="font-mono text-white text-sm">{fmt(elapsed)}</div></div>
          <div><div className="gv-label">Remaining</div><div className="font-mono text-green-400 text-sm">{fmt(remaining)}</div></div>
          <div><div className="gv-label">Temperature</div><div className="font-mono text-orange-400 text-sm">{batch.parameters?.temperature_target}°C</div></div>
          <div><div className="gv-label">Stirring</div><div className="font-mono text-blue-400 text-sm">{batch.parameters?.stirring_speed} RPM</div></div>
        </div>
      </div>

      <div className="flex gap-3 flex-wrap">
        {!paused ? (
          <button onClick={() => { setPaused(true); onPause(); }} className="btn-secondary text-sm py-2.5 px-4">⏸ Pause</button>
        ) : (
          <button onClick={() => { setPaused(false); }} className="btn-primary text-sm py-2.5 px-4">▶ Resume</button>
        )}
        <button onClick={() => setConfirmStop(true)} className="btn-danger text-sm py-2.5 px-4">■ Stop Process</button>
        {pct >= 100 && (
          <button onClick={handleComplete} className="btn-primary text-sm py-2.5 px-4">Reaction Complete →</button>
        )}
      </div>

      {confirmStop && (
        <ConfirmModal
          title="Stop Process"
          message="Are you sure you want to stop the reaction? This action will be recorded in the audit log and the batch will be marked as Stopped."
          confirmLabel="Stop Batch"
          danger
          onConfirm={() => { setConfirmStop(false); onStop(); }}
          onCancel={() => setConfirmStop(false)}
        />
      )}
    </div>
  );
}

// ─── Step 9 — Automatic Separation ──────────────────────────────────────────
function Step9({ batch, onNext }: { batch: Batch; onNext: (b: Batch) => void }) {
  const [pct, setPct] = useState(0);
  const [complete, setComplete] = useState(false);

  useEffect(() => {
    const id = setInterval(() => {
      setPct((p) => {
        if (p >= 100) { setComplete(true); clearInterval(id); return 100; }
        return p + 2;
      });
    }, 200);
    return () => clearInterval(id);
  }, []);

  function handleContinue() {
    const updated: Batch = {
      ...batch,
      stages: batch.stages.map((s) =>
        s.stage_number === 9 ? { ...s, status: 'completed', completed_at: new Date().toISOString() } :
        s.stage_number === 10 ? { ...s, status: 'current', started_at: new Date().toISOString() } : s
      ),
    };
    onNext(updated);
  }

  return (
    <div className="space-y-5 fade-in-up">
      <div>
        <h2 className="font-display font-bold text-xl text-white mb-1">Automatic Separation</h2>
        <p className="text-gray-500 text-sm">Gravitational separation of product layers.</p>
      </div>

      <SimBadge />

      <div className="glass rounded-2xl p-6 space-y-5">
        <div className="flex items-center gap-3">
          <div className={`w-2 h-2 rounded-full ${complete ? 'bg-green-400' : 'bg-blue-400 gv-pulse'}`} />
          <span className="text-sm text-white font-medium">{complete ? 'Separation Complete' : 'Separating…'}</span>
        </div>

        {/* Visual layers */}
        <div className="mx-auto w-32 h-48 rounded-xl overflow-hidden border border-green-500/20 relative">
          <div className="absolute top-0 left-0 right-0 flex items-center justify-center text-[10px] text-yellow-200 font-medium z-10 py-2" style={{ height: `${Math.max(10, 100 - pct * 0.6)}%`, background: 'rgba(234, 179, 8, 0.15)', transition: 'height 0.5s' }}>
            <span>Biodiesel</span>
          </div>
          <div className="absolute bottom-0 left-0 right-0 flex items-center justify-center text-[10px] text-gray-400 font-medium" style={{ height: `${pct * 0.6}%`, background: 'rgba(100, 60, 20, 0.3)', transition: 'height 0.5s' }}>
            {pct > 30 && <span>Byproduct</span>}
          </div>
        </div>

        <div>
          <div className="flex justify-between text-xs text-gray-500 mb-1.5">
            <span>Separation Progress</span>
            <span className="font-mono text-green-400">{pct}%</span>
          </div>
          <div className="progress-track h-2">
            <div className="progress-fill h-full" style={{ width: `${pct}%` }} />
          </div>
        </div>

        <p className="text-gray-600 text-xs">This is an educational visualization of the separation process. Do not use this display as a substitute for direct observation of your laboratory apparatus.</p>
      </div>

      <button onClick={handleContinue} disabled={!complete} className="btn-primary">
        {complete ? 'Continue →' : `Separating… ${pct}%`}
      </button>
    </div>
  );
}

// ─── Step 10 — Dry Wash ──────────────────────────────────────────────────────
function Step10({ batch, onNext }: { batch: Batch; onNext: (b: Batch) => void }) {
  const [amount, setAmount] = useState('');
  const [cycles, setCycles] = useState('3');
  const [currentCycle, setCurrentCycle] = useState(0);
  const [washing, setWashing] = useState(false);
  const [error, setError] = useState('');

  function handleStart() {
    setError('');
    if (!amount || isNaN(parseFloat(amount)) || parseFloat(amount) <= 0) { setError('Please enter a valid dry wash amount.'); return; }
    setWashing(true);
    let c = 0;
    const total = parseInt(cycles);
    const id = setInterval(() => {
      c++;
      setCurrentCycle(c);
      if (c >= total) {
        clearInterval(id);
        setWashing(false);
        const updated: Batch = {
          ...batch,
          dry_wash_amount: parseFloat(amount),
          dry_wash_cycles: total,
          stages: batch.stages.map((s) =>
            s.stage_number === 10 ? { ...s, status: 'completed', completed_at: new Date().toISOString() } :
            s.stage_number === 11 ? { ...s, status: 'current', started_at: new Date().toISOString() } : s
          ),
        };
        onNext(updated);
      }
    }, 1500);
  }

  return (
    <div className="space-y-5 fade-in-up">
      <div>
        <h2 className="font-display font-bold text-xl text-white mb-1">Dry Wash</h2>
        <p className="text-gray-500 text-sm">Enter the dry wash parameters for this batch.</p>
      </div>

      <div className="glass rounded-xl p-4 border border-yellow-500/15">
        <p className="text-yellow-400 text-xs font-medium">Research Note</p>
        <p className="text-gray-500 text-xs mt-1">All dry wash quantities must follow your approved laboratory protocol. Enter values as recorded from your procedure.</p>
      </div>

      <div className="space-y-4">
        <div>
          <label className="gv-label">Dry Wash Amount (g)</label>
          <input type="number" min="0" step="0.1" placeholder="e.g. 50" value={amount} onChange={(e) => { setAmount(e.target.value); setError(''); }} className="gv-input" disabled={washing} />
        </div>
        <div>
          <label className="gv-label">Number of Cycles</label>
          <input type="number" min="1" max="10" step="1" value={cycles} onChange={(e) => setCycles(e.target.value)} className="gv-input" disabled={washing} />
        </div>
      </div>

      {washing && (
        <div className="glass rounded-xl p-4 space-y-3">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-blue-400 gv-pulse" />
            <span className="text-sm text-white">Dry Wash in Progress</span>
          </div>
          <div className="text-xs text-gray-400">Cycle {currentCycle} of {cycles}</div>
          <div className="progress-track h-2">
            <div className="progress-fill h-full" style={{ width: `${(currentCycle / parseInt(cycles)) * 100}%` }} />
          </div>
        </div>
      )}

      {error && <div className="text-red-400 text-sm">{error}</div>}

      {!washing && (
        <button onClick={handleStart} className="btn-primary">Start Dry Wash →</button>
      )}
    </div>
  );
}

// ─── Step 11 — Filtration + Drain ────────────────────────────────────────────
function Step11({ batch, onNext }: { batch: Batch; onNext: (b: Batch) => void }) {
  const [stage, setStage] = useState<'filtering' | 'draining' | 'complete'>('filtering');
  const [pct, setPct] = useState(0);
  const [confirmed, setConfirmed] = useState(false);

  useEffect(() => {
    const id = setInterval(() => {
      setPct((p) => {
        if (p >= 100) {
          clearInterval(id);
          if (stage === 'filtering') setTimeout(() => { setPct(0); setStage('draining'); }, 500);
          else if (stage === 'draining') setTimeout(() => setStage('complete'), 500);
          return 100;
        }
        return p + 2;
      });
    }, 150);
    return () => clearInterval(id);
  }, [stage]);

  function handleConfirm() {
    const updated: Batch = {
      ...batch,
      stages: batch.stages.map((s) =>
        s.stage_number === 11 ? { ...s, status: 'completed', completed_at: new Date().toISOString() } :
        s.stage_number === 12 ? { ...s, status: 'current', started_at: new Date().toISOString() } : s
      ),
    };
    onNext(updated);
  }

  return (
    <div className="space-y-5 fade-in-up">
      <div>
        <h2 className="font-display font-bold text-xl text-white mb-1">Filtration + Drain</h2>
        <p className="text-gray-500 text-sm">Final filtration and drain stages.</p>
      </div>

      <SimBadge />

      <div className="glass rounded-2xl p-6 space-y-4">
        <div className="flex gap-4">
          {(['filtering', 'draining', 'complete'] as const).map((s) => (
            <div key={s} className="flex items-center gap-2">
              <div className={`w-2 h-2 rounded-full ${stage === s ? 'bg-green-400 gv-pulse' : stage > s || (stage === 'complete') ? 'bg-green-600' : 'bg-gray-700'}`} />
              <span className={`text-xs capitalize ${stage === s ? 'text-white font-medium' : 'text-gray-600'}`}>{s}</span>
            </div>
          ))}
        </div>

        {stage !== 'complete' && (
          <>
            <div className="text-sm text-white font-medium capitalize">{stage}…</div>
            <div className="progress-track h-2">
              <div className="progress-fill h-full" style={{ width: `${pct}%` }} />
            </div>
          </>
        )}

        {stage === 'complete' && (
          <div className="text-center py-4">
            <div className="text-green-400 font-bold text-lg">Filtration Complete ✓</div>
          </div>
        )}

        <div className="grid grid-cols-2 gap-4 mt-2">
          <div><div className="gv-label">Input Volume</div><div className="font-mono text-white">{batch.initial_volume} mL</div></div>
          <div><div className="gv-label">Output Status</div><div className="text-sm text-gray-400">{stage === 'complete' ? 'Ready' : 'Processing'}</div></div>
        </div>
      </div>

      {stage === 'complete' && !confirmed && (
        <button onClick={() => { setConfirmed(true); handleConfirm(); }} className="btn-primary">
          Confirm and Complete →
        </button>
      )}
    </div>
  );
}

// ─── Step 12 — Complete ──────────────────────────────────────────────────────
function Step12({ batch, onFinish }: { batch: Batch; onFinish: () => void }) {
  const navigate = useNavigate();
  const duration = batch.started_at
    ? Math.round((Date.now() - new Date(batch.started_at).getTime()) / 60000)
    : null;

  return (
    <div className="space-y-6 fade-in-up text-center">
      <div className="w-20 h-20 rounded-full bg-green-500/15 border-2 border-green-500/40 flex items-center justify-center mx-auto">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-10 h-10 text-green-400">
          <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>

      <div>
        <h2 className="font-display font-bold text-3xl text-white mb-2">Process Complete</h2>
        <p className="text-gray-400">Batch {batch.batch_code} has been completed successfully.</p>
      </div>

      <div className="glass rounded-2xl p-6 text-left space-y-3">
        <h3 className="font-semibold text-white mb-3">Batch Summary</h3>
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div><div className="gv-label">Batch ID</div><div className="font-mono text-green-400">{batch.batch_code}</div></div>
          <div><div className="gv-label">Date</div><div className="text-white">{formatDate(batch.created_at)}</div></div>
          <div><div className="gv-label">Process</div><div className="text-white">{batch.process_type}</div></div>
          <div><div className="gv-label">Initial Volume</div><div className="text-white">{batch.initial_volume} mL</div></div>
          <div><div className="gv-label">FFA Result</div><div className="text-white">{batch.ffa_test?.result ?? '—'}%</div></div>
          <div><div className="gv-label">Duration</div><div className="text-white">{duration ? `${duration} min` : '—'}</div></div>
          <div><div className="gv-label">Final Status</div><StatusBadge status="Completed" size="sm" /></div>
        </div>

        <div className="glass rounded-xl p-3 border border-yellow-500/15 mt-3">
          <div className="text-yellow-400 text-xs font-medium">Quality Testing</div>
          <p className="text-gray-500 text-xs mt-0.5">Quality testing pending — results must be entered by laboratory personnel.</p>
        </div>
      </div>

      <div className="flex flex-col sm:flex-row gap-3 justify-center">
        <button onClick={() => navigate(`/batches/${batch.id}`)} className="btn-primary text-sm">View Batch Report</button>
        <button onClick={() => navigate('/batch/new')} className="btn-secondary text-sm">Start New Batch</button>
        <button onClick={() => navigate('/dashboard')} className="btn-ghost text-sm">← Dashboard</button>
      </div>
    </div>
  );
}

// ─── Main Component ──────────────────────────────────────────────────────────
export default function NewBatch() {
  const { user } = useAuth();
  const { createBatch, updateBatch, getBatch, markBatchStatus, store } = useData();
  const { toast } = useToast();
  const navigate = useNavigate();
  const { batchId } = useParams();
  const initialized = useRef(false);

  const [batch, setBatch] = useState<Batch | null>(null);
  const [confirmBack, setConfirmBack] = useState(false);

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    if (batchId) {
      const existing = getBatch(batchId);
      if (existing) { setBatch(existing); return; }
    }
    const newBatch = createBatch();
    setBatch(newBatch);
  }, []);

  function handleNext(updated: Batch) {
    const nextStep = updated.current_step < 12 ? updated.current_step + 1 : 12;
    const withStep = { ...updated, current_step: Math.max(updated.current_step, nextStep) };
    setBatch(withStep);
    updateBatch(withStep);
    if (withStep.current_step === 12) {
      const finalBatch = { ...withStep, status: 'Completed' as const, completed_at: new Date().toISOString() };
      setBatch(finalBatch);
      updateBatch(finalBatch);
      toast('Batch completed successfully!', 'success');
    }
  }

  function handleSaveDraft() {
    if (batch) {
      updateBatch(batch);
      toast('Draft saved.', 'success');
    }
  }

  function handlePause() {
    if (batch) {
      const updated = { ...batch, status: 'Paused' as const };
      setBatch(updated);
      updateBatch(updated);
      toast('Process paused.', 'warning');
    }
  }

  function handleStop() {
    if (batch) {
      const updated = { ...batch, status: 'Stopped' as const };
      setBatch(updated);
      updateBatch(updated);
      markBatchStatus(batch.id, 'Stopped');
      toast('Batch stopped.', 'error');
      navigate('/dashboard');
    }
  }

  if (!batch) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-gray-500">Initializing batch…</div>
      </div>
    );
  }

  const step = batch.current_step;

  return (
    <div className="p-6 max-w-2xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="font-display font-bold text-xl text-white">New Biodiesel Batch</h1>
          <div className="text-green-400 font-mono text-sm mt-0.5">{batch.batch_code}</div>
        </div>
        <div className="flex gap-2">
          <button onClick={handleSaveDraft} className="btn-ghost text-xs py-2 px-3">Save Draft</button>
          {step < 12 && (
            <button onClick={() => setConfirmBack(true)} className="btn-ghost text-xs py-2 px-3">← Exit</button>
          )}
        </div>
      </div>

      {/* Progress indicator */}
      <StepIndicator current={step} total={12} />

      {/* Step content */}
      <div className="glass rounded-2xl p-6">
        {step === 1 && <Step1 batch={batch} onNext={handleNext} />}
        {step === 2 && <Step2 batch={batch} store={store} onNext={handleNext} />}
        {step === 3 && <Step3 batch={batch} store={store} onNext={handleNext} />}
        {step === 4 && <Step4 batch={batch} store={store} onNext={handleNext} />}
        {step === 5 && <Step5 batch={batch} onNext={handleNext} />}
        {step === 6 && <Step6 batch={batch} store={store} onNext={handleNext} />}
        {step === 7 && <Step7 batch={batch} onNext={handleNext} />}
        {step === 8 && <Step8 batch={batch} onNext={handleNext} onPause={handlePause} onStop={handleStop} />}
        {step === 9 && <Step9 batch={batch} onNext={handleNext} />}
        {step === 10 && <Step10 batch={batch} onNext={handleNext} />}
        {step === 11 && <Step11 batch={batch} onNext={handleNext} />}
        {step === 12 && <Step12 batch={batch} onFinish={() => navigate('/dashboard')} />}
      </div>

      {confirmBack && (
        <ConfirmModal
          title="Exit Batch Wizard"
          message="Your progress has been auto-saved as a draft. You can continue this batch later from Batch History."
          confirmLabel="Exit"
          cancelLabel="Stay"
          onConfirm={() => navigate('/batches')}
          onCancel={() => setConfirmBack(false)}
        />
      )}
    </div>
  );
}
