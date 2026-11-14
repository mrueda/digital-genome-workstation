# Connect an agent to DGW

From **v0.1.1**, you can connect an agent to the project open in DGW using MCP (Model Context Protocol). It can read tracks, edit variants and run analyses through the same code used by the app. You see the changes in DGW.

## Connect

1. Open a project. For a first test, use **File → Open Example Project → Allele Editing — GRCh37**. Its genome resources must be installed.
2. Open **Settings → Agent access**. Leave **Allow edits, analysis and exports** unchecked for the first connection.
3. Confirm sharing and click **Enable access**.
4. Add DGW to your MCP client using the values below. For Codex, you can use **Copy Codex configuration**.

| Client setting | Copy from DGW |
| --- | --- |
| Transport | **STDIO** |
| Command | The executable path shown in Settings |
| Arguments | `--mcp-connect` |
| Environment variables | `DGW_MCP_ADDRESS` and `DGW_MCP_TOKEN` |
| Working directory | Leave empty |

The connector comes with DGW. Keep the app open while using it. On macOS, move DGW to **Applications** before copying the connection settings.

:::note[Client support]
We tested this with Codex on macOS: reading the selection, editing a track and disconnecting. Other clients need support for local **STDIO** servers. The address shown by DGW is not a web URL.
:::

## Try it

Ask your connected agent:

> Use DGW to describe the open project, list its tracks and report the current allele selection. Do not modify anything.

Select a variant in DGW and ask again. The agent should report the new selection. **No selection means no selected alleles**, not the whole genome.

To try an edit, turn access off and enable it again with **Allow edits, analysis and exports** checked. Update the client's credentials, then ask:

> Read the currently selected SNV on the Working track, then duplicate the track as “MCP test”. Change that SNV's ALT to another non-reference base on the duplicate. Leave the original track unchanged and report the exact change.

The duplicate and edit should appear in DGW. To evaluate the changes, ask the agent to **profile the edited track and report the score and coverage**. Applying an edit does not itself calculate its score. Follow progress in **Jobs** and view the completed profile in **Track Monitor**.

## Permissions

| Setting | What it permits |
| --- | --- |
| Read-only | Inspect the project, tracks, variants and jobs; validate a possible manual edit without applying it. |
| Allow edits, analysis and exports | Also create or modify working tracks, run analysis and write exports. The source track stays protected. |
| Turn off | Close the MCP connection and revoke its credentials. Already accepted jobs may finish. |

:::note[What you share]
Access covers the **open project**, not just its selection. Your agent may send project data to its model provider. Start with the synthetic example. Keep the connection token out of prompts and screenshots.
:::

Credentials expire after **eight hours** and are revoked when you switch projects or restart DGW. To reconnect, enable access again and replace the client's connection settings. If you closed Settings and no longer have the token, turn access off and on to obtain fresh credentials.

An agent with screen-control permission can still use the interface after you turn MCP off.

## Scripts and reproducible experiments

You can still use **dgw-mcp** with saved projects without opening the app. Both modes call the same DGW core. The calculations and seeded workflows used in the paper are unchanged. See the [MCP tool reference and standalone setup](../technical-details/mcp-server.md).
