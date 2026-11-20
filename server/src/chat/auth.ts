import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, readFileSync, watchFile, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR } from '../config.ts'

// Whoever can talk to /chat can drive an agent on this machine, and 127.0.0.1 is reachable by every user of a shared
// computer. So the chat needs a secret that only the launching user holds: a random token kept in the data dir
// (owner-only where the OS supports it) and handed to the browser once, in the link the CLI prints.
// It is persisted so bookmarked tabs and restarts keep working.
// The file is the only copy and is read on every check, never cached: `cduet rotate` runs in another process, and
// a leaked token must stop working on a running server without a restart.
const FILE = join(DATA_DIR, 'chat-token')

export function chatToken(): string {
	try {
		const token = readFileSync(FILE, 'utf8').trim()
		if (token.length >= 32) return token
	} catch {
		// first run
	}
	return rotateToken()
}

// A new secret; the old one stops working at once.
export function rotateToken(): string {
	const token = randomBytes(32).toString('hex')
	writeFileSync(FILE, token, { mode: 0o600 })
	try {
		chmodSync(FILE, 0o600)
	} catch {
		// not supported on this filesystem
	}
	return token
}

// Calls back when the file changes, so sockets opened with the old token can be cut.
export const onTokenChange = (listener: () => void) => watchFile(FILE, { interval: 500, persistent: false }, listener)

export function tokenOk(candidate: string | null | undefined): boolean {
	if (!candidate) return false
	const a = Buffer.from(candidate)
	const b = Buffer.from(chatToken())
	return a.length === b.length && timingSafeEqual(a, b)
}
