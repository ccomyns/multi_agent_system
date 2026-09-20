"""Loose research delegation without repository or deployment credentials."""
import time
from mcp.server.fastmcp import FastMCP
from software_agents import request

mcp = FastMCP('software-research-agents')


@mcp.tool()
def spawn_agent(task: str) -> dict:
    """Delegate research to an isolated EC2 agent (max 12 active, 30 minutes each).

    Agents upload arbitrary artifacts and description.md to their own S3 folder.
    They cannot access GitHub, RDS, Vercel or sibling folders. Identical tasks are
    idempotent within this job. Include all needed context in the task.
    """
    return request('spawn', task=task)


@mcp.tool()
def wait_on_any(agent_ids: list[str], timeout_seconds: int = 60) -> dict:
    """Collect finished agents' descriptions and S3 paths; reports failures too."""
    if not 1 <= len(agent_ids) <= 12 or not 0 <= timeout_seconds <= 300:
        raise ValueError('Supply 1-12 IDs and timeout 0-300 seconds')
    deadline = time.monotonic() + timeout_seconds
    while True:
        rows = request('status')['agents']
        known = {row['agent_id'] for row in rows}
        if set(agent_ids) - known:
            raise ValueError('Agent IDs must belong to this job')
        ready = [row['agent_id'] for row in rows if row['agent_id'] in agent_ids and not row['active']]
        if ready:
            return {'agents': [row for row in request('collect', agent_ids=ready)['agents'] if row['agent_id'] in ready]}
        if time.monotonic() >= deadline:
            return {'agents': [], 'pending': agent_ids}
        time.sleep(min(5, max(0, deadline - time.monotonic())))


if __name__ == '__main__':
    mcp.run(transport='stdio')
