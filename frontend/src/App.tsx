import { RouterProvider } from "react-router";
import { LiveProvider } from "./contexts/LiveContext";
import { ThemeProvider } from "./contexts/ThemeContext";
import { LanguageProvider } from "./lib/i18n";
import { router } from "./routes";

export default function App() {
  return (
    <ThemeProvider>
      <LanguageProvider>
        <LiveProvider>
          <RouterProvider router={router} />
        </LiveProvider>
      </LanguageProvider>
    </ThemeProvider>
  );
}
