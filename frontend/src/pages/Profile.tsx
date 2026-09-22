import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useAuth } from '../contexts/AuthContext';
import { useData } from '../contexts/DataContext';
import { useToast } from '../contexts/ToastContext';
import { formatDate, getInitials } from '../lib/utils';

export default function Profile() {
  const { user, logout } = useAuth();
  const { updateUser } = useData();
  const { toast } = useToast();
  const navigate = useNavigate();

  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(user?.full_name ?? '');
  const [changingPw, setChangingPw] = useState(false);
  const [currentPw, setCurrentPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [confirmPw, setConfirmPw] = useState('');

  if (!user) return null;

  function handleSave() {
    if (!name.trim()) { toast('Name cannot be empty.', 'error'); return; }
    updateUser({ ...user!, full_name: name });
    setEditing(false);
    toast('Profile updated.', 'success');
  }

  function handleChangePw() {
    if (currentPw !== user!.password_hash) { toast('Current password is incorrect.', 'error'); return; }
    if (newPw.length < 6) { toast('New password must be at least 6 characters.', 'error'); return; }
    if (newPw !== confirmPw) { toast('Passwords do not match.', 'error'); return; }
    updateUser({ ...user!, password_hash: newPw });
    setChangingPw(false);
    setCurrentPw(''); setNewPw(''); setConfirmPw('');
    toast('Password changed successfully.', 'success');
  }

  return (
    <div className="p-6 max-w-2xl mx-auto space-y-6">
      <h1 className="font-display font-bold text-2xl text-white">User Profile</h1>

      {/* Profile card */}
      <div className="glass rounded-2xl p-6">
        <div className="flex items-center gap-5 mb-6">
          <div
            className="w-16 h-16 rounded-2xl flex items-center justify-center text-2xl font-bold text-white flex-shrink-0"
            style={{ background: 'linear-gradient(135deg, #166534, #22c55e)' }}
          >
            {getInitials(user.full_name)}
          </div>
          <div>
            <div className="font-display font-bold text-xl text-white">{user.full_name}</div>
            <div className="text-gray-400 text-sm">{user.email}</div>
            <div className="mt-1">
              <span className="text-xs px-2.5 py-1 rounded-full bg-green-500/10 border border-green-500/20 text-green-400 font-medium">
                {user.role}
              </span>
            </div>
          </div>
        </div>

        <div className="grid sm:grid-cols-2 gap-4 text-sm mb-5">
          <div><div className="gv-label">Account Created</div><div className="text-white">{formatDate(user.created_at)}</div></div>
          <div><div className="gv-label">Account Status</div>
            <span className="text-xs px-2 py-0.5 rounded-full bg-green-500/10 text-green-400 border border-green-500/20">{user.account_status}</span>
          </div>
          <div><div className="gv-label">User ID</div><div className="font-mono text-gray-500 text-xs">{user.id}</div></div>
        </div>

        {editing ? (
          <div className="space-y-3">
            <div>
              <label className="gv-label">Full Name</label>
              <input type="text" value={name} onChange={(e) => setName(e.target.value)} className="gv-input" />
            </div>
            <div className="flex gap-3">
              <button onClick={handleSave} className="btn-primary text-sm py-2 px-4">Save Changes</button>
              <button onClick={() => { setEditing(false); setName(user.full_name); }} className="btn-ghost text-sm py-2 px-4">Cancel</button>
            </div>
          </div>
        ) : (
          <button onClick={() => setEditing(true)} className="btn-secondary text-sm py-2 px-4">Edit Profile</button>
        )}
      </div>

      {/* Security */}
      <div className="glass rounded-2xl p-6">
        <h2 className="font-display font-semibold text-white mb-4">Account Security</h2>

        {changingPw ? (
          <div className="space-y-3">
            <div>
              <label className="gv-label">Current Password</label>
              <input type="password" value={currentPw} onChange={(e) => setCurrentPw(e.target.value)} className="gv-input" />
            </div>
            <div>
              <label className="gv-label">New Password</label>
              <input type="password" value={newPw} onChange={(e) => setNewPw(e.target.value)} className="gv-input" />
            </div>
            <div>
              <label className="gv-label">Confirm New Password</label>
              <input type="password" value={confirmPw} onChange={(e) => setConfirmPw(e.target.value)} className="gv-input" />
            </div>
            <div className="flex gap-3">
              <button onClick={handleChangePw} className="btn-primary text-sm py-2 px-4">Change Password</button>
              <button onClick={() => setChangingPw(false)} className="btn-ghost text-sm py-2 px-4">Cancel</button>
            </div>
          </div>
        ) : (
          <button onClick={() => setChangingPw(true)} className="btn-secondary text-sm py-2 px-4">Change Password</button>
        )}
      </div>

      {/* Danger zone */}
      <div className="glass rounded-2xl p-6">
        <h2 className="font-display font-semibold text-white mb-4">Session</h2>
        <button
          onClick={() => { logout(); navigate('/login'); }}
          className="btn-danger text-sm py-2 px-4"
        >
          <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
            <path fillRule="evenodd" d="M3 3a1 1 0 00-1 1v12a1 1 0 102 0V4a1 1 0 00-1-1zm10.293 9.293a1 1 0 001.414 1.414l3-3a1 1 0 000-1.414l-3-3a1 1 0 10-1.414 1.414L14.586 9H7a1 1 0 100 2h7.586l-1.293 1.293z" clipRule="evenodd" />
          </svg>
          Logout
        </button>
      </div>
    </div>
  );
}
