import type {
  AppStore,
  User,
  Batch,
  AuditLog,
  AppNotification,
  ProcessAlert,
  SensorReading,
  SystemConfig,
  ProcessType,
  Session,
} from './types';

const STORE_KEY = 'greenova_store';
const SESSION_KEY = 'greenova_session';

const STAGE_NAMES = [
  'Start',
  'FFA Testing',
  'Process Selection',
  'Volume Input',
  'Preparation',
  'Parameter Selection',
  'Oil Loading + Preheat',
  'Reaction Stage',
  'Automatic Separation',
  'Dry Wash',
  'Filtration + Drain',
  'Complete',
];

function makeStages() {
  return STAGE_NAMES.map((name, i) => ({
    stage_number: i + 1,
    stage_name: name,
    status: 'pending' as const,
    started_at: undefined,
    completed_at: undefined,
    notes: undefined,
    data: undefined,
  }));
}

function defaultStore(): AppStore {
  const now = new Date().toISOString();
  const adminId = 'user_admin_001';
  const researcherId = 'user_res_001';
  const operatorId = 'user_op_001';

  const users: User[] = [
    {
      id: adminId,
      full_name: 'Dr. Maria Santos',
      email: 'admin@greenova.app',
      password_hash: 'admin123',
      role: 'Administrator',
      created_at: '2026-01-10T08:00:00Z',
      updated_at: now,
      account_status: 'active',
    },
    {
      id: researcherId,
      full_name: 'Prof. James Rivera',
      email: 'researcher@greenova.app',
      password_hash: 'research123',
      role: 'Researcher',
      created_at: '2026-01-15T09:00:00Z',
      updated_at: now,
      account_status: 'active',
    },
    {
      id: operatorId,
      full_name: 'Alex Chen',
      email: 'operator@greenova.app',
      password_hash: 'operator123',
      role: 'Operator',
      created_at: '2026-02-01T10:00:00Z',
      updated_at: now,
      account_status: 'active',
    },
  ];

  const processTypes: ProcessType[] = [
    {
      id: 'pt_standard',
      name: 'Standard Transesterification',
      description: 'Base-catalyzed transesterification for low FFA oils',
      ffa_range_min: 0,
      ffa_range_max: 2,
    },
    {
      id: 'pt_twopass',
      name: 'Two-Pass Process',
      description: 'Acid pre-treatment followed by base catalysis for medium FFA oils',
      ffa_range_min: 2,
      ffa_range_max: 5,
    },
    {
      id: 'pt_acid',
      name: 'Acid-Catalyzed Process',
      description: 'Full acid-catalyzed transesterification for high FFA oils',
      ffa_range_min: 5,
      ffa_range_max: 100,
    },
  ];

  const systemConfig: SystemConfig[] = [
    { id: 'sc1', config_name: 'ffa_standard_max', config_value: '2', category: 'FFA Classification', updated_by: adminId, updated_at: now },
    { id: 'sc2', config_name: 'ffa_twopass_max', config_value: '5', category: 'FFA Classification', updated_by: adminId, updated_at: now },
    { id: 'sc3', config_name: 'oil_volume_min', config_value: '300', category: 'Volume Limits', updated_by: adminId, updated_at: now },
    { id: 'sc4', config_name: 'oil_volume_max', config_value: '1000', category: 'Volume Limits', updated_by: adminId, updated_at: now },
    { id: 'sc5', config_name: 'methanol_ratio_min', config_value: '3', category: 'Volume Limits', updated_by: adminId, updated_at: now },
    { id: 'sc6', config_name: 'methanol_ratio_max', config_value: '12', category: 'Volume Limits', updated_by: adminId, updated_at: now },
    { id: 'sc7', config_name: 'catalyst_pct_min', config_value: '0.25', category: 'Volume Limits', updated_by: adminId, updated_at: now },
    { id: 'sc8', config_name: 'catalyst_pct_max', config_value: '2.5', category: 'Volume Limits', updated_by: adminId, updated_at: now },
    { id: 'sc9', config_name: 'temp_min', config_value: '40', category: 'Parameters', updated_by: adminId, updated_at: now },
    { id: 'sc10', config_name: 'temp_max', config_value: '70', category: 'Parameters', updated_by: adminId, updated_at: now },
    { id: 'sc11', config_name: 'temp_default', config_value: '60', category: 'Parameters', updated_by: adminId, updated_at: now },
    { id: 'sc12', config_name: 'duration_min', config_value: '20', category: 'Parameters', updated_by: adminId, updated_at: now },
    { id: 'sc13', config_name: 'duration_max', config_value: '180', category: 'Parameters', updated_by: adminId, updated_at: now },
    { id: 'sc14', config_name: 'duration_default', config_value: '60', category: 'Parameters', updated_by: adminId, updated_at: now },
    { id: 'sc15', config_name: 'stirring_min', config_value: '150', category: 'Parameters', updated_by: adminId, updated_at: now },
    { id: 'sc16', config_name: 'stirring_max', config_value: '900', category: 'Parameters', updated_by: adminId, updated_at: now },
    { id: 'sc17', config_name: 'stirring_default', config_value: '450', category: 'Parameters', updated_by: adminId, updated_at: now },
    { id: 'sc18', config_name: 'alert_temp_warning', config_value: '65', category: 'Alert Thresholds', updated_by: adminId, updated_at: now },
    { id: 'sc19', config_name: 'alert_temp_critical', config_value: '72', category: 'Alert Thresholds', updated_by: adminId, updated_at: now },
  ];

  const completedStages = makeStages().map((s) => ({ ...s, status: 'completed' as const, started_at: '2026-08-10T09:00:00Z', completed_at: '2026-08-10T10:30:00Z' }));
  const batch1: Batch = {
    id: 'batch_001',
    batch_code: 'GV-2026-001',
    user_id: researcherId,
    status: 'Completed',
    current_step: 12,
    process_type: 'Standard Transesterification',
    initial_volume: 500,
    methanol_ratio: '6:1',
    catalyst_percentage: 1,
    ffa_test: {
      result: 1.2,
      unit: '%',
      classification: 'Low FFA',
      recommended_process: 'Standard Transesterification',
      recorded_at: '2026-08-10T09:10:00Z',
      recorded_by: researcherId,
    },
    parameters: { temperature_target: 60, reaction_duration: 60, stirring_speed: 450, preset_type: 'default' },
    stages: completedStages,
    preparation_checklist: [],
    started_at: '2026-08-10T09:00:00Z',
    completed_at: '2026-08-10T10:45:00Z',
    duration: 105,
    created_at: '2026-08-10T09:00:00Z',
    updated_at: '2026-08-10T10:45:00Z',
  };

  const batch2Stages = makeStages().map((s, i) => ({
    ...s,
    status: (i < 8 ? 'completed' : i === 8 ? 'current' : 'pending') as typeof s.status,
    started_at: i < 9 ? '2026-08-20T10:00:00Z' : undefined,
    completed_at: i < 8 ? '2026-08-20T11:30:00Z' : undefined,
  }));
  const batch2: Batch = {
    id: 'batch_002',
    batch_code: 'GV-2026-002',
    user_id: operatorId,
    status: 'In Progress',
    current_step: 9,
    process_type: 'Two-Pass Process',
    initial_volume: 750,
    methanol_ratio: '6:1',
    catalyst_percentage: 1.2,
    ffa_test: {
      result: 3.4,
      unit: '%',
      classification: 'Medium FFA',
      recommended_process: 'Two-Pass Process',
      recorded_at: '2026-08-20T10:15:00Z',
      recorded_by: operatorId,
    },
    parameters: { temperature_target: 60, reaction_duration: 60, stirring_speed: 450, preset_type: 'default' },
    stages: batch2Stages,
    preparation_checklist: [],
    started_at: '2026-08-20T10:00:00Z',
    created_at: '2026-08-20T10:00:00Z',
    updated_at: new Date().toISOString(),
  };

  const batch3Stages = makeStages().map((s, i) => ({
    ...s,
    status: (i < 4 ? 'completed' : i === 4 ? 'current' : 'pending') as typeof s.status,
  }));
  const batch3: Batch = {
    id: 'batch_003',
    batch_code: 'GV-2026-003',
    user_id: researcherId,
    status: 'Paused',
    current_step: 5,
    process_type: 'Standard Transesterification',
    initial_volume: 400,
    methanol_ratio: '6:1',
    catalyst_percentage: 1,
    stages: batch3Stages,
    preparation_checklist: [],
    created_at: '2026-08-25T14:00:00Z',
    updated_at: '2026-08-25T15:30:00Z',
  };

  const batch4Stages = makeStages().map((s) => ({
    ...s,
    status: 'completed' as const,
    started_at: '2026-07-05T08:00:00Z',
    completed_at: '2026-07-05T10:20:00Z',
  }));
  const batch4: Batch = {
    id: 'batch_004',
    batch_code: 'GV-2026-004',
    user_id: researcherId,
    status: 'Completed',
    current_step: 12,
    process_type: 'Standard Transesterification',
    initial_volume: 600,
    methanol_ratio: '6:1',
    catalyst_percentage: 1,
    ffa_test: {
      result: 0.8,
      unit: '%',
      classification: 'Low FFA',
      recommended_process: 'Standard Transesterification',
      recorded_at: '2026-07-05T08:15:00Z',
      recorded_by: researcherId,
    },
    parameters: { temperature_target: 60, reaction_duration: 60, stirring_speed: 450, preset_type: 'default' },
    stages: batch4Stages,
    preparation_checklist: [],
    started_at: '2026-07-05T08:00:00Z',
    completed_at: '2026-07-05T10:20:00Z',
    duration: 140,
    created_at: '2026-07-05T08:00:00Z',
    updated_at: '2026-07-05T10:20:00Z',
  };

  const auditLogs: AuditLog[] = [
    { id: 'al1', user_id: adminId, user_name: 'Dr. Maria Santos', event_type: 'Login', description: 'Administrator login', timestamp: '2026-09-01T08:00:00Z' },
    { id: 'al2', user_id: researcherId, user_name: 'Prof. James Rivera', event_type: 'Batch Completed', description: 'Batch GV-2026-001 completed successfully', batch_id: 'batch_001', timestamp: '2026-08-10T10:45:00Z' },
    { id: 'al3', user_id: operatorId, user_name: 'Alex Chen', event_type: 'Batch Created', description: 'New batch GV-2026-002 started', batch_id: 'batch_002', timestamp: '2026-08-20T10:00:00Z' },
    { id: 'al4', user_id: researcherId, user_name: 'Prof. James Rivera', event_type: 'Batch Completed', description: 'Batch GV-2026-004 completed', batch_id: 'batch_004', timestamp: '2026-07-05T10:20:00Z' },
  ];

  const notifications: AppNotification[] = [
    {
      id: 'n1',
      user_id: operatorId,
      title: 'Batch GV-2026-002 in Progress',
      message: 'Separation stage in progress. Estimated completion in 15 minutes.',
      category: 'Process Update',
      severity: 'info',
      read: false,
      timestamp: new Date().toISOString(),
    },
    {
      id: 'n2',
      user_id: researcherId,
      title: 'Batch GV-2026-001 Complete',
      message: 'Batch completed successfully. Report is ready to generate.',
      category: 'Process Complete',
      severity: 'info',
      read: true,
      timestamp: '2026-08-10T10:45:00Z',
    },
    {
      id: 'n3',
      user_id: adminId,
      title: 'System Running — Simulation Mode',
      message: 'Hardware sensors not connected. All monitoring data is simulated.',
      category: 'System Connection',
      severity: 'warning',
      read: false,
      timestamp: now,
    },
  ];

  const alerts: ProcessAlert[] = [
    {
      id: 'a1',
      batch_id: 'batch_002',
      parameter: 'Hardware Connection',
      severity: 'disconnected',
      message: 'Physical sensors not connected. Running in simulation mode.',
      timestamp: now,
      acknowledged: false,
    },
  ];

  return {
    users,
    batches: [batch1, batch2, batch3, batch4],
    audit_logs: auditLogs,
    notifications,
    alerts,
    sensor_readings: [],
    system_config: systemConfig,
    process_types: processTypes,
    initialized: true,
  };
}

