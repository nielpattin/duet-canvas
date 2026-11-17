import { createHash } from 'node:crypto'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { UPLOADS } from '../config.ts'

// Wire format between server and browser (mirrored in web/src/chat/store.ts: keep in sync).
export type WireBlock =
	| { type: 'text'; text: string }
	| { type: 'thinking'; text: string }
	| { type: 'tool'; id: string; name: string; args: string }
	| { type: 'image'; src?: string }
export type WireMessage = {
	role: 'user' | 'assistant' | 'tool' | 'summary'
	blocks: WireBlock[]
	toolCallId?: string
	isError?: boolean
	error?: string
}

const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }

// Images the user attached are kept in uploads/ under a content hash, so the browser can show them again after a reload.
export function saveChatImage(mimeType: string, data: string): { url: string; file: string } | undefined {
	const ext = EXT[mimeType]
	if (!ext) return undefined
	const name = `chat-${createHash('sha1').update(data).digest('hex')}.${ext}`
	const file = join(UPLOADS, name)
	if (!existsSync(file)) writeFileSync(file, Buffer.from(data, 'base64'))
	return { url: `/uploads/${name}`, file }
}

// The model sees an attached image but cannot hand its bytes to a tool, so it is told where the file lives and can pass
// that path to add_media. The note is appended to the prompt and cut again when the transcript is shown to the user.
const NOTE_START = '\n\n[canvas-chat attachments]'
export function attachmentNote(files: string[]): string {
	if (!files.length) return ''
	const lines = files.map((f, i) => `${i + 1}. ${f}`).join('\n')
	return `${NOTE_START}\nThe image(s) attached to this message are saved as local files. To put one on the canvas, call add_media with \`path\` set to its absolute path:\n${lines}`
}
const stripNote = (text: string) => {
	const i = text.indexOf(NOTE_START)
	return i < 0 ? text : text.slice(0, i)
}

export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))
export const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s)

// Browsers get a light copy: no image bytes (user images are served from uploads/), no usage/request bookkeeping,
// tool arguments clipped.
export function toWire(m: any): WireMessage | undefined {
	const role = m?.role
	if (role === 'compactionSummary' || role === 'branchSummary') {
		return { role: 'summary', blocks: [{ type: 'text', text: clip(String(m.summary ?? ''), 4000) }] }
	}
	if (role !== 'user' && role !== 'assistant' && role !== 'toolResult') return undefined
	if (m.attribution === 'agent') return undefined // internal hand-offs, not something the user wrote
	const content: any[] = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : Array.isArray(m.content) ? m.content : []
	const blocks = content.flatMap((b): WireBlock[] => {
		switch (b?.type) {
			case 'text':
				return [{ type: 'text', text: clip(role === 'user' ? stripNote(String(b.text ?? '')) : String(b.text ?? ''), 20_000) }]
			case 'thinking':
				return [{ type: 'thinking', text: String(b.thinking ?? '') }]
			case 'toolCall':
				return [{ type: 'tool', id: String(b.id), name: String(b.name), args: clip(JSON.stringify(b.arguments ?? {}), 400) }]
			case 'image':
				return [{ type: 'image', src: role === 'user' && b.data ? saveChatImage(String(b.mimeType), String(b.data))?.url : undefined }]
			default:
				return []
		}
	})
	return {
		role: role === 'toolResult' ? 'tool' : role,
		blocks,
		toolCallId: m.toolCallId,
		isError: m.isError,
		error: m.stopReason === 'error' ? String(m.errorMessage ?? 'The request failed') : undefined,
	}
}
