import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { UserSetup } from "./UserSetup";
import { ApplicationErrorBoundary } from "./ApplicationErrorBoundary";
import "./styles.css";
import "./light-theme.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ApplicationErrorBoundary>
      {new URLSearchParams(window.location.search).has("setup") ? <UserSetup /> : <App />}
    </ApplicationErrorBoundary>
  </React.StrictMode>
);