export function getStore(): AppStore {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as AppStore;
      if (parsed.initialized) return parsed;
    }
  } catch {}
  const store = defaultStore();
  saveStore(store);
  return store;
}

export function saveStore(store: AppStore): void {
  localStorage.setItem(STORE_KEY, JSON.stringify(store));
}

export function updateStore(updater: (s: AppStore) => AppStore): AppStore {
  const store = getStore();
  const next = updater(store);
  saveStore(next);
  return next;
}

export function getSession(): Session | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

export function setSession(session: Session | null): void {
  if (session) {
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } else {
    localStorage.removeItem(SESSION_KEY);
  }
}

export function getConfigValue(store: AppStore, name: string): number {
  const cfg = store.system_config.find((c) => c.config_name === name);
  return cfg ? parseFloat(cfg.config_value) : 0;
}

export function classifyFFA(store: AppStore, result: number): { classification: string; process: ProcessType } {
  const standardMax = getConfigValue(store, 'ffa_standard_max');
  const twopassMax = getConfigValue(store, 'ffa_twopass_max');
  const types = store.process_types;
  if (result <= standardMax) {
    return { classification: 'Low FFA', process: types.find((t) => t.id === 'pt_standard') ?? types[0] };
  }
  if (result <= twopassMax) {
    return { classification: 'Medium FFA', process: types.find((t) => t.id === 'pt_twopass') ?? types[1] };
  }
  return { classification: 'High FFA', process: types.find((t) => t.id === 'pt_acid') ?? types[2] };
}

