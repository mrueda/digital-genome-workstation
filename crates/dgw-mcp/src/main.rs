use dgw_mcp::DgwMcpServer;
use rmcp::{transport::stdio, ServiceExt};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    if let Some(argument) = args.next() {
        match argument.as_str() {
            "--version" | "-V" => {
                println!("dgw-mcp {}", env!("CARGO_PKG_VERSION"));
                return Ok(());
            }
            "--help" | "-h" => {
                println!(
                    "dgw-mcp {}\n\nLocal MCP server for Digital Genome Workstation projects.\n\nUSAGE:\n    dgw-mcp\n\nThe MCP protocol is carried over standard input/output.",
                    env!("CARGO_PKG_VERSION")
                );
                return Ok(());
            }
            _ => {
                return Err(format!("unknown argument: {argument}; use --help").into());
            }
        }
    }

    let service = DgwMcpServer::new().serve(stdio()).await?;
    service.waiting().await?;
    Ok(())
}
