import { Outlet, Link } from 'react-router';

export default function PublicLayout() {
  return (
    <div className="min-h-full bg-blob bg-grid">
      <Outlet />
    </div>
  );
}
