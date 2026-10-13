export type UserRole = 'Administrator' | 'Researcher' | 'Operator';
export type AccountStatus = 'active' | 'inactive';

export interface User {
  id: string;
  full_name: string;
  email: string;
  password_hash: string;
  role: UserRole;
  profile_image?: string;
  created_at: string;
  updated_at: string;
  account_status: AccountStatus;
}

export type BatchStatus =
  | 'Draft'
  | 'Ready'
  | 'In Progress'
  | 'Paused'
  | 'Completed'
  | 'Stopped'
  | 'Error';

export type StageStatus = 'pending' | 'current' | 'completed' | 'error';

export interface ProcessStage {
  stage_number: number;
  stage_name: string;
  status: StageStatus;
  started_at?: string;
  completed_at?: string;
  notes?: string;
  data?: Record<string, unknown>;
}

export interface ProcessParameters {
  temperature_target: number;
  reaction_duration: number;
  stirring_speed: number;
  preset_type: 'default' | 'custom';
}

export interface FFATest {
  result: number;
  unit: string;
  classification: string;
  recommended_process: string;
  recorded_at: string;
  recorded_by: string;
}

export interface Batch {
  id: string;
  batch_code: string;
  user_id: string;
  status: BatchStatus;
  current_step: number;
  process_type: string;
  process_override?: string;
  override_reason?: string;
  initial_volume: number;
  methanol_ratio: string;
  catalyst_percentage: number;
  ffa_test?: FFATest;
  parameters?: ProcessParameters;
  stages: ProcessStage[];
  preparation_checklist: ChecklistItem[];
  dry_wash_amount?: number;
  dry_wash_cycles?: number;
  started_at?: string;
  completed_at?: string;
  duration?: number;
  created_at: string;
  updated_at: string;
  notes?: string;
}

export interface ChecklistItem {
  id: string;
  label: string;
  completed: boolean;
  completed_at?: string;
}

export type AlertSeverity = 'normal' | 'warning' | 'critical' | 'disconnected';

export interface ProcessAlert {
  id: string;
  batch_id?: string;
  parameter: string;
  severity: AlertSeverity;
  message: string;
  timestamp: string;
  acknowledged: boolean;
}

export interface SensorReading {
  id: string;
  batch_id: string;
  sensor_type: string;
  value: number;
  unit: string;
  timestamp: string;
  data_source: 'simulation' | 'live' | 'manual';
}

export type NotificationCategory =
  | 'Process Update'
  | 'Process Complete'
  | 'Parameter Warning'
  | 'System Warning'
  | 'Batch Saved'
  | 'Report Generated'
  | 'System Connection';

export type NotificationSeverity = 'info' | 'warning' | 'critical';

export interface AppNotification {
  id: string;
  user_id: string;
  title: string;
  message: string;
  category: NotificationCategory;
  severity: NotificationSeverity;
  read: boolean;
  timestamp: string;
}

export type AuditEventType =
  | 'Login'
  | 'Logout'
  | 'Batch Created'
  | 'Batch Updated'
  | 'Batch Completed'
  | 'Batch Stopped'
  | 'Stage Completed'
  | 'Parameter Changed'
  | 'Process Paused'
  | 'Process Resumed'
  | 'Override Logged'
  | 'Report Generated'
  | 'Config Changed'
  | 'User Created'
  | 'User Updated'
  | 'Password Changed';

export interface AuditLog {
  id: string;
  user_id: string;
  user_name: string;
  batch_id?: string;
  event_type: AuditEventType;
  description: string;
  metadata?: Record<string, unknown>;
  timestamp: string;
}

export interface SystemConfig {
  id: string;
  config_name: string;
  config_value: string;
  category: string;
  updated_by: string;
  updated_at: string;
}

export interface ProcessType {
  id: string;
  name: string;
  description: string;
  ffa_range_min: number;
  ffa_range_max: number;
}

export interface AppStore {
  users: User[];
  batches: Batch[];
  audit_logs: AuditLog[];
  notifications: AppNotification[];
  alerts: ProcessAlert[];
  sensor_readings: SensorReading[];
  system_config: SystemConfig[];
  process_types: ProcessType[];
  initialized: boolean;
}

export interface Session {
  user_id: string;
  token: string;
  created_at: string;
}
