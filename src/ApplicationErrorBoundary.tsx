import { Component, type ErrorInfo, type ReactNode } from "react";
import { USER_SETTINGS_STORAGE_KEY } from "./userSettings";

interface ApplicationErrorBoundaryProps {
  children: ReactNode;
}

interface ApplicationErrorBoundaryState {
  error?: Error;
  componentStack?: string;
  occurredAt?: string;
  copyState?: "copied" | "failed";
}

export function formatRecoveryReport(error: Error, componentStack = "", occurredAt = new Date().toISOString()) {
  return [
    "Digital Genome Workstation interface error",
    `Occurred: ${occurredAt}`,
    `Message: ${error.message || error.name}`,
    error.stack ? `\nJavaScript stack:\n${error.stack}` : "",
    componentStack ? `\nReact component stack:${componentStack}` : ""
  ].filter(Boolean).join("\n");
}

export class ApplicationErrorBoundary extends Component<ApplicationErrorBoundaryProps, ApplicationErrorBoundaryState> {
  state: ApplicationErrorBoundaryState = {};

  static getDerivedStateFromError(error: Error): ApplicationErrorBoundaryState {
    return { error, occurredAt: new Date().toISOString() };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    this.setState({ componentStack: info.componentStack ?? undefined });
    console.error("DGW interface error", error, info);
  }

  private reload = () => {
    window.location.reload();
  };

  private resetInterface = () => {
    window.localStorage.removeItem(USER_SETTINGS_STORAGE_KEY);
    window.location.reload();
  };

  private copyDiagnostics = async () => {
    if (!this.state.error) return;
    try {
      await navigator.clipboard.writeText(formatRecoveryReport(
        this.state.error,
        this.state.componentStack,
        this.state.occurredAt
      ));
      this.setState({ copyState: "copied" });
    } catch {
      this.setState({ copyState: "failed" });
    }
  };

  render() {
    if (!this.state.error) return this.props.children;
    const report = formatRecoveryReport(
      this.state.error,
      this.state.componentStack,
      this.state.occurredAt
    );
    return <main className="application-recovery" role="alert">
      <section>
        <img src="/dgw-mark.svg" alt="" />
        <p className="eyebrow">Digital Genome Workstation</p>
        <h1>The interface stopped unexpectedly</h1>
        <p>DGW caught the error instead of leaving a blank window. Existing files in your <code>.dgw</code> project were not deleted. The last interface-only change may not have been saved.</p>
        <div className="application-recovery-actions">
          <button type="button" className="button primary" onClick={this.reload}>Reload DGW</button>
          <button type="button" className="button secondary" onClick={() => { void this.copyDiagnostics(); }}>{this.state.copyState === "copied" ? "Diagnostics copied" : "Copy diagnostics"}</button>
        </div>
        {this.state.copyState === "failed" && <p className="application-recovery-copy-error">Could not access the clipboard. Expand the details and copy the report manually.</p>}
        <details>
          <summary>Error details</summary>
          <pre>{report}</pre>
        </details>
        <footer>
          <span>If reloading returns to this screen, reset only the interface preferences. Project data and edits are not removed.</span>
          <button type="button" onClick={this.resetInterface}>Reset interface settings and reload</button>
        </footer>
      </section>
    </main>;
  }
}
