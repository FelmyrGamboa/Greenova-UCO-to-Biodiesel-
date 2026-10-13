import { useState, type FormEvent } from 'react';
import { Link, useNavigate, Navigate } from 'react-router';
import { useAuth } from '../contexts/AuthContext';

export default function Register() {
  const { user, register } = useAuth();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [showPw, setShowPw] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  if (user) return <Navigate to="/dashboard" replace />;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (!name.trim()) { setError('Full name is required.'); return; }
    if (!email) { setError('Email address is required.'); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { setError('Please enter a valid email address.'); return; }
    if (password.length < 6) { setError('Password must be at least 6 characters.'); return; }
    if (password !== confirm) { setError('Passwords do not match.'); return; }
    if (!agreed) { setError('Please agree to the Terms and Privacy Policy.'); return; }
    setLoading(true);
    const res = await register(name, email, password);
    setLoading(false);
    if (res.ok) navigate('/dashboard');
    else setError(res.error ?? 'Registration failed.');
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-6 bg-blob bg-grid">
      <div className="w-full max-w-md fade-in-up">
        <div className="flex items-center justify-center mb-8">
          <span className="font-display font-extrabold text-3xl" style={{ letterSpacing: '-0.01em' }}>
            <span style={{ color: '#ffffff' }}>Green</span><span style={{ color: '#01AB4A' }}>ova</span>
          </span>
        </div>

        <div className="glass rounded-2xl p-8">
          <h2 className="font-display font-bold text-2xl text-white mb-1">Create your Account</h2>
          <p className="text-gray-500 text-sm mb-6">Join the Greenova research platform</p>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="gv-label">Full Name</label>
              <input type="text" placeholder="Juan Dela Cruz" value={name} onChange={(e) => setName(e.target.value)} className="gv-input" autoComplete="name" />
            </div>

            <div>
              <label className="gv-label">Email Address</label>
              <input type="email" placeholder="juan.delacruz@example.com" value={email} onChange={(e) => setEmail(e.target.value)} className="gv-input" autoComplete="email" />
            </div>

            <div>
              <label className="gv-label">Password</label>
              <div className="relative">
                <input
                  type={showPw ? 'text' : 'password'}
                  placeholder="Min. 6 characters"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="gv-input pr-10"
                  autoComplete="new-password"
                />
                <button type="button" onClick={() => setShowPw(!showPw)} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300" tabIndex={-1}>
                  {showPw ? (
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4">
                      <path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24" strokeLinecap="round" /><path d="M1 1l22 22" strokeLinecap="round" />
                    </svg>
                  ) : (
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4">
                      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" strokeLinecap="round" /><circle cx="12" cy="12" r="3" />
                    </svg>
                  )}
                </button>
              </div>
            </div>

            <div>
              <label className="gv-label">Confirm Password</label>
              <input type="password" placeholder="Repeat password" value={confirm} onChange={(e) => setConfirm(e.target.value)} className="gv-input" autoComplete="new-password" />
            </div>

            <label className="flex items-start gap-3 cursor-pointer">
              <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} className="gv-checkbox mt-0.5" />
              <span className="text-sm text-gray-400">
                I agree to the{' '}
                <span className="text-green-400 hover:text-green-300 cursor-pointer">Terms</span>
                {' '}and{' '}
                <span className="text-green-400 hover:text-green-300 cursor-pointer">Privacy Policy</span>
              </span>
            </label>

            {error && (
              <div className="glass rounded-lg px-3 py-2.5 border border-red-500/20 text-red-400 text-sm">{error}</div>
            )}

            <button type="submit" disabled={loading} className="btn-primary w-full justify-center py-3">
              {loading ? (
                <><svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg> Creating account…</>
              ) : 'Create Account'}
            </button>
          </form>

          <div className="flex items-center gap-3 my-5">
            <div className="flex-1 separator" />
            <span className="text-gray-600 text-xs">OR</span>
            <div className="flex-1 separator" />
          </div>

          <button className="btn-ghost w-full justify-center py-3">
            <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none">
              <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
              <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
              <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
              <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
            </svg>
            Continue with Google
          </button>
        </div>

        <p className="text-center text-sm text-gray-500 mt-6">
          Already have an account?{' '}
          <Link to="/login" className="text-green-400 hover:text-green-300 font-medium transition-colors">Login</Link>
        </p>
      </div>
    </div>
  );
}
