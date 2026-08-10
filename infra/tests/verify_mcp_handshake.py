"""Smoke-test the spawn-agent server through the real MCP stdio protocol."""

from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client


async def verify() -> None:
    repo_root = Path(__file__).resolve().parents[1]
    server_path = repo_root / "runtime/orchestrator/bin/spawn_agent_mcp.py"
    server = StdioServerParameters(
        command=sys.executable,
        args=[str(server_path)],
        env=os.environ.copy(),
    )

    async with stdio_client(server) as (read_stream, write_stream):
        async with ClientSession(read_stream, write_stream) as session:
            await session.initialize()
            response = await session.list_tools()

    tools = {tool.name: tool for tool in response.tools}
    assert set(tools) == {"spawn_agent", "collect_agent_results"}, tools
    assert set(tools["spawn_agent"].inputSchema["properties"]) == {"task"}
    assert tools["spawn_agent"].inputSchema["required"] == ["task"]
    assert set(tools["collect_agent_results"].inputSchema["properties"]) == {
        "agent_ids",
        "timeout_seconds",
        "poll_interval_seconds",
    }
    assert tools["collect_agent_results"].inputSchema["required"] == ["agent_ids"]


if __name__ == "__main__":
    asyncio.run(verify())
    print("MCP handshake verified: spawn and collection tools are discoverable")
