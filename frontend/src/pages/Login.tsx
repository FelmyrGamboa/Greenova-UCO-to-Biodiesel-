import { useState, type FormEvent } from 'react';
import { Link, useNavigate, Navigate } from 'react-router';
import { useAuth } from '../contexts/AuthContext';
import GreenovaLogo from '../components/GreenovaLogo';

export default function Login() {
  const { user, login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [errors, setErrors] = useState<{email?: string, password?: string}>({});
  // const [emailError, setEmailError] = useState('');
  // const [passwordError, setPasswordError] = useState('');

  if (user) return <Navigate to="/dashboard" replace />;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setErrors({});
    const newErrors: {
      email?: string,
      password?: string
    } = {};
    // setEmailError('');
    // setPasswordError('');
    let hasError = false;
    if (!email.trim()) { newErrors.email = 'Email address is required.';}
    if (!password.trim()) { newErrors.password = 'Password is required.';}
    setErrors(newErrors);
    if (Object.keys(newErrors).length > 0) return;

    setLoading(true);
    const res = await login(email, password);
    setLoading(false);

    if (res.ok) navigate('/dashboard');
    else setError(res.error ?? 'Login failed.');
  }

  return (
    <div className="min-h-screen flex">
      {/* Left panel */}
      <div className="hidden lg:flex flex-col flex-1 relative overflow-hidden p-12 justify-between"
        style={{ background: '#070d09' }}
      >
        <div className="absolute inset-0 pointer-events-none" style={{
          backgroundImage: 'linear-gradient(rgba(22,163,74,0.025) 1px, transparent 1px), linear-gradient(90deg, rgba(22,163,74,0.025) 1px, transparent 1px)',
          backgroundSize: '40px 40px',
        }} />

        {/* Logo */}
        <div className="relative">
          <GreenovaLogo size="md" />
        </div>

        {/* Center content */}
        <div className="relative">
          <h1 className="font-display font-bold text-4xl text-white leading-snug mb-4">
            Biodiesel Process<br />
            <span style={{ color: '#4ade80' }}>Monitoring System</span>
          </h1>
          <p className="text-gray-400 text-sm leading-relaxed max-w-sm mb-8">
            Greenova is a small-scale biodiesel processing system with integrated monitoring and process automation. Track each production stage, record batch data, and review historical performance.
          </p>

          {/* Mini dashboard preview */}
          <div className="relative w-full max-w-xs">
            <div className="rounded-xl p-5" style={{ background: 'rgba(13,20,15,0.9)', border: '1px solid rgba(255,255,255,0.07)' }}>
              <div className="flex items-center gap-3 mb-4">
                <div className="w-1.5 h-1.5 rounded-full bg-green-400 gv-pulse" />
                <span className="text-gray-400 text-xs font-mono">SIMULATION MODE</span>
              </div>
              <div className="grid grid-cols-2 gap-3">
                {[
                  { label: 'Temperature', value: '60°C', sub: 'Target' },
                  { label: 'Stirring', value: '450 RPM', sub: 'Active' },
                  { label: 'Progress', value: '65%', sub: 'Reaction' },
                  { label: 'Status', value: 'Running', sub: '● Stage 8' },
                ].map((d) => (
                  <div key={d.label} className="rounded-lg p-3" style={{ background: 'rgba(4,14,8,0.7)', border: '1px solid rgba(255,255,255,0.06)' }}>
                    <div className="text-gray-600 text-[10px] uppercase tracking-wider mb-1">{d.label}</div>
                    <div className="font-mono font-semibold text-green-300 text-sm">{d.value}</div>
                    <div className="text-gray-600 text-[10px] mt-0.5">{d.sub}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="relative text-gray-700 text-xs">
          © 2026 Greenova. All rights reserved.
        </div>
      </div>

      {/* Right panel — auth card */}
      <div className="flex-1 lg:max-w-md xl:max-w-lg flex items-center justify-center p-6 lg:p-10"
        style={{ background: 'rgba(4, 8, 6, 0.97)', borderLeft: '1px solid rgba(255,255,255,0.06)' }}
      >
        <div className="w-full max-w-sm fade-in-up">
          {/* Mobile logo */}
          <div className="flex items-center gap-3 mb-8 lg:hidden">
            <GreenovaLogo size="sm" />
          </div>

          <h2 className="font-display font-bold text-2xl text-white mb-1">Sign in</h2>
          <p className="text-gray-500 text-sm mb-7">Access the Greenova monitoring system</p>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="gv-label">Email Address <span className="text-red-400"> * </span></label>
              <input
                type="email"
                placeholder="Enter your email address"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className={`gv-input ${errors.email ? "!border-red-500" : ""}`}
                autoComplete="email"
              />
              {errors.email && (
                <p className='text-red-400 text-xs mt-1.5'>
                  {errors.email}
                </p>
              )}
            </div>


            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="gv-label mb-0">Password <span className="text-red-400"> * </span></label>
                <Link to="/forgot-password" className="text-[11px] text-green-500 hover:text-green-400 transition-colors">
                  Forgot password?
                </Link>
              </div>
              <div className="relative">
                <input
                  type={showPw ? 'text' : 'password'}
                  placeholder="Enter your password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className={`gv-input ${errors.password ? "!border-red-500" : ""} pr-100`}
                  autoComplete="current-password"
                />
                <button
                  type="button"
                  onClick={() => setShowPw(!showPw)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300 transition-colors"
                  tabIndex={-1}
                >
                  {!showPw ? (
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
              {errors.password && (
                <p className='text-red-400 text-xs mt-1.5'>
                  {errors.password}
                </p>
              )}
            </div>

            {/* {error && (
              <div className="glass rounded-lg px-3 py-2.5 border border-red-500/20 text-red-400 text-sm">
                {error}
              </div>
            )} */}

            <button type="submit" disabled={loading} className="btn-primary w-full justify-center py-3 mt-2">
              {loading ? (
                <>
                  <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  Signing in…
                </>
              ) : 'Sign In'}
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
            Sign in with Google
          </button>

          <p className="text-center text-sm text-gray-500 mt-6">
            {"Don't have an account? "}
            <Link to="/register" className="text-green-400 hover:text-green-300 font-medium transition-colors">
              Register here
            </Link>
          </p>

          <p className="text-center text-xs text-gray-700 mt-8">
            © 2026 Greenova. All rights reserved.
          </p>
        </div>
      </div>
    </div>
  );
}
