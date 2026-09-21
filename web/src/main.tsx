import "@fontsource-variable/geist/wght.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { initAnalytics } from "./analytics";
import { App } from "./App";
import { BridgeProvider } from "./bridge";
import { logClientEvent } from "./clientLog";
import { installConsoleCapture } from "./consoleCapture";
import { startNativeControls } from "./native";
import "./styles.css";

startNativeControls();
// Flight recorder signal 7: beam window.onerror + unhandledrejection to
// the client-log pipeline (sampled, size-capped, scrubbed). Best-effort —
// never breaks the page it observes.
installConsoleCapture((kind, detail) => {
  if (kind === "console-error") {
    logClientEvent("console-error", detail);
  }
});
initAnalytics();

const root = document.getElementById("root");

if (!root) {
  throw new Error("missing root element");
}

createRoot(root).render(
  <StrictMode>
    <BridgeProvider>
      <App />
    </BridgeProvider>
  </StrictMode>,
);
