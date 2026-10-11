import { RouterProvider } from "react-router";
import { LiveProvider } from "./contexts/LiveContext";
import { ThemeProvider } from "./contexts/ThemeContext";
import { router } from "./routes";

export default function App() {
  return (
    <ThemeProvider>
      <LiveProvider>
        <RouterProvider router={router} />
      </LiveProvider>
    </ThemeProvider>
  );
}
