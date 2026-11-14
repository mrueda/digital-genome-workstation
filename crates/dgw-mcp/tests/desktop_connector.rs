use dgw_mcp::{desktop, DgwMcpServer};
use serde_json::json;
use std::{
    process::Stdio,
    sync::{Arc, RwLock},
    time::Duration,
};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

#[tokio::test]
async fn real_stdio_connector_disconnects_when_desktop_revokes_access() {
    let (grant, settings) = desktop::start(
        DgwMcpServer::new(),
        Arc::new(RwLock::new(json!({"selectedCount":0}))),
        false,
        Arc::new(|| {}),
    )
    .await
    .unwrap();
    let mut child = tokio::process::Command::new(env!("CARGO_BIN_EXE_dgw-mcp"))
        .arg("--mcp-connect")
        .env("DGW_MCP_ADDRESS", settings.address)
        .env("DGW_MCP_TOKEN", settings.token)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    let mut output = BufReader::new(child.stdout.take().unwrap());
    input.write_all(format!("{}\n", json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1"}}})).as_bytes()).await.unwrap();
    let mut line = String::new();
    tokio::time::timeout(Duration::from_secs(5), output.read_line(&mut line))
        .await
        .unwrap()
        .unwrap();
    assert!(
        serde_json::from_str::<serde_json::Value>(&line).unwrap()["result"]["capabilities"]
            ["tools"]
            .is_object()
    );
    input
        .write_all(b"{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}\n")
        .await
        .unwrap();
    input.write_all(b"{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"desktop_context\",\"arguments\":{}}}\n").await.unwrap();
    line.clear();
    tokio::time::timeout(Duration::from_secs(5), output.read_line(&mut line))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&line).unwrap()["result"]["structuredContent"]
            ["selectedCount"],
        0
    );
    grant.revoke();
    // Intentionally keep the input pipe open: revocation must still terminate the connector.
    assert!(tokio::time::timeout(Duration::from_secs(5), child.wait())
        .await
        .unwrap()
        .unwrap()
        .success());
    drop(input);
}
