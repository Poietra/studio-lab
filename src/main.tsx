import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import {
  AccountSessionBootstrap,
  accountSessionMountKeyV1,
  productionBrowserAccountBootstrapRequired,
} from "./accounts/account-session-bootstrap";
import { App } from "./app";
import "katex/dist/katex.min.css";
import "./styles.css";

const accountBootstrapEnabled = productionBrowserAccountBootstrapRequired({
  electron: Boolean(window.poietraDesktop),
  production: import.meta.env.PROD,
  tauri: "__TAURI_INTERNALS__" in window,
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AccountSessionBootstrap enabled={accountBootstrapEnabled}>
      {(session) => <App accountSession={session} key={session ? accountSessionMountKeyV1(session) : "local"} />}
    </AccountSessionBootstrap>
  </StrictMode>,
);
