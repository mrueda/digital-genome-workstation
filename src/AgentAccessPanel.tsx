import { useEffect, useRef, useState } from "react";
import { Copy, Eye, EyeOff, PlugZap } from "lucide-react";
import { api, type AgentConnection, type AgentStatus } from "./api";

export function AgentAccessPanel({ projectPath }: { projectPath?: string }) {
  const operation = useRef(0);
  const pending = useRef(false);
  const [status, setStatus] = useState<AgentStatus>({ enabled: false, allowEdits: false });
  const [connection, setConnection] = useState<AgentConnection>();
  const [allowEdits, setAllowEdits] = useState(false);
  const [consent, setConsent] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      if (pending.current) return;
      const revision = operation.current;
      return api.agentStatus().then(next => {
      if (cancelled || revision !== operation.current) return;
      setStatus(next);
      if (!next.enabled) { setConnection(undefined); setRevealed(false); }
    }).catch(() => { if (!cancelled) setMessage("Agent access is available in the desktop app."); });
    };
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 1500);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [projectPath]);
  async function enable() {
    ++operation.current;
    pending.current = true;
    setBusy(true); setMessage("");
    try {
      const next = await api.enableAgentAccess(allowEdits);
      setConnection(next); setStatus(next.status); setConsent(false);
      setMessage("Access is on. Copy these settings into your MCP client.");
    } catch (error) { setMessage(String(error)); }
    finally { ++operation.current; pending.current = false; setBusy(false); }
  }
  async function disable() {
    ++operation.current;
    pending.current = true;
    setBusy(true);
    try { await api.disableAgentAccess(); setStatus({ enabled: false, allowEdits: false }); setConnection(undefined); setRevealed(false); setMessage("Agent access is off."); }
    catch (error) { setMessage(String(error)); }
    finally { ++operation.current; pending.current = false; setBusy(false); }
  }
  async function copy(value: string) {
    try { await navigator.clipboard.writeText(value); setMessage("Copied to clipboard."); }
    catch { setMessage("Clipboard unavailable. Select and copy the value manually."); }
  }
  const config = connection ? `[mcp_servers.dgw]\ncommand = ${JSON.stringify(connection.command)}\nargs = ["--mcp-connect"]\n\n[mcp_servers.dgw.env]\nDGW_MCP_ADDRESS = ${JSON.stringify(connection.address)}\nDGW_MCP_TOKEN = ${JSON.stringify(connection.token)}\n` : "";
  return <div className="agent-access">
    <div className="agent-access-heading"><PlugZap aria-hidden="true" /><div><h3>Agent access (MCP)</h3><p>Connect Codex Desktop to this open project.</p></div><span className={`agent-access-badge ${status.enabled ? "enabled" : ""}`}>{status.enabled ? "On" : "Off"}</span></div>
    {!projectPath && <p>Open a project to enable access.</p>}
    <p>The connection shares this project, including its variants, tracks and current selection. Your agent may send returned data to its model provider.</p>
    {status.enabled ? <>
      <p><strong>{status.allowEdits ? "Editing, analysis and exports allowed" : "Read-only access"}</strong>{status.expiresAt && <> · Expires {new Date(status.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</>}</p>
      <button type="button" className="button" disabled={busy} onClick={() => void disable()}>Turn off</button>
      {!connection && <p>Credentials are shown only when you enable access. To obtain fresh settings, turn it off and enable it again.</p>}
    </> : <>
      <label className="settings-check"><input type="checkbox" checked={allowEdits} disabled={busy} onChange={e => setAllowEdits(e.target.checked)} /><span><b>Allow edits, analysis and exports</b><small>Otherwise the agent can only inspect the project. The source track stays protected.</small></span></label>
      <label className="settings-check"><input type="checkbox" checked={consent} disabled={busy} onChange={e => setConsent(e.target.checked)} /><span>I agree to share this project's data with my connected agent.</span></label>
      <button type="button" className="button primary" disabled={!projectPath || !consent || busy} onClick={() => void enable()}>{busy ? "Connecting…" : "Enable access"}</button>
    </>}
    {connection && <div className="agent-connection">
      <p>Choose <strong>STDIO</strong> in the client's MCP settings. Use these values; the working directory can stay empty.</p>
      {([
        ["Command", connection.command], ["Arguments", "--mcp-connect"], ["DGW_MCP_ADDRESS", connection.address], ["DGW_MCP_TOKEN", connection.token]
      ] as const).map(([label, value]) => <label className="agent-connection-field" key={label}><span>{label}</span><div><input aria-label={label} readOnly type={label === "DGW_MCP_TOKEN" && !revealed ? "password" : "text"} value={value} />{label === "DGW_MCP_TOKEN" && <button type="button" aria-label={revealed ? "Hide token" : "Reveal token"} onClick={() => setRevealed(!revealed)}>{revealed ? <EyeOff size={16} /> : <Eye size={16} />}</button>}<button type="button" aria-label={`Copy ${label}`} onClick={() => void copy(value)}><Copy size={16} /></button></div></label>)}
      <button type="button" className="button ghost" onClick={() => void copy(config)}><Copy size={15} /> Copy Codex configuration</button>
    </div>}
    <p className="agent-access-note">Keep DGW open. Turning access off, switching projects or restarting DGW revokes the credentials. Already accepted jobs may finish. Screen access is separate from MCP access.</p>
    {message && <p role="status">{message}</p>}
  </div>;
}
