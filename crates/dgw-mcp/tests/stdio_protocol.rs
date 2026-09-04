use serde_json::{json, Value};
use std::{
    io::{BufRead, BufReader, Write},
    process::{Command, Stdio},
};

#[test]
fn initializes_and_lists_tools_over_stdio() {
    let mut child = Command::new(env!("CARGO_BIN_EXE_dgw-mcp"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("start dgw-mcp");
    let mut stdin = child.stdin.take().expect("server stdin");
    let mut stdout = BufReader::new(child.stdout.take().expect("server stdout"));

    send(
        &mut stdin,
        json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-03-26",
                "capabilities": {},
                "clientInfo": { "name": "dgw-mcp-test", "version": "0.1.0" }
            }
        }),
    );
    let initialized = receive(&mut stdout);
    assert_eq!(initialized["id"], 1);
    assert_eq!(initialized["result"]["serverInfo"]["name"], "dgw-mcp");
    assert!(initialized["result"]["capabilities"]["tools"].is_object());

    send(
        &mut stdin,
        json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }),
    );
    send(
        &mut stdin,
        json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {} }),
    );
    let listed = receive(&mut stdout);
    let tools = listed["result"]["tools"].as_array().expect("tool array");
    assert_eq!(tools.len(), 16);
    assert!(tools.iter().any(|tool| tool["name"] == "open_project"));
    assert!(tools.iter().any(|tool| tool["name"] == "list_variants"));
    assert!(tools.iter().any(|tool| tool["name"] == "apply_allele_edit"));
    assert!(tools
        .iter()
        .any(|tool| tool["name"] == "start_mutation_generator_preview"));
    assert!(tools
        .iter()
        .any(|tool| tool["name"] == "start_track_profiler"));
    assert!(tools.iter().all(|tool| tool["inputSchema"].is_object()));

    drop(stdin);
    child.wait().expect("wait for dgw-mcp");
}

fn send(stdin: &mut impl Write, message: Value) {
    writeln!(stdin, "{message}").expect("write MCP message");
    stdin.flush().expect("flush MCP message");
}

fn receive(stdout: &mut impl BufRead) -> Value {
    let mut line = String::new();
    stdout.read_line(&mut line).expect("read MCP response");
    serde_json::from_str(&line).expect("valid MCP JSON response")
}
