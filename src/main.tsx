import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ApplicationErrorBoundary } from "./ApplicationErrorBoundary";
import "./styles.css";
import "./light-theme.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ApplicationErrorBoundary>
      <App />
    </ApplicationErrorBoundary>
  </React.StrictMode>
);
