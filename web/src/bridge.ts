import { Box, type Editor, type TLPageId, type TLRecord, type TLShapeId } from 'tldraw'

// The server asks this tab to render shapes to an image: tldraw can only do that inside a browser.
// Rendering reads the document only. It never changes the selection, the camera or the page shown in this tab.
// See server/src/bridge.ts.
let editor: Editor | null = null
export function setBridgeEditor(e: Editor | null) {
	editor = e
}

interface CaptureRequest {
	type: 'capture'
	requestId: string
	expectIds?: string[]
	pageId: string
	shapeIds?: string[]
	bounds?: { x: number; y: number; w: number; h: number }
	scale?: number
}

const MAX_SIDE = 1568

const reply = (requestId: string, contentType: string, body: BodyInit) =>
	fetch(`/api/bridge/${requestId}`, { method: 'POST', headers: { 'Content-Type': contentType }, body })
const replyJson = (requestId: string, data: unknown) => reply(requestId, 'application/json', JSON.stringify(data))

async function capture(e: Editor, req: CaptureRequest) {
	if (!e.getPage(req.pageId as TLPageId)) return replyJson(req.requestId, { error: `Unknown page ${req.pageId}` })
	let ids: TLShapeId[]
	if (req.shapeIds?.length) {
		ids = (req.shapeIds as TLShapeId[]).filter((id) => e.getShape(id))
		if (ids.length === 0) return replyJson(req.requestId, { error: 'None of those shapes exist.' })
	} else {
		ids = [...e.getPageShapeIds(req.pageId as TLPageId)]
		if (req.bounds) {
			const area = new Box(req.bounds.x, req.bounds.y, req.bounds.w, req.bounds.h)
			ids = ids.filter((id) => {
				const b = e.getShapePageBounds(id)
				return b ? area.collides(b) : false
			})
		}
		if (ids.length === 0) return replyJson(req.requestId, { error: 'Nothing to capture there: no shapes on that page in that area.' })
	}
	const bounds = e.getShapesPageBounds(ids)
	// Keep the picture a size a model can read: cap the longest side, whatever scale was asked for.
	const fit = bounds ? MAX_SIDE / Math.max(bounds.w, bounds.h, 1) : 1
	const scale = Math.min(req.scale ?? 1, fit, 2)
	const { blob } = await e.toImage(ids, { format: 'png', scale, background: true, padding: 32 })
	return reply(req.requestId, 'image/png', blob)
}

// Sync is asynchronous: the agent's write can reach the server well before it reaches this tab. Wait until the tab
// has every record the server had when it asked, so we never render a half-arrived canvas.
async function untilSynced(e: Editor, ids: string[], timeoutMs = 5000): Promise<number> {
	const start = Date.now()
	for (;;) {
		const missing = ids.filter((id) => !e.store.has(id as TLRecord['id']))
		if (missing.length === 0 || Date.now() - start > timeoutMs) return missing.length
		await new Promise((r) => setTimeout(r, 50))
	}
}

// Handler for useSync's onCustomMessageReceived.
export async function onBridgeMessage(data: unknown) {
	const req = data as Partial<CaptureRequest> | null
	if (!req || typeof req.requestId !== 'string' || !editor) return
	try {
		const missing = await untilSynced(editor, req.expectIds ?? [])
		if (missing > 0) {
			await replyJson(req.requestId, {
				error: `The browser tab is still catching up with the canvas (${missing} items not received yet). Try again in a moment.`,
			})
			return
		}
		if (req.type === 'capture') await capture(editor, req as CaptureRequest)
	} catch (err) {
		await replyJson(req.requestId, { error: err instanceof Error ? err.message : String(err) })
	}
}
