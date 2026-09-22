import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';
import {
  getStore,
  updateStore,
  addAuditLog,
  addNotification,
  generateBatchCode,
  makeId,
  classifyFFA,
  STAGE_NAMES_LIST,
} from '../lib/store';
import type {
  AppStore,
  Batch,
  BatchStatus,
  ProcessStage,
  AppNotification,
  AuditLog,
  ProcessAlert,
  SystemConfig,
  User,
} from '../lib/types';
import { useAuth } from './AuthContext';

interface DataContextValue {
  store: AppStore;
  refresh: () => void;
  createBatch: () => Batch;
  updateBatch: (batch: Batch) => void;
  getBatch: (id: string) => Batch | undefined;
  getActiveBatch: () => Batch | undefined;
  markStageComplete: (batchId: string, step: number) => void;
  markBatchStatus: (batchId: string, status: BatchStatus) => void;
  getNotifications: (userId: string) => AppNotification[];
  markNotificationRead: (id: string) => void;
  markAllNotificationsRead: (userId: string) => void;
  getAuditLogs: () => AuditLog[];
  getAlerts: () => ProcessAlert[];
  acknowledgeAlert: (id: string) => void;
  getConfig: (name: string) => number;
  updateConfig: (name: string, value: string) => void;
  getUsers: () => User[];
  updateUser: (user: User) => void;
}

const DataContext = createContext<DataContextValue | null>(null);

function makeStages(): ProcessStage[] {
  return STAGE_NAMES_LIST.map((name, i) => ({
    stage_number: i + 1,
    stage_name: name,
    status: 'pending' as const,
  }));
}

