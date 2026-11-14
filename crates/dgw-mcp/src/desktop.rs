//! Optional authenticated loopback transport for the running desktop.
//! The standalone stdio server and its tool contract remain unchanged.
use crate::DgwMcpServer;
use rmcp::{model::*, service::RequestContext, ErrorData, RoleServer, ServerHandler, ServiceExt};
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    net::{IpAddr, Ipv4Addr, SocketAddr},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, RwLock,
    },
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::{watch, Semaphore},
};

const LIFETIME: Duration = Duration::from_secs(8 * 60 * 60);
const MAX_CONNECTIONS: usize = 4;
const READ_TOOLS: &[&str] = &[
    "open_project",
    "project_summary",
    "list_tracks",
    "list_variant_contigs",
    "list_variants",
    "search_genes",
    "list_jobs",
    "get_job",
    "preview_allele_edit",
];

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccessStatus {
    pub enabled: bool,
    pub allow_edits: bool,
    pub expires_at: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionSettings {
    pub address: String,
    pub token: String,
    pub status: AccessStatus,
}

pub struct DesktopGrant {
    active: Arc<AtomicBool>,
    stop: watch::Sender<bool>,
    deadline: Instant,
    status: AccessStatus,
}
impl DesktopGrant {
    pub fn status(&self) -> AccessStatus {
        let mut status = self.status.clone();
        status.enabled = self.active.load(Ordering::SeqCst) && Instant::now() < self.deadline;
        status
    }
    pub fn revoke(&self) {
        self.active.store(false, Ordering::SeqCst);
        let _ = self.stop.send(true);
    }
}
impl Drop for DesktopGrant {
    fn drop(&mut self) {
        self.revoke();
    }
}

#[derive(Clone)]
struct DesktopServer {
    core: DgwMcpServer,
    active: Arc<AtomicBool>,
    deadline: Instant,
    allow_edits: bool,
    context: Arc<RwLock<Value>>,
    notify: Arc<dyn Fn() + Send + Sync>,
}
impl DesktopServer {
    fn authorized(&self) -> Result<(), ErrorData> {
        if !self.active.load(Ordering::SeqCst) || Instant::now() >= self.deadline {
            return Err(ErrorData::invalid_request(
                "Agent access is off or expired",
                None,
            ));
        }
        Ok(())
    }
}
impl ServerHandler for DesktopServer {
    fn get_info(&self) -> ServerInfo {
        let mut info = self.core.get_info();
        info.instructions = Some(format!("Connected to the running DGW desktop. Call desktop_context first to inspect the shared project, active track and current selection. Only this project is accessible. Selection is context, not an access boundary: this grant covers the project. {} {}",
            if self.allow_edits { "Editing, analysis jobs and exports are permitted. Use explicit tracks and current heads; never infer that an empty selection means all variants." } else { "Read-only access: edits, exports and background computation are disabled." },
            info.instructions.unwrap_or_default()));
        info
    }
    async fn list_tools(
        &self,
        request: Option<PaginatedRequestParam>,
        context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        self.authorized()?;
        let mut list = self.core.list_tools(request, context).await?;
        if !self.allow_edits {
            list.tools
                .retain(|tool| READ_TOOLS.contains(&tool.name.as_ref()));
        }
        list.tools.push(Tool::new("desktop_context", "Read the currently shared desktop project, active track and allele selection. An empty selection stays empty. Read this again after user actions.", json!({"type":"object","properties":{},"additionalProperties":false}).as_object().unwrap().clone()));
        Ok(list)
    }
    async fn call_tool(
        &self,
        request: CallToolRequestParam,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        self.authorized()?;
        if request.name == "desktop_context" {
            return crate::structured(
                self.context
                    .read()
                    .map_err(|_| ErrorData::internal_error("Desktop context unavailable", None))?
                    .clone(),
            );
        }
        if !self.allow_edits && !READ_TOOLS.contains(&request.name.as_ref()) {
            return Err(ErrorData::invalid_request(
                "This connection is read-only; enable editing in DGW Settings",
                None,
            ));
        }
        let changes = !READ_TOOLS.contains(&request.name.as_ref());
        let result = self.core.call_tool(request, context).await;
        if changes {
            (self.notify)();
        }
        self.authorized()?; // Revocation also blocks results from an in-flight call.
        result
    }
}

pub async fn start(
    core: DgwMcpServer,
    context: Arc<RwLock<Value>>,
    allow_edits: bool,
    notify: Arc<dyn Fn() + Send + Sync>,
) -> Result<(DesktopGrant, ConnectionSettings), String> {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .await
        .map_err(|_| "Cannot open local agent connection")?;
    let address = listener
        .local_addr()
        .map_err(|_| "Cannot read local agent address")?
        .to_string();
    let token = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let active = Arc::new(AtomicBool::new(true));
    let deadline = Instant::now() + LIFETIME;
    let status = AccessStatus {
        enabled: true,
        allow_edits,
        expires_at: Some((chrono::Utc::now() + chrono::Duration::hours(8)).to_rfc3339()),
    };
    let (stop, mut stopped) = watch::channel(false);
    let server = DesktopServer {
        core,
        active: active.clone(),
        deadline,
        allow_edits,
        context,
        notify,
    };
    let secret = token.clone();
    tokio::spawn(async move {
        let slots = Arc::new(Semaphore::new(MAX_CONNECTIONS));
        loop {
            tokio::select! {
                _ = stopped.changed() => break,
                _ = tokio::time::sleep_until(deadline.into()) => break,
                incoming = listener.accept() => {
                    let Ok((socket, _)) = incoming else { break };
                    let Ok(permit) = slots.clone().try_acquire_owned() else { continue };
                    let server = server.clone();
                    let secret = secret.clone();
                    let stopped = stopped.clone();
                    tokio::spawn(async move {
                        let _permit = permit;
                        serve_connection(socket, secret, server, stopped).await;
                    });
                }
            }
        }
        server.active.store(false, Ordering::SeqCst);
        (server.notify)();
    });
    Ok((
        DesktopGrant {
            active,
            stop,
            deadline,
            status: status.clone(),
        },
        ConnectionSettings {
            address,
            token,
            status,
        },
    ))
}

async fn serve_connection(
    mut socket: TcpStream,
    secret: String,
    server: DesktopServer,
    mut stopped: watch::Receiver<bool>,
) {
    // Fixed-length preamble cannot be an HTTP request; authentication never uses URLs or logs.
    let mut bytes = [0_u8; 65];
    let authenticated =
        tokio::time::timeout(Duration::from_secs(3), socket.read_exact(&mut bytes)).await;
    if !matches!(authenticated, Ok(Ok(_)))
        || bytes[64] != b'\n'
        || !same_secret(&bytes[..64], secret.as_bytes())
        || server.authorized().is_err()
    {
        return;
    }
    if socket.write_all(b"OK\n").await.is_err() {
        return;
    }
    let deadline = server.deadline;
    let (read, write) = socket.into_split();
    let transport = (
        BoundedLines {
            read,
            line_bytes: 0,
        },
        write,
    );
    let service = tokio::select! {
        _ = stopped.changed() => return,
        _ = tokio::time::sleep_until(deadline.into()) => return,
        result = tokio::time::timeout(Duration::from_secs(10), server.serve(transport)) => match result { Ok(Ok(service)) => service, _ => return }
    };
    let cancellation = service.cancellation_token();
    tokio::select! {
        _ = stopped.changed() => cancellation.cancel(),
        _ = tokio::time::sleep_until(deadline.into()) => cancellation.cancel(),
        _ = service.waiting() => {}
    }
}
// Reject oversized newline-delimited requests before the SDK accumulates an unbounded frame.
struct BoundedLines<R> {
    read: R,
    line_bytes: usize,
}
impl<R: tokio::io::AsyncRead + Unpin> tokio::io::AsyncRead for BoundedLines<R> {
    fn poll_read(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buffer: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        let before = buffer.filled().len();
        let result = std::pin::Pin::new(&mut self.read).poll_read(cx, buffer);
        if let std::task::Poll::Ready(Ok(())) = &result {
            for byte in &buffer.filled()[before..] {
                self.line_bytes = if *byte == b'\n' {
                    0
                } else {
                    self.line_bytes + 1
                };
                if self.line_bytes > 512 * 1024 {
                    buffer.set_filled(before);
                    return std::task::Poll::Ready(Err(std::io::Error::new(
                        std::io::ErrorKind::InvalidData,
                        "MCP request too large",
                    )));
                }
            }
        }
        result
    }
}

fn same_secret(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len()
        && a.iter()
            .zip(b)
            .fold(0u8, |difference, (a, b)| difference | (a ^ b))
            == 0
}

/// Headless connector mode in the installed desktop executable. No GUI is started.
pub async fn connect_from_env() -> Result<(), String> {
    let address = std::env::var("DGW_MCP_ADDRESS")
        .map_err(|_| "Copy DGW_MCP_ADDRESS from Agent access in Settings")?;
    let token = std::env::var("DGW_MCP_TOKEN")
        .map_err(|_| "Copy DGW_MCP_TOKEN from Agent access in Settings")?;
    let address = connector_address(&address)?;
    if token.len() != 64 || !token.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("Invalid connection token; copy fresh settings from DGW".into());
    }
    let mut socket = tokio::time::timeout(Duration::from_secs(5), TcpStream::connect(address))
        .await
        .map_err(|_| "Cannot reach DGW; keep the app open")?
        .map_err(|_| "Cannot reach DGW; keep the app open")?;
    socket
        .write_all(format!("{token}\n").as_bytes())
        .await
        .map_err(|_| "Cannot connect to DGW")?;
    let mut ack = [0u8; 3];
    tokio::time::timeout(Duration::from_secs(5), socket.read_exact(&mut ack))
        .await
        .map_err(|_| "DGW did not accept the connection")?
        .map_err(|_| "Agent access expired or was revoked; copy fresh settings")?;
    if &ack != b"OK\n" {
        return Err("DGW rejected the connection".into());
    }
    let (mut read, mut write) = socket.into_split();
    // stdout carries MCP only. Environment credentials never appear in diagnostics.
    let mut stdin = tokio::io::stdin();
    let mut stdout = tokio::io::stdout();
    tokio::select! {
        result = tokio::io::copy(&mut stdin, &mut write) => result.map_err(|_| "MCP input closed")?,
        result = tokio::io::copy(&mut read, &mut stdout) => result.map_err(|_| "MCP output closed")?,
    };
    Ok(())
}
fn connector_address(value: &str) -> Result<SocketAddr, String> {
    let address: SocketAddr = value
        .parse()
        .map_err(|_| "Invalid local connection address")?;
    if address.ip() != IpAddr::V4(Ipv4Addr::LOCALHOST) || address.port() == 0 {
        return Err("DGW agent connections must use 127.0.0.1".into());
    }
    Ok(address)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn connector_is_loopback_only() {
        assert!(connector_address("127.0.0.1:2345").is_ok());
        for value in [
            "localhost:2345",
            "192.168.1.2:2345",
            "https://127.0.0.1:2345",
            "127.0.0.1:0",
            "[::1]:2345",
        ] {
            assert!(connector_address(value).is_err());
        }
        assert!(same_secret(b"abc", b"abc"));
        assert!(!same_secret(b"abc", b"abd"));
    }
}

