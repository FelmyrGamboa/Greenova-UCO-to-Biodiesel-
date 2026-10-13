import { Outlet, Navigate } from 'react-router';
import { useAuth } from '../contexts/AuthContext';

export default function AdminLayout() {
  const { user } = useAuth();
  if (!user) return <Navigate to="/login" replace />;
  if (user.role !== 'Administrator') return <Navigate to="/dashboard" replace />;
  return <Outlet />;
}
