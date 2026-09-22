import { Link } from 'react-router';

export default function About() {
  return (
    <div className="min-h-screen p-6 pt-12">
      <div className="max-w-3xl mx-auto">
        <Link to="/" className="text-green-400 text-sm hover:text-green-300 flex items-center gap-2 mb-8">
          <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
            <path fillRule="evenodd" d="M9.707 16.707a1 1 0 01-1.414 0l-6-6a1 1 0 010-1.414l6-6a1 1 0 011.414 1.414L5.414 9H17a1 1 0 110 2H5.414l4.293 4.293a1 1 0 010 1.414z" clipRule="evenodd" />
          </svg>
          Back to Home
        </Link>

        <div className="glass rounded-2xl p-8 fade-in-up">
          <div className="flex items-center gap-4 mb-6">
            <div className="w-12 h-12 rounded-xl flex items-center justify-center" style={{ background: 'linear-gradient(135deg, #16a34a, #22c55e)' }}>
              <svg viewBox="0 0 24 24" fill="none" className="w-7 h-7">
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 15v-4H7l5-8v4h4l-5 8z" fill="white" />
              </svg>
            </div>
            <div>
              <div className="font-display font-extrabold text-2xl text-green-400 tracking-wider">GREENOVA</div>
              <div className="text-gray-500 text-sm">Automated Biodiesel Process Monitoring System</div>
            </div>
          </div>

          <div className="prose prose-invert max-w-none space-y-5 text-gray-400 text-sm leading-relaxed">
            <h2 className="font-display font-bold text-xl text-white">About This System</h2>
            <p>
              Greenova is a web-based monitoring and management system designed for small-scale biodiesel production research.
              Developed as a university research and capstone project, it provides a structured, digitized workflow for managing
              every stage of the biodiesel production process.
            </p>

            <h2 className="font-display font-bold text-xl text-white mt-6">Research Purpose</h2>
            <p>
              The system is intended for use in controlled laboratory and research environments. It supports researchers and
              operators in following approved production protocols while maintaining complete records of every batch,
              parameter decision, and process event.
            </p>

            <h2 className="font-display font-bold text-xl text-white mt-6">Safety Notice</h2>
            <div className="glass rounded-xl p-4 border border-yellow-500/20" style={{ background: 'rgba(234,179,8,0.04)' }}>
              <p className="text-yellow-400 font-medium mb-2">Important</p>
              <p>
                Greenova is a software monitoring and documentation tool. It does not replace laboratory safety procedures,
                institutional safety training, or regulatory compliance requirements. All chemical processes must be conducted
                according to your institution's approved safety protocols.
              </p>
              <p className="mt-2">
                All process parameter ranges and operational values used in this system are configured by authorized
                research personnel and are not invented by the software.
              </p>
            </div>

            <h2 className="font-display font-bold text-xl text-white mt-6">Simulation Mode</h2>
            <p>
              When physical hardware (sensors, controllers) is not connected, the system operates in clearly labeled
              Simulation Mode. Simulated data is never presented as actual laboratory measurements.
            </p>

            <h2 className="font-display font-bold text-xl text-white mt-6">Version</h2>
            <p>Greenova v1.0 · 2026 · Research Prototype</p>
          </div>

          <div className="mt-8 flex gap-4">
            <Link to="/register" className="btn-primary text-sm py-2.5 px-5">Get Started</Link>
            <Link to="/login" className="btn-secondary text-sm py-2.5 px-5">Login</Link>
          </div>
        </div>
      </div>
    </div>
  );
}
