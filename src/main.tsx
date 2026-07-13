import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "@presentation/App";
import { installDeveloperModeHiddenToggle } from "@presentation/lib/developerMode";
import "./index.css";

installDeveloperModeHiddenToggle();

const container = document.getElementById("root");
if (!container) {
  throw new Error("Root element #root not found");
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
