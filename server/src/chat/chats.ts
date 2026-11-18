import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { DATA_DIR } from '../config.ts'
import type { AgentId } from './driver.ts'

// omp has no "list sessions" command, so the app keeps its own small index of the chats it created.
// The transcripts themselves stay in omp's session files, or in our own transcript files for the other agents.
// Chats written before there were several agents have no `agent` and belong to omp.
export type Chat = { id: string; file: string; title: string; updatedAt: number; agent?: AgentId }

export const SESSIONS = join(DATA_DIR, 'sessions')
const FILE = join(DATA_DIR, 'chats.json')
const STALE_MS = 60_000

let cache: Chat[] | undefined
function chats(): Chat[] {
	if (!cache) {
		try {
			cache = JSON.parse(readFileSync(FILE, 'utf8')).chats ?? []
		} catch {
			cache = []
		}
	}
	return cache!
}
const save = () => writeFileSync(FILE, JSON.stringify({ chats: chats() }))

export function touchChat(agent: AgentId, id: string, file: string, title?: string) {
	const found = chats().find((c) => c.id === id)
	if (found) {
		found.file = file
		found.updatedAt = Date.now()
		if (!found.title && title) found.title = title
	} else {
		chats().push({ id, file, title: title ?? '', updatedAt: Date.now(), agent })
	}
	save()
}

export const findChat = (id: string) => chats().find((c) => c.id === id)

// Newest first, for one agent. Entries whose session file is gone (deleted by hand) are dropped, unless they are brand
// new: omp writes a session file lazily.
export function listChats(agent: AgentId): Chat[] {
	const now = Date.now()
	const alive = chats().filter((c) => existsSync(c.file) || now - c.updatedAt < STALE_MS)
	if (alive.length !== chats().length) {
		cache = alive
		save()
	}
	return alive.filter((c) => (c.agent ?? 'omp') === agent).sort((a, b) => b.updatedAt - a.updatedAt)
}

// Removes the transcript and its artifacts folder, but only inside our own sessions dir.
export function deleteChat(id: string) {
	const chat = findChat(id)
	if (!chat) return
	const file = resolve(chat.file)
	if (file.startsWith(resolve(SESSIONS) + sep)) {
		rmSync(file, { force: true })
		rmSync(file.replace(/\.jsonl$/, ''), { recursive: true, force: true })
	}
	cache = chats().filter((c) => c.id !== id)
	save()
}
