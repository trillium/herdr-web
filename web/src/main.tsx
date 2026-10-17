import "@fontsource-variable/geist/wght.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { initAnalytics } from "./analytics";
import { isLinksPath } from "./links";
import { isSendOnlyPath } from "./sendOnly";
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

const sendOnly = isSendOnlyPath(window.location.pathname);

if (isLinksPath(window.location.pathname)) {
  const { LinksPage } = await import("./LinksPage");
  createRoot(root).render(
    <StrictMode>
      <LinksPage />
    </StrictMode>,
  );
} else if (sendOnly) {
  const { SendOnlyPage } = await import("./SendOnlyPage");
  createRoot(root).render(
    <StrictMode>
      <SendOnlyPage />
    </StrictMode>,
  );
} else {
  const [{ App }, { BridgeProvider }] = await Promise.all([import("./App"), import("./bridge")]);
  createRoot(root).render(
    <StrictMode>
      <BridgeProvider>
        <App />
      </BridgeProvider>
    </StrictMode>,
  );
}
