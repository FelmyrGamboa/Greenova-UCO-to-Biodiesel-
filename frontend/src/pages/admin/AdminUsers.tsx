import { useState } from 'react';
import { useData } from '../../contexts/DataContext';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import { makeId } from '../../lib/store';
import StatusBadge from '../../components/StatusBadge';
import ConfirmModal from '../../components/ConfirmModal';
import type { User, UserRole } from '../../lib/types';
import { formatDate, getInitials } from '../../lib/utils';

export default function AdminUsers() {
  const { store, updateUser, getUsers } = useData();
  const { user: currentUser } = useAuth();
  const { toast } = useToast();
  const [creating, setCreating] = useState(false);
  const [deactivateTarget, setDeactivateTarget] = useState<User | null>(null);
  const [newName, setNewName] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [newRole, setNewRole] = useState<UserRole>('Operator');
  const [newPw, setNewPw] = useState('');

  const users = getUsers();

  function handleCreate() {
    if (!newName || !newEmail || !newPw) { toast('All fields required.', 'error'); return; }
    if (users.find((u) => u.email.toLowerCase() === newEmail.toLowerCase())) {
      toast('Email already exists.', 'error'); return;
    }
    const newUser: User = {
      id: makeId(),
      full_name: newName,
      email: newEmail,
      password_hash: newPw,
      role: newRole,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      account_status: 'active',
    };
    updateUser(newUser);
    setCreating(false); setNewName(''); setNewEmail(''); setNewPw(''); setNewRole('Operator');
    toast('User created.', 'success');
  }

  function handleToggleStatus(u: User) {
    const next: User = { ...u, account_status: u.account_status === 'active' ? 'inactive' : 'active', updated_at: new Date().toISOString() };
    updateUser(next);
    toast(`User ${next.account_status === 'active' ? 'activated' : 'deactivated'}.`, 'info');
    setDeactivateTarget(null);
  }

  function handleChangeRole(u: User, role: UserRole) {
    updateUser({ ...u, role, updated_at: new Date().toISOString() });
    toast('Role updated.', 'success');
  }

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="font-display font-bold text-2xl text-white">User Management</h1>
        <button onClick={() => setCreating(!creating)} className="btn-primary text-sm">+ Create User</button>
      </div>

      {creating && (
        <div className="glass rounded-2xl p-6 space-y-4">
          <h2 className="font-display font-semibold text-white">New User</h2>
          <div className="grid sm:grid-cols-2 gap-4">
            <div><label className="gv-label">Full Name</label><input type="text" value={newName} onChange={(e) => setNewName(e.target.value)} className="gv-input" /></div>
            <div><label className="gv-label">Email</label><input type="email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} className="gv-input" /></div>
            <div>
              <label className="gv-label">Role</label>
              <select value={newRole} onChange={(e) => setNewRole(e.target.value as UserRole)} className="gv-select">
                <option>Administrator</option><option>Researcher</option><option>Operator</option>
              </select>
            </div>
            <div><label className="gv-label">Password</label><input type="password" value={newPw} onChange={(e) => setNewPw(e.target.value)} className="gv-input" /></div>
          </div>
          <div className="flex gap-3">
            <button onClick={handleCreate} className="btn-primary text-sm py-2 px-4">Create User</button>
            <button onClick={() => setCreating(false)} className="btn-ghost text-sm py-2 px-4">Cancel</button>
          </div>
        </div>
      )}

      <div className="glass rounded-2xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="gv-table">
            <thead>
              <tr><th>User</th><th>Role</th><th>Status</th><th className="hidden sm:table-cell">Joined</th><th>Actions</th></tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td>
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold text-white flex-shrink-0" style={{ background: 'linear-gradient(135deg, #166534, #22c55e)' }}>
                        {getInitials(u.full_name)}
                      </div>
                      <div>
                        <div className="text-white text-sm font-medium">{u.full_name}</div>
                        <div className="text-gray-500 text-xs">{u.email}</div>
                      </div>
                    </div>
                  </td>
                  <td>
                    <select
                      value={u.role}
                      onChange={(e) => handleChangeRole(u, e.target.value as UserRole)}
                      disabled={u.id === currentUser?.id}
                      className="gv-select text-xs py-1 px-2 w-auto"
                      style={{ width: 'auto' }}
                    >
                      <option>Administrator</option><option>Researcher</option><option>Operator</option>
                    </select>
                  </td>
                  <td><StatusBadge status={u.account_status} size="sm" /></td>
                  <td className="hidden sm:table-cell text-gray-500 text-xs">{formatDate(u.created_at)}</td>
                  <td>
                    {u.id !== currentUser?.id && (
                      <button
                        onClick={() => u.account_status === 'active' ? setDeactivateTarget(u) : handleToggleStatus(u)}
                        className={`text-xs font-medium transition-colors ${u.account_status === 'active' ? 'text-red-400 hover:text-red-300' : 'text-green-400 hover:text-green-300'}`}
                      >
                        {u.account_status === 'active' ? 'Deactivate' : 'Activate'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {deactivateTarget && (
        <ConfirmModal
          title="Deactivate User"
          message={`Are you sure you want to deactivate ${deactivateTarget.full_name}? They will not be able to log in.`}
          confirmLabel="Deactivate"
          danger
          onConfirm={() => handleToggleStatus(deactivateTarget)}
          onCancel={() => setDeactivateTarget(null)}
        />
      )}
    </div>
  );
}
