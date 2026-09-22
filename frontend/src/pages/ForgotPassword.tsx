import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';

export default function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (!email) { setError('Email address is required.'); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { setError('Please enter a valid email address.'); return; }
    setLoading(true);
    await new Promise((r) => setTimeout(r, 1000));
    setLoading(false);
    setSent(true);
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-6 bg-blob bg-grid">
      <div className="w-full max-w-md fade-in-up">
        <div className="flex items-center gap-3 justify-center mb-8">
          <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ background: 'linear-gradient(135deg, #16a34a, #22c55e)' }}>
            <svg viewBox="0 0 24 24" fill="none" className="w-6 h-6">
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 15v-4H7l5-8v4h4l-5 8z" fill="white" />
            </svg>
          </div>
          <div className="font-display font-bold text-green-400 tracking-widest text-xl">GREENOVA</div>
        </div>

        <div className="glass rounded-2xl p-8">
          {sent ? (
            <div className="text-center fade-in">
              <div className="w-14 h-14 rounded-full bg-green-500/15 border border-green-500/30 flex items-center justify-center mx-auto mb-4">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-7 h-7 text-green-400">
                  <path d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </div>
              <h2 className="font-display font-bold text-xl text-white mb-2">Check Your Email</h2>
              <p className="text-gray-400 text-sm mb-6">
                If an account exists for <span className="text-green-400">{email}</span>, a password reset link has been sent.
              </p>
              <p className="text-gray-600 text-xs mb-6">Didn't receive it? Check your spam folder or try again.</p>
              <button onClick={() => setSent(false)} className="btn-secondary w-full justify-center py-2.5 text-sm">
                Try Another Email
              </button>
            </div>
          ) : (
            <>
              <div className="w-12 h-12 rounded-xl bg-green-500/10 border border-green-500/20 flex items-center justify-center mb-4">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="w-6 h-6 text-green-400">
                  <path d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </div>
              <h2 className="font-display font-bold text-2xl text-white mb-1">Forgot your password?</h2>
              <p className="text-gray-500 text-sm mb-6">Enter your email address and we'll help you recover your account.</p>

              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <label className="gv-label">Email Address</label>
                  <input
                    type="email"
                    placeholder="you@example.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="gv-input"
                    autoComplete="email"
                  />
                </div>

                {error && (
                  <div className="glass rounded-lg px-3 py-2.5 border border-red-500/20 text-red-400 text-sm">{error}</div>
                )}

                <button type="submit" disabled={loading} className="btn-primary w-full justify-center py-3">
                  {loading ? (
                    <><svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg> Sending…</>
                  ) : 'Send Reset Link'}
                </button>
              </form>
            </>
          )}
        </div>

        <p className="text-center text-sm text-gray-500 mt-6">
          <Link to="/login" className="text-green-400 hover:text-green-300 font-medium transition-colors">← Back to Login</Link>
        </p>
      </div>
    </div>
  );
}
