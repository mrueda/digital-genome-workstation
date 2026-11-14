use std::process::Command;

#[test]
fn desktop_executable_has_a_headless_connector_mode() {
    let result = Command::new(env!("CARGO_BIN_EXE_dgw-desktop"))
        .arg("--mcp-connect")
        .env_remove("DGW_MCP_ADDRESS")
        .env_remove("DGW_MCP_TOKEN")
        .env_remove("DISPLAY")
        .env_remove("WAYLAND_DISPLAY")
        .output()
        .expect("launch desktop connector without GUI");
    assert_eq!(result.status.code(), Some(2));
    assert!(result.stdout.is_empty(), "stdout must remain protocol-only");
    assert!(String::from_utf8_lossy(&result.stderr).contains("DGW_MCP_ADDRESS"));
}
