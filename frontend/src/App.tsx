import { RouterProvider } from 'react-router';
import { router } from './routes';
import { AuthProvider } from './contexts/AuthContext';
import { DataProvider } from './contexts/DataContext';
import { ToastProvider } from './contexts/ToastContext';

function Providers({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <DataProviderWrapper>{children}</DataProviderWrapper>
    </AuthProvider>
  );
}

function DataProviderWrapper({ children }: { children: React.ReactNode }) {
  return (
    <DataProvider>
      <ToastProvider>{children}</ToastProvider>
    </DataProvider>
  );
}

export default function App() {
  return (
    <Providers>
      <RouterProvider router={router} />
    </Providers>
  );
}
