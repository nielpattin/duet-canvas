import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR } from '../config.ts'

// Whoever can talk to /chat can drive an agent on this machine, and 127.0.0.1 is reachable by every user of a shared
// computer. So the chat needs a secret that only the launching user holds: a random token kept in the data dir
// (owner-only where the OS supports it) and handed to the browser once, in the link the CLI prints/opens.
// It is persisted so bookmarked tabs and restarts keep working.
const FILE = join(DATA_DIR, 'chat-token')
let token: string | undefined

export function chatToken(): string {
	if (token) return token
	try {
		token = readFileSync(FILE, 'utf8').trim()
	} catch {
		// first run
	}
	if (!token || token.length < 32) {
		token = randomBytes(32).toString('hex')
		writeFileSync(FILE, token, { mode: 0o600 })
		try {
			chmodSync(FILE, 0o600)
		} catch {
			// not supported on this filesystem
		}
	}
	return token
}

export function tokenOk(candidate: string | null | undefined): boolean {
	if (!candidate) return false
	const a = Buffer.from(candidate)
	const b = Buffer.from(chatToken())
	return a.length === b.length && timingSafeEqual(a, b)
}
