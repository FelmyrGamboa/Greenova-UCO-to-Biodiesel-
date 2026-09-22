import { Link } from 'react-router';

const features = [
  {
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="w-6 h-6">
        <path d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
    title: 'Real-Time Monitoring',
    desc: 'Track temperature, stirring speed, and process progress live — or simulate for demonstration.',
  },
  {
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="w-6 h-6">
        <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
    title: '12-Stage Guided Workflow',
    desc: 'Step-by-step process wizard from FFA testing through filtration, with data saved at every stage.',
  },
  {
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="w-6 h-6">
        <path d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
    title: 'Research-Grade Safety',
    desc: 'All process parameters configured by authorized research personnel. Simulation data clearly labeled.',
  },
  {
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="w-6 h-6">
        <path d="M7 21h10M12 3v18M3 9l4 4 5-5 5 5 4-4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
    title: 'FFA-Based Process Selection',
    desc: 'Automated process pathway recommendation based on recorded FFA test results and configured rules.',
  },
  {
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="w-6 h-6">
        <path d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
    title: 'Automated Reports',
    desc: 'Generate production reports with batch history, stage timelines, parameters, and audit logs.',
  },
  {
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="w-6 h-6">
        <path d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
    title: 'Role-Based Access',
    desc: 'Administrator, Researcher, and Operator roles with appropriate access and audit trail.',
  },
];

const objectives = [
  'Digitize and standardize the small-scale biodiesel production workflow',
  'Provide clear process pathway selection based on FFA testing results',
  'Enable real-time or simulated monitoring of key process parameters',
  'Maintain a complete audit trail of all batch activity and parameter changes',
  'Generate structured reports suitable for academic research documentation',
  'Support future integration with physical laboratory sensors and controllers',
];

const workflow = [
  { step: '01', label: 'FFA Test', desc: 'Record and classify feedstock quality' },
  { step: '02', label: 'Process Selection', desc: 'Research-approved pathway recommendation' },
  { step: '03', label: 'Volume & Parameters', desc: 'Enter and validate production parameters' },
  { step: '04', label: 'Guided Production', desc: 'Step-by-step process monitoring' },
  { step: '05', label: 'Report & History', desc: 'Complete audit trail and report generation' },
];

