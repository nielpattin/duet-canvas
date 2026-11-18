import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR } from '../config.ts'
import { AGENTS, type AgentId, type AgentPrefs, type PrefsStore } from './driver.ts'

const FILE = join(DATA_DIR, 'chat-prefs.json')

// Which agent is selected, and the last model and effort the user picked in each: a new chat starts on the agent's own
// default, so we put the choice back.
type Prefs = { agent?: AgentId } & Partial<Record<AgentId, AgentPrefs>>

function load(): Prefs {
	try {
		const raw = JSON.parse(readFileSync(FILE, 'utf8'))
		// Before several agents existed the file held omp's choice at the top level.
		if (raw.model || raw.thinking) {
			raw.omp = { model: raw.model, thinking: raw.thinking, ...raw.omp }
			delete raw.model
			delete raw.thinking
		}
		return raw
	} catch {
		return {}
	}
}
const save = (p: Prefs) => writeFileSync(FILE, JSON.stringify(p))

export function selectedAgent(): AgentId {
	const a = load().agent
	return a && AGENTS.includes(a) ? a : 'omp'
}
export const selectAgent = (agent: AgentId) => save({ ...load(), agent })

export const agentPrefs = (id: AgentId): PrefsStore => ({
	get: () => load()[id] ?? {},
	set: (patch) => {
		const all = load()
		save({ ...all, [id]: { ...all[id], ...patch } })
	},
})