export function DataProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [store, setStore] = useState<AppStore>(() => getStore());

  const refresh = useCallback(() => {
    setStore(getStore());
  }, []);

  const createBatch = useCallback((): Batch => {
    if (!user) throw new Error('Not authenticated');
    const current = getStore();
    const batch: Batch = {
      id: makeId(),
      batch_code: generateBatchCode(current),
      user_id: user.id,
      status: 'Draft',
      current_step: 1,
      process_type: '',
      initial_volume: 0,
      methanol_ratio: '6:1',
      catalyst_percentage: 1,
      stages: makeStages(),
      preparation_checklist: [
        { id: makeId(), label: 'Required materials and equipment verified', completed: false },
        { id: makeId(), label: 'Work area inspected and prepared', completed: false },
        { id: makeId(), label: 'Catalyst preparation completed', completed: false },
        { id: makeId(), label: 'Catalyst dissolved in methanol — confirmed', completed: false },
        { id: makeId(), label: 'Oil volume measured and ready', completed: false },
        { id: makeId(), label: 'Safety equipment in place', completed: false },
      ],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    let next = { ...current, batches: [...current.batches, batch] };
    next = addAuditLog(next, user.id, user.full_name, 'Batch Created', `Batch ${batch.batch_code} created`, batch.id);
    next = addNotification(next, user.id, 'Batch Created', `Batch ${batch.batch_code} has been created.`, 'Batch Saved');
    saveLocalStore(next);
    setStore(next);
    return batch;
  }, [user]);

  const updateBatch = useCallback(
    (batch: Batch) => {
      const next = updateStore((s) => ({
        ...s,
        batches: s.batches.map((b) => (b.id === batch.id ? { ...batch, updated_at: new Date().toISOString() } : b)),
      }));
      setStore(next);
    },
    []
  );

  const getBatch = useCallback(
    (id: string): Batch | undefined => {
      return store.batches.find((b) => b.id === id);
    },
    [store]
  );

  const getActiveBatch = useCallback((): Batch | undefined => {
    return store.batches.find((b) => b.status === 'In Progress' || b.status === 'Paused');
  }, [store]);

  const markStageComplete = useCallback(
    (batchId: string, step: number) => {
      const next = updateStore((s) => {
        const batch = s.batches.find((b) => b.id === batchId);
        if (!batch) return s;
        const stages = batch.stages.map((st) => {
          if (st.stage_number === step) {
            return { ...st, status: 'completed' as const, completed_at: new Date().toISOString() };
          }
          if (st.stage_number === step + 1) {
            return { ...st, status: 'current' as const, started_at: new Date().toISOString() };
          }
          return st;
        });
        const updBatch = { ...batch, stages, current_step: step + 1, updated_at: new Date().toISOString() };
        return { ...s, batches: s.batches.map((b) => (b.id === batchId ? updBatch : b)) };
      });
      setStore(next);
    },
    []
  );

  const markBatchStatus = useCallback(
    (batchId: string, status: BatchStatus) => {
      if (!user) return;
      const next = updateStore((s) => {
        const batch = s.batches.find((b) => b.id === batchId);
        if (!batch) return s;
        const updBatch: Batch = {
          ...batch,
          status,
          updated_at: new Date().toISOString(),
          ...(status === 'Completed' ? { completed_at: new Date().toISOString() } : {}),
        };
        let ns = { ...s, batches: s.batches.map((b) => (b.id === batchId ? updBatch : b)) };
        ns = addAuditLog(ns, user.id, user.full_name, status === 'Completed' ? 'Batch Completed' : status === 'Stopped' ? 'Batch Stopped' : 'Batch Updated', `Batch ${batch.batch_code} status → ${status}`, batchId);
        return ns;
      });
      setStore(next);
    },
    [user]
  );

  const getNotifications = useCallback(
    (userId: string): AppNotification[] => {
      return store.notifications.filter((n) => n.user_id === userId).sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    },
    [store]
  );

  const markNotificationRead = useCallback((id: string) => {
    const next = updateStore((s) => ({
      ...s,
      notifications: s.notifications.map((n) => (n.id === id ? { ...n, read: true } : n)),
    }));
    setStore(next);
  }, []);

  const markAllNotificationsRead = useCallback((userId: string) => {
    const next = updateStore((s) => ({
      ...s,
      notifications: s.notifications.map((n) => (n.user_id === userId ? { ...n, read: true } : n)),
    }));
    setStore(next);
  }, []);

  const getAuditLogs = useCallback((): AuditLog[] => {
    return [...store.audit_logs].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  }, [store]);

  const getAlerts = useCallback((): ProcessAlert[] => {
    return store.alerts;
  }, [store]);

  const acknowledgeAlert = useCallback((id: string) => {
    const next = updateStore((s) => ({
      ...s,
      alerts: s.alerts.map((a) => (a.id === id ? { ...a, acknowledged: true } : a)),
    }));
    setStore(next);
  }, []);

  const getConfig = useCallback(
    (name: string): number => {
      const cfg = store.system_config.find((c) => c.config_name === name);
      return cfg ? parseFloat(cfg.config_value) : 0;
    },
    [store]
  );

  const updateConfig = useCallback(
    (name: string, value: string) => {
      if (!user) return;
      const next = updateStore((s) => {
        const exists = s.system_config.find((c) => c.config_name === name);
        let config: SystemConfig[];
        if (exists) {
          config = s.system_config.map((c) =>
            c.config_name === name ? { ...c, config_value: value, updated_by: user.id, updated_at: new Date().toISOString() } : c
          );
        } else {
          config = [
            ...s.system_config,
            {
              id: makeId(),
              config_name: name,
              config_value: value,
              category: 'General',
              updated_by: user.id,
              updated_at: new Date().toISOString(),
            },
          ];
        }
        let ns = { ...s, system_config: config };
        ns = addAuditLog(ns, user.id, user.full_name, 'Config Changed', `Config "${name}" changed to "${value}"`);
        return ns;
      });
      setStore(next);
    },
    [user]
  );

  const getUsers = useCallback((): User[] => {
    return store.users;
  }, [store]);

  const updateUser = useCallback((u: User) => {
    const next = updateStore((s) => ({
      ...s,
      users: s.users.map((x) => (x.id === u.id ? { ...u, updated_at: new Date().toISOString() } : x)),
    }));
    setStore(next);
  }, []);

  return (
    <DataContext.Provider
      value={{
        store,
        refresh,
        createBatch,
        updateBatch,
        getBatch,
        getActiveBatch,
        markStageComplete,
        markBatchStatus,
        getNotifications,
        markNotificationRead,
        markAllNotificationsRead,
        getAuditLogs,
        getAlerts,
        acknowledgeAlert,
        getConfig,
        updateConfig,
        getUsers,
        updateUser,
      }}
    >
      {children}
    </DataContext.Provider>
  );
}

function saveLocalStore(s: AppStore): void {
  localStorage.setItem('greenova_store', JSON.stringify(s));
}

export function useData(): DataContextValue {
  const ctx = useContext(DataContext);
  if (!ctx) throw new Error('useData must be used inside DataProvider');
  return ctx;
}

export { classifyFFA };