export default function Home() {
  return (
    <div className="min-h-screen text-white">
      {/* Nav */}
      <nav className="fixed top-0 left-0 right-0 z-50 flex items-center justify-between px-6 py-4"
        style={{ background: 'rgba(4,8,6,0.85)', backdropFilter: 'blur(12px)', borderBottom: '1px solid rgba(34,197,94,0.08)' }}
      >
        <div className="flex items-center">
          <span className="font-display font-extrabold text-2xl" style={{ letterSpacing: '-0.01em' }}>
            <span style={{ color: '#ffffff' }}>Green</span><span style={{ color: '#01AB4A' }}>ova</span>
          </span>
        </div>
        <div className="flex items-center gap-3">
          <Link to="/about" className="text-gray-400 text-sm hover:text-green-400 transition-colors hidden sm:block">About</Link>
          <Link to="/login" className="btn-ghost text-sm py-2 px-4">Login</Link>
          <Link to="/register" className="btn-primary text-sm py-2 px-4">Get Started</Link>
        </div>
      </nav>

      {/* Hero */}
      <section className="pt-32 pb-24 px-6 relative overflow-hidden">
        <div className="absolute inset-0 pointer-events-none">
          <div className="absolute top-1/4 left-1/4 w-96 h-96 rounded-full opacity-10 blur-3xl" style={{ background: '#22c55e' }} />
          <div className="absolute bottom-1/4 right-1/4 w-64 h-64 rounded-full opacity-7 blur-3xl" style={{ background: '#84cc16' }} />
        </div>
        <div className="max-w-4xl mx-auto text-center relative">
          <h1 className="font-display font-extrabold text-5xl sm:text-6xl lg:text-7xl leading-tight mb-6 text-glow">
            <span className="text-white">Automated </span>
            <span className="text-green-400">Biodiesel</span>
            <br />
            <span className="text-white">Process Monitoring</span>
          </h1>
          <p className="text-gray-400 text-lg sm:text-xl max-w-2xl mx-auto leading-relaxed mb-10">
            Smart monitoring for cleaner, more efficient, and sustainable biodiesel production.
            Greenova guides your research workflow from FFA testing through completion.
          </p>
          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <Link to="/register" className="btn-primary py-3.5 px-8 text-base">
              <svg viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5">
                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-11a1 1 0 10-2 0v2H7a1 1 0 100 2h2v2a1 1 0 102 0v-2h2a1 1 0 100-2h-2V7z" clipRule="evenodd" />
              </svg>
              Get Started
            </Link>
            <Link to="/login" className="btn-secondary py-3.5 px-8 text-base">
              Login to Dashboard
            </Link>
          </div>

        </div>
      </section>

      {/* About */}
      <section className="py-20 px-6">
        <div className="max-w-4xl mx-auto">
          <div className="text-center mb-12">
            <div className="text-green-500 text-xs uppercase tracking-widest font-semibold mb-3">About Greenova</div>
            <h2 className="font-display font-bold text-3xl sm:text-4xl text-white mb-4">Research Background</h2>
            <p className="text-gray-400 text-base max-w-2xl mx-auto leading-relaxed">
              Greenova is a web-based monitoring and management system designed specifically for small-scale biodiesel production research.
              It digitizes the production workflow, ensures process integrity, and provides structured documentation for academic research.
            </p>
          </div>

          <div className="grid md:grid-cols-2 gap-6">
            <div className="glass rounded-2xl p-6">
              <h3 className="font-display font-bold text-white mb-3">System Objectives</h3>
              <ul className="space-y-2.5">
                {objectives.map((o, i) => (
                  <li key={i} className="flex items-start gap-3 text-sm text-gray-400">
                    <div className="w-5 h-5 rounded-full bg-green-500/15 border border-green-500/25 flex items-center justify-center flex-shrink-0 mt-0.5">
                      <svg viewBox="0 0 20 20" fill="currentColor" className="w-3 h-3 text-green-400">
                        <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                      </svg>
                    </div>
                    {o}
                  </li>
                ))}
              </ul>
            </div>

            <div className="glass rounded-2xl p-6">
              <h3 className="font-display font-bold text-white mb-3">Safety & Integrity</h3>
              <div className="space-y-4 text-sm text-gray-400">
                <div className="glass rounded-xl p-4 border border-yellow-500/15" style={{ background: 'rgba(234,179,8,0.04)' }}>
                  <div className="text-yellow-400 font-semibold mb-1.5 flex items-center gap-2">
                    <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                      <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                    </svg>
                    Research Safety Requirement
                  </div>
                  <p>Greenova does not invent chemical recipes, hazardous instructions, or process parameters. All operational values are configured by authorized research personnel.</p>
                </div>
                <p>When physical hardware is unavailable, the system runs in clearly labeled <strong className="text-yellow-400">Simulation Mode</strong> — never presenting simulated data as real sensor measurements.</p>
                <p>Every parameter change and process action is recorded in the audit log with timestamp, user, and context.</p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* How it works */}
      <section className="py-20 px-6" style={{ background: 'rgba(8,20,12,0.5)' }}>
        <div className="max-w-4xl mx-auto text-center mb-12">
          <div className="text-green-500 text-xs uppercase tracking-widest font-semibold mb-3">How It Works</div>
          <h2 className="font-display font-bold text-3xl sm:text-4xl text-white">Production Workflow</h2>
        </div>
        <div className="max-w-4xl mx-auto">
          <div className="flex flex-col md:flex-row gap-4">
            {workflow.map((w, i) => (
              <div key={i} className="flex-1 glass rounded-2xl p-5 text-center relative">
                <div className="font-mono text-green-400/40 text-3xl font-bold mb-2">{w.step}</div>
                <div className="font-display font-bold text-white text-sm mb-1">{w.label}</div>
                <div className="text-gray-500 text-xs leading-relaxed">{w.desc}</div>
                {i < workflow.length - 1 && (
                  <div className="hidden md:block absolute -right-3 top-1/2 -translate-y-1/2 z-10 text-green-600">›</div>
                )}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Features */}
      <section className="py-20 px-6">
        <div className="max-w-5xl mx-auto">
          <div className="text-center mb-12">
            <div className="text-green-500 text-xs uppercase tracking-widest font-semibold mb-3">Platform Features</div>
            <h2 className="font-display font-bold text-3xl sm:text-4xl text-white">Key Features</h2>
          </div>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {features.map((f, i) => (
              <div key={i} className="glass glass-hover rounded-2xl p-6 transition-all">
                <div className="w-10 h-10 rounded-xl bg-green-500/10 border border-green-500/20 flex items-center justify-center text-green-400 mb-4">
                  {f.icon}
                </div>
                <h3 className="font-display font-bold text-white text-sm mb-2">{f.title}</h3>
                <p className="text-gray-500 text-sm leading-relaxed">{f.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="py-20 px-6">
        <div className="max-w-2xl mx-auto text-center">
          <div className="glass rounded-3xl p-10 glow-green-sm">
            <div className="font-display font-bold text-3xl text-white mb-3">Start Monitoring Today</div>
            <p className="text-gray-400 text-base mb-8">
              Set up your research environment in minutes. Use the demo credentials to explore the full system.
            </p>
            <div className="flex flex-col sm:flex-row gap-4 justify-center">
              <Link to="/register" className="btn-primary py-3.5 px-8">Create Account</Link>
              <Link to="/login" className="btn-secondary py-3.5 px-8">Login</Link>
            </div>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="py-8 px-6 text-center" style={{ borderTop: '1px solid rgba(34,197,94,0.08)' }}>
        <div className="text-gray-600 text-sm">© 2026 Greenova. All rights reserved.</div>
      </footer>
    </div>
  );
}
