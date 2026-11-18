import { claudeDriver, detectClaude } from './claude.ts'
import { codexDriver, detectCodex } from './codex.ts'
import { AGENTS, type AgentId, type Detected, type DriverFactory } from './driver.ts'
import { detectOmp, ompDriver } from './omp.ts'
import { detectOpencode, opencodeDriver } from './opencode.ts'
import { detectPi, piDriver } from './pi.ts'

const DEFS: Record<AgentId, { label: string; detect: () => Promise<Detected>; create: DriverFactory }> = {
	omp: { label: 'omp', detect: detectOmp, create: ompDriver },
	claude: { label: 'Claude Code', detect: detectClaude, create: claudeDriver },
	codex: { label: 'Codex', detect: detectCodex, create: codexDriver },
	opencode: { label: 'opencode', detect: detectOpencode, create: opencodeDriver },
	pi: { label: 'pi', detect: detectPi, create: piDriver },
}

export const createDriver = (id: AgentId, ...args: Parameters<DriverFactory>) => DEFS[id].create(...args)

// Starting a CLI just to read its version costs a second or more, and the browser asks on every reconnect.
// Only successes are remembered, so installing a missing CLI shows up on the next check.
const TTL_MS = 30_000
const found = new Map<AgentId, { at: number; result: Detected }>()
export async function detectAgent(id: AgentId): Promise<Detected> {
	const hit = found.get(id)
	if (hit && Date.now() - hit.at < TTL_MS) return hit.result
	const result = await DEFS[id].detect()
	if (result.ok) found.set(id, { at: Date.now(), result })
	return result
}

export type AgentInfo = { id: AgentId; label: string } & ({ ok: true; version: string } | { ok: false; message: string })

export const detectAgents = (): Promise<AgentInfo[]> =>
	Promise.all(AGENTS.map(async (id) => ({ id, label: DEFS[id].label, ...(await detectAgent(id)) })))
