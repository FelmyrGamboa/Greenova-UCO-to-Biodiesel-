import { createBrowserRouter, Navigate } from "react-router";
import PublicLayout from "./layouts/PublicLayout";
import AuthLayout from "./layouts/AuthLayout";
import Home from "./pages/Home";
import Dashboard from "./pages/Dashboard";
import NewBatch from "./pages/NewBatch";
import BatchHistory from "./pages/BatchHistory";
import BatchDetails from "./pages/BatchDetails";
import Settings from "./pages/Settings";

export const router = createBrowserRouter([
  {
    path: "/",
    element: <PublicLayout />,
    children: [{ index: true, element: <Home /> }],
  },
  {
    path: "/",
    element: <AuthLayout />,
    children: [
      { path: "dashboard", element: <Dashboard /> },
      { path: "process", element: <NewBatch /> },
      { path: "batches", element: <BatchHistory /> },
      { path: "batches/:batchId", element: <BatchDetails /> },
      { path: "settings", element: <Settings /> },
    ],
  },
  { path: "*", element: <Navigate to="/" replace /> },
]);
