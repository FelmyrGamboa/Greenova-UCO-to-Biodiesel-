import { createBrowserRouter } from 'react-router';

import PublicLayout from './layouts/PublicLayout';
import AuthLayout from './layouts/AuthLayout';
import AdminLayout from './layouts/AdminLayout';

import Home from './pages/Home';
import Login from './pages/Login';
import Register from './pages/Register';
import ForgotPassword from './pages/ForgotPassword';
import About from './pages/About';

import Dashboard from './pages/Dashboard';
import NewBatch from './pages/NewBatch';
import BatchHistory from './pages/BatchHistory';
import BatchDetails from './pages/BatchDetails';
import Reports from './pages/Reports';
import Monitor from './pages/Monitor';
import Notifications from './pages/Notifications';
import Guide from './pages/Guide';
import Profile from './pages/Profile';
import Settings from './pages/Settings';

import AdminDashboard from './pages/admin/AdminDashboard';
import AdminUsers from './pages/admin/AdminUsers';
import AdminConfiguration from './pages/admin/AdminConfiguration';
import AdminLogs from './pages/admin/AdminLogs';

import NotFound from './pages/NotFound';

export const router = createBrowserRouter([
  {
    path: '/',
    element: <PublicLayout />,
    children: [
      { index: true, element: <Home /> },
      { path: 'login', element: <Login /> },
      { path: 'register', element: <Register /> },
      { path: 'forgot-password', element: <ForgotPassword /> },
      { path: 'about', element: <About /> },
    ],
  },
  {
    path: '/',
    element: <AuthLayout />,
    children: [
      { path: 'dashboard', element: <Dashboard /> },
      { path: 'batch/new', element: <NewBatch /> },
      { path: 'batch/:batchId/continue', element: <NewBatch /> },
      { path: 'batches', element: <BatchHistory /> },
      { path: 'batches/:batchId', element: <BatchDetails /> },
      { path: 'reports', element: <Reports /> },
      { path: 'monitor', element: <Monitor /> },
      { path: 'notifications', element: <Notifications /> },
      { path: 'guide', element: <Guide /> },
      { path: 'profile', element: <Profile /> },
      { path: 'settings', element: <Settings /> },
      {
        path: 'admin',
        element: <AdminLayout />,
        children: [
          { index: true, element: <AdminDashboard /> },
          { path: 'users', element: <AdminUsers /> },
          { path: 'configuration', element: <AdminConfiguration /> },
          { path: 'logs', element: <AdminLogs /> },
        ],
      },
    ],
  },
  { path: '*', element: <NotFound /> },
]);
