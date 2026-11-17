import { room } from './room.ts'
import { syncIds } from './shapes.ts'

// Rendering needs a browser: tldraw draws shapes to an image only inside a page that runs the editor.
// So the server hands render jobs to a connected tab over the sync socket (custom message) and the first tab to answer
// wins, replying with an HTTP POST to /api/bridge/:id (image bytes, or JSON for an error).

export interface BridgeReply {
	contentType: string
	body: Buffer
}

interface Pending {
	resolve: (reply: BridgeReply) => void
	timer: ReturnType<typeof setTimeout>
}
const pending = new Map<string, Pending>()

export function askBrowser(message: Record<string, unknown>, timeoutMs = 20_000): Promise<BridgeReply> {
	const tabs = room.getSessions().filter((s) => s.isConnected)
	if (tabs.length === 0) {
		return Promise.reject(new Error('No browser tab is open on the canvas app, and tldraw can only render inside one. Open the app and retry.'))
	}
	const requestId = crypto.randomUUID()
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			pending.delete(requestId)
			reject(new Error(`The browser did not answer within ${timeoutMs / 1000}s (the tab may be in the background).`))
		}, timeoutMs)
		pending.set(requestId, { resolve, timer })
		// expectIds: the tab waits until it has all of these, so it never renders a half-synced canvas.
		const expectIds = syncIds()
		for (const t of tabs) room.sendCustomMessage(t.sessionId, { ...message, requestId, expectIds })
	})
}

export function answerFromBrowser(requestId: string, reply: BridgeReply): boolean {
	const p = pending.get(requestId)
	if (!p) return false
	clearTimeout(p.timer)
	pending.delete(requestId)
	p.resolve(reply)
	return true
}

// JSON replies carry { error } on failure.
export function parseJsonReply(reply: BridgeReply): Record<string, unknown> {
	const data = JSON.parse(reply.body.toString('utf8')) as Record<string, unknown>
	if (typeof data.error === 'string') throw new Error(data.error)
	return data
}
