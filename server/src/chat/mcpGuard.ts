import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// omp loads the user's own MCP servers (~/.omp/agent/mcp.json) next to ours, so the chat agent would also get
// their tools. `--tools` cannot filter MCP tools, but a project-level entry with `enabled: false` suppresses a
// same-named user-level server (verified against get_state.dumpTools), so we stub every name the user has.
// Third-party configs (Claude, Cursor...) are off by default in omp unless the user opted in; the hub reports any
// tool that still gets through.
function ompAgentDir() {
	const root = process.env.PI_CONFIG_DIR ?? join(homedir(), '.omp')
	const profile = process.env.OMP_PROFILE ?? process.env.PI_PROFILE
	return profile ? join(root, 'profiles', profile, 'agent') : (process.env.PI_CODING_AGENT_DIR ?? join(root, 'agent'))
}
// pi (earendil-works/pi) reads the same kind of file from its own agent dir.
export const piAgentDir = () => process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent')

export function userMcpServerNames(dir = ompAgentDir()): string[] {
	const names = new Set<string>()
	for (const file of ['mcp.json', '.mcp.json']) {
		try {
			const servers = JSON.parse(readFileSync(join(dir, file), 'utf8')).mcpServers
			if (servers && typeof servers === 'object') for (const name of Object.keys(servers)) names.add(name)
		} catch {
			// no such file, or not JSON: nothing to suppress
		}
	}
	return [...names]
}