#[cfg(test)]
mod protocol_tests {
    use super::*;
    use dgw_core::{EvaluationService, LocalComputePool};
    use std::sync::{atomic::AtomicUsize, Mutex};
    use tokio::io::{AsyncBufReadExt, BufReader};
    type Reader = BufReader<tokio::net::tcp::OwnedReadHalf>;
    type Writer = tokio::net::tcp::OwnedWriteHalf;
    async fn send(write: &mut Writer, message: Value) {
        write
            .write_all(format!("{message}\n").as_bytes())
            .await
            .unwrap();
    }
    async fn receive(read: &mut Reader) -> Value {
        let mut line = String::new();
        tokio::time::timeout(Duration::from_secs(3), read.read_line(&mut line))
            .await
            .unwrap()
            .unwrap();
        serde_json::from_str(&line).unwrap()
    }
    async fn connect(settings: &ConnectionSettings) -> (Reader, Writer) {
        let mut socket = TcpStream::connect(&settings.address).await.unwrap();
        socket
            .write_all(format!("{}\n", settings.token).as_bytes())
            .await
            .unwrap();
        let mut ack = [0; 3];
        socket.read_exact(&mut ack).await.unwrap();
        assert_eq!(&ack, b"OK\n");
        let (read, mut write) = socket.into_split();
        let mut read = BufReader::new(read);
        send(&mut write, json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1"}}})).await;
        assert!(receive(&mut read).await["result"]["capabilities"]["tools"].is_object());
        send(
            &mut write,
            json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
        )
        .await;
        (read, write)
    }
    async fn call(read: &mut Reader, write: &mut Writer, name: &str, arguments: Value) -> Value {
        send(write, json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":name,"arguments":arguments}})).await;
        receive(read).await
    }
    #[tokio::test]
    async fn authenticated_scope_read_only_live_context_and_revocation() {
        let path = std::fs::canonicalize(std::env::temp_dir()).unwrap();
        let context = Arc::new(RwLock::new(
            json!({"projectPath":path,"workspace":{"selectedCount":0}}),
        ));
        let count = Arc::new(AtomicUsize::new(0));
        let counter = count.clone();
        let notify: Arc<dyn Fn() + Send + Sync> = Arc::new(move || {
            counter.fetch_add(1, Ordering::SeqCst);
        });
        let core = DgwMcpServer::for_desktop(
            path,
            Arc::new(EvaluationService::new()),
            Arc::new(LocalComputePool::new()),
            Arc::new(Mutex::new(())),
            notify.clone(),
        );
        let (grant, settings) = start(core, context.clone(), false, notify).await.unwrap();
        let mut denied = TcpStream::connect(&settings.address).await.unwrap();
        denied
            .write_all(format!("{}\n", "0".repeat(64)).as_bytes())
            .await
            .unwrap();
        let mut ack = [0; 3];
        assert!(
            tokio::time::timeout(Duration::from_secs(3), denied.read_exact(&mut ack))
                .await
                .unwrap()
                .is_err()
        );
        let (mut read, mut write) = connect(&settings).await;
        send(
            &mut write,
            json!({"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}),
        )
        .await;
        let tools = receive(&mut read).await;
        let tools = tools["result"]["tools"].as_array().unwrap();
        assert!(tools.iter().any(|t| t["name"] == "desktop_context"));
        assert!(!tools.iter().any(|t| t["name"] == "duplicate_track"));
        let result = call(
            &mut read,
            &mut write,
            "duplicate_track",
            json!({"track_id":"source","name":"copy"}),
        )
        .await;
        assert!(result["error"]["message"]
            .as_str()
            .unwrap()
            .contains("read-only"));
        let result = call(
            &mut read,
            &mut write,
            "open_project",
            json!({"project_path":std::env::current_dir().unwrap()}),
        )
        .await;
        assert_eq!(result["result"]["isError"], true);
        assert!(result.to_string().contains("not shared"));
        let result = call(&mut read, &mut write, "desktop_context", json!({})).await;
        assert_eq!(
            result["result"]["structuredContent"]["workspace"]["selectedCount"],
            0
        );
        context.write().unwrap()["workspace"]["selectedCount"] = json!(10);
        let result = call(&mut read, &mut write, "desktop_context", json!({})).await;
        assert_eq!(
            result["result"]["structuredContent"]["workspace"]["selectedCount"],
            10
        );
        assert_eq!(count.load(Ordering::SeqCst), 0);
        grant.revoke();
        assert!(!grant.status().enabled);
        let mut line = String::new();
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(3), read.read_line(&mut line))
                .await
                .unwrap()
                .unwrap(),
            0
        );
    }
    #[tokio::test]
    async fn write_grant_lists_original_tools_and_notifies() {
        let (grant, settings) = start(
            DgwMcpServer::new(),
            Arc::new(RwLock::new(json!({}))),
            true,
            Arc::new(|| {}),
        )
        .await
        .unwrap();
        let (mut read, mut write) = connect(&settings).await;
        send(
            &mut write,
            json!({"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}),
        )
        .await;
        assert_eq!(
            receive(&mut read).await["result"]["tools"]
                .as_array()
                .unwrap()
                .len(),
            23
        );
        grant.revoke();
    }
    #[tokio::test]
    async fn oversized_unterminated_request_is_rejected() {
        let data = vec![b'a'; 512 * 1024 + 1];
        let mut reader = BoundedLines {
            read: data.as_slice(),
            line_bytes: 0,
        };
        let mut output = Vec::new();
        assert_eq!(
            reader.read_to_end(&mut output).await.unwrap_err().kind(),
            std::io::ErrorKind::InvalidData
        );
    }
}