export function generateBatchCode(store: AppStore): string {
  const year = new Date().getFullYear();
  const count = store.batches.filter((b) => b.batch_code.startsWith(`GV-${year}-`)).length + 1;
  return `GV-${year}-${String(count).padStart(3, '0')}`;
}

export function makeId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

export function getUser(store: AppStore, id: string): User | undefined {
  return store.users.find((u) => u.id === id);
}

export function addAuditLog(
  store: AppStore,
  userId: string,
  userName: string,
  eventType: AuditLog['event_type'],
  description: string,
  batchId?: string,
  metadata?: Record<string, unknown>
): AppStore {
  const log: AuditLog = {
    id: makeId(),
    user_id: userId,
    user_name: userName,
    batch_id: batchId,
    event_type: eventType,
    description,
    metadata,
    timestamp: new Date().toISOString(),
  };
  return { ...store, audit_logs: [log, ...store.audit_logs] };
}

export function addNotification(
  store: AppStore,
  userId: string,
  title: string,
  message: string,
  category: AppNotification['category'],
  severity: AppNotification['severity'] = 'info'
): AppStore {
  const notif: AppNotification = {
    id: makeId(),
    user_id: userId,
    title,
    message,
    category,
    severity,
    read: false,
    timestamp: new Date().toISOString(),
  };
  return { ...store, notifications: [notif, ...store.notifications] };
}

export function getStageName(n: number): string {
  return STAGE_NAMES[n - 1] ?? 'Unknown';
}

export const STAGE_NAMES_LIST = STAGE_NAMES;
