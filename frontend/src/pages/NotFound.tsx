import { Link } from 'react-router';

export default function NotFound() {
  return (
    <div className="min-h-screen flex items-center justify-center p-6 bg-blob bg-grid">
      <div className="text-center fade-in-up">
        <div className="font-mono text-8xl font-bold text-green-400/20 mb-4">404</div>
        <h1 className="font-display font-bold text-2xl text-white mb-2">Page Not Found</h1>
        <p className="text-gray-500 text-sm mb-8">The page you're looking for doesn't exist or has been moved.</p>
        <Link to="/dashboard" className="btn-primary">← Back to Dashboard</Link>
      </div>
    </div>
  );
}
