import { Outlet, Link } from 'react-router';

export default function PublicLayout() {
  return (
    // The landing page keeps its dark design in both themes.
    <div data-theme="dark" className="min-h-full bg-blob bg-grid text-white">
      <Outlet />
    </div>
  );
}
