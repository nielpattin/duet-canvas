import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { room } from './room.ts'
import {
	addMedia,
	addTextBlock,
	changesSince,
	contentBounds,
	createPage,
	currentClock,
	createShapes,
	deleteShapes,
	describeShapes,
	listMarks,
	listPages,
	pageCounts,
	readImage,
	replyToMark,
	resolveMark,
	resolvePageId,
	ShapeInput,
	ShapePatch,
	updateShapes,
} from './shapes.ts'
import { getUiContext } from './uiContext.ts'

const instructionsFor = (origin: string) => `
This server is a shared infinite whiteboard (a tldraw canvas) that the user has open in their browser. You and the
user both draw on it. It is saved on the server, so you can read and edit it even when the browser is closed.
Coordinates are page pixels, x grows right, y grows down. Shape ids look like "shape:abc".

PAGES
- The canvas has pages. Every shape and mark says its pageId and pageName. get_context tells you which page the
  user is on (currentPage); new content goes there unless you pass pageId. create_page adds a page. You cannot move the user's view: say which page and where you put things.

WHO WROTE WHAT
- Everything you create is stamped author "agent". Shapes with author "user" are the user's.
- Your text blocks are violet, sans-serif boxes (add_text_block / reply_to_mark). Never write plain text
  shapes for prose; use those tools so the user can tell your words from theirs.

MARKS (how the user talks to you)
- A mark is a pink handwritten note the user adds with the Mark tool (click a shape or block with the tool to mark it), or by right-clicking a selection and choosing "Mark selection". It can be attached to shapes
  (targetIds), including your own blocks and images, or float free. Its text is the user's message.
- Each mark has a status: "open" (not handled) or "answered". Editing an answered mark reopens it.
- Workflow: call list_marks to get the open ones, read each mark AND its targets (the targets say what
  "this" refers to), do what is asked, then close it with reply_to_mark (writes your answer beside it and marks
  it answered) or resolve_mark (no text needed, e.g. you only changed the canvas). Never leave a handled
  mark open, and never touch marks with status "answered" unless the user reopened them.
- A mark on a selection has a dashed pink box around everything selected ("selection": its x, y, w, h in list_marks).
  Answering turns the box violet and points your reply at it. Its x, y, w, h tell you which shapes it covers.
- A mark aimed at one of your replies, or at a box you already answered, continues a conversation: list_marks adds "thread" (what the user wrote first, what you answered, and the box it was about, oldest first). Read it before answering.
- list_marks is enough when you only need the marks; get_context also gives selection and viewport (its marks are a short list).
- When the user says "this", "that" or "here" without a mark, call get_context: it returns their current
  selection, viewport and open marks. It works with the browser closed too (last known state).

SEEING THE CANVAS
- get_canvas returns data (types, positions, sizes, text, colors, arrow bindings), not a picture. Work from that: you
  cannot render the canvas, so do not try to confirm how something looks, and NEVER open a browser to check your work.

MEDIA
- get_canvas lists image and video shapes but does not show them. Call view_image with an image shape id to actually
  see it (videos cannot be viewed, only listed).
- add_media puts a PNG, JPEG, GIF, WebP, MP4 or WebM on the canvas as a media card (picture plus caption in one shape; edit the caption with update_shapes text). Give a local file path, a URL (the server downloads
  it) or base64. Use path or url for anything big.

STAYING IN SYNC (the user edits the canvas while you work)
- Every read is live; the server never serves stale data. But you are not pushed updates between calls.
- Every tool result ends with canvas.clock (the document version) and canvas.openMarks. Remember the clock from
  your last call; before you edit or after a long task, call get_changes({sinceClock}) to see exactly what the user
  added, edited, moved or deleted since, and re-check openMarks for new messages.
- Selection and viewport are not part of the document. get_context always returns the current ones.

LAYOUT
- Arrows: give shapes ids and connect them with {type:"arrow", from, to}; they bind and follow the shapes when moved.
  Pick route per arrow: "straight" for tidy flows, "curve" for maps/trees that fan out, "elbow" for loops.
  Lay diagrams out in a grid so arrows run between neighbours without crossing other shapes, and fix any warning
  create_shapes returns.
- Omit x and y when creating shapes, text blocks and images: the server finds a free spot near the anchor (the "near"
  shape, or what the user is looking at) and never lands on top of existing content or on the arrows between shapes.
  Shapes you give explicit x/y form one drawing: if it would land on shapes or arrows, the server slides the whole
  drawing as a unit to the nearest free space and reports "shifted" (positions in "created" are final).
  The canvas is infinite, so never squeeze content into gaps between things.
- get_canvas returns every shape's bounds plus contentBounds, so you can plan where things go. Keep related things
  close, and do not move the user's shapes unless asked.
`.trim()

// Every JSON result carries the canvas version and the open-mark count, so the agent can notice that
// the user changed something (or left a new message) between two calls without polling.
const json = (value: unknown, nag = true) => {
	const body = value && typeof value === 'object' && !Array.isArray(value) ? value : { result: value }
	const open = listMarks('open').length
	const canvas = { clock: currentClock(), openMarks: open }
	// A plain sentence is harder to overlook than a counter: the agent only learns of new marks when it looks.
	const notice = nag && open > 0 ? { notice: `The user has ${open} open mark${open === 1 ? '' : 's'} waiting for you. Call list_marks and answer ${open === 1 ? 'it' : 'them'}.` } : {}
	return { content: [{ type: 'text' as const, text: JSON.stringify({ ...body, ...notice, canvas }, null, 2) }] }
}
const failure = (e: unknown) => ({
	isError: true,
	content: [{ type: 'text' as const, text: e instanceof Error ? e.message : String(e) }],
})

// Wraps a tool body so thrown errors become MCP tool errors instead of protocol errors.
// `nag: false` for tools that already deal with marks, where "call list_marks" would be noise.
async function guard(fn: () => unknown, nag = true) {
	try {
		return json(fn(), nag)
	} catch (e) {
		return failure(e)
	}
}

const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024

async function download(url: string): Promise<Buffer> {
	if (!/^https?:/i.test(url)) throw new Error('Only http(s) URLs can be downloaded')
	const res = await fetch(url, { signal: AbortSignal.timeout(60_000), headers: { 'User-Agent': 'Mozilla/5.0 canvas-mcp' } })
	if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`)
	const declared = Number(res.headers.get('content-length') ?? 0)
	if (declared > MAX_DOWNLOAD_BYTES) throw new Error(`File is ${(declared / 1048576).toFixed(0)} MB, over the 100 MB limit`)
	const data = Buffer.from(await res.arrayBuffer())
	if (data.length > MAX_DOWNLOAD_BYTES) throw new Error('File is over the 100 MB limit')
	return data
}

function intersects(
	s: { x?: unknown; y?: unknown; w?: unknown; h?: unknown },
	v: { x: number; y: number; w: number; h: number }
) {
	const x = Number(s.x)
	const y = Number(s.y)
	const w = Number(s.w ?? 0)
	const h = Number(s.h ?? 0)
	return x + w >= v.x && x <= v.x + v.w && y + h >= v.y && y <= v.y + v.h
}

// Stateless: a fresh server per request. All state lives in the room, not in MCP sessions.
export function buildMcpServer(origin: string) {
	const server = new McpServer({ name: 'canvas', version: '0.4.0' }, { instructions: instructionsFor(origin) })

	server.registerTool(
		'get_context',
		{
			description:
				'What the user is looking at and talking about: selected shapes, viewport, current page and a short list of open marks (id, text, targetIds; use list_marks for the full target shapes). ' +
				'Call this first when the user says "this", "that", "here" or "the selected one". ' +
				'Works with the browser closed, returning the last known state (see tabOpen / updatedAt).',
		},
		() =>
			guard(() => {
				const tabOpen = room.getNumActiveSessions() > 0
				const ui = getUiContext()
				const openMarks = listMarks('open').map((m: Record<string, unknown>) => ({
					id: m.id,
					text: m.text,
					pageName: m.pageName,
					targetIds: (m.targets as { id: unknown }[]).map((t) => t.id),
				}))
				if (!ui) return { tabOpen, openMarks, note: 'The user has not opened the canvas yet.' }
				return {
					tabOpen,
					updatedAt: ui.updatedAt ? new Date(ui.updatedAt).toISOString() : null,
					currentPage: listPages().find((p) => p.id === ui.currentPageId) ?? { id: ui.currentPageId },
					viewport: ui.viewport,
					selection: describeShapes(ui.selectedShapeIds),
					openMarks,
					shapesInViewport: describeShapes(undefined, ui.currentPageId).filter((s) => intersects(s, ui.viewport)),
				}
			}, false)
	)

	server.registerTool(
		'get_canvas',
		{
			description:
				'Read the shapes of ONE page (default: the page the user is on; pass pageId for another one): id, type, x, y, w, h, text, color, ' +
				'author (agent|user), kind, and arrow from/to. `pages` lists every page with its shape count. Image shapes are listed but not ' +
				'shown; use view_image. contentBounds is the box around the shapes returned.',
			inputSchema: { pageId: z.string().optional().describe('Page id like "page:page". Defaults to the page the user is on.') },
		},
		({ pageId }) =>
			guard(() => {
				const scope = resolvePageId(pageId)
				const counts = pageCounts()
				return {
					pageId: scope,
					pages: listPages().map((p) => ({ ...p, shapes: counts[p.id] ?? 0 })),
					contentBounds: contentBounds(scope),
					shapes: describeShapes(undefined, scope),
				}
			})
	)

	server.registerTool(
		'list_marks',
		{
			description:
				'The user\'s marks (their messages to you), each with its text, status and the full description of every shape it targets. ' +
				'Defaults to open ones. Empty drafts the user has not written yet are skipped.',
			inputSchema: { status: z.enum(['open', 'answered', 'all']).optional().describe('Default "open"') },
		},
		({ status }) => guard(() => ({ marks: listMarks(status ?? 'open') }), false)
	)

	server.registerTool(
		'reply_to_mark',
		{
			description:
				'Answer a mark: writes your reply as a violet agent block next to it (auto-placed, linked by an arrow) ' +
				'and marks the mark answered. The user can mark your reply to continue the conversation.',
			inputSchema: { markId: z.string(), text: z.string().min(1) },
		},
		({ markId, text }) => guard(() => replyToMark(markId, text), false)
	)

	server.registerTool(
		'resolve_mark',
		{
			description: 'Mark a mark answered without writing a reply (you handled it by changing the canvas).',
			inputSchema: { markId: z.string() },
		},
		({ markId }) => guard(() => ({ resolved: resolveMark(markId) }), false)
	)

	server.registerTool(
		'add_text_block',
		{
			description:
				'Write prose on the canvas as the agent (violet block, recognisably yours). Auto-placed in free space. ' +
				'Use `near` to put it beside a shape and link it with an arrow. For answering a mark use reply_to_mark instead.',
			inputSchema: {
				text: z.string().min(1),
				near: z.string().optional().describe('Shape id to sit beside and link to'),
				w: z.number().optional().describe('Width, default 360'),
				pageId: z.string().optional().describe('Defaults to the page the user is on'),
				x: z.number().optional(),
				y: z.number().optional(),
			},
		},
		(args) => guard(() => addTextBlock(args))
	)

	server.registerTool(
		'create_page',
		{
			description:
				'Add a new page (tab) to the canvas, e.g. for a large diagram that would crowd the user\'s current page. ' +
				'Then pass its id as pageId to create_shapes, add_text_block or add_media. This does not move the user to it: tell them it exists.',
			inputSchema: { name: z.string().min(1).max(100) },
		},
		({ name }) => guard(() => createPage(name))
	)

	server.registerTool(
		'create_shapes',
		{
			description:
				'Create diagram shapes (boxes, notes, arrows...). Give shapes an `id` so arrows can reference them via from/to ' +
				'(arrows then bind and follow the shapes). Omit x/y to auto-place in free space; if you give x/y for several shapes (a wireframe, a layout) they are treated as one drawing and slid together to free space if they would overlap anything, see `shifted` in the result. Geo shapes default to 160x100. ' +
				'Shapes joined by arrows get extra room automatically. Arrow `route`: "straight" (default, tidy flows), "curve" (gentle arc, for maps and trees that fan out) or "elbow" (right angles, for loops). An arrow takes `text`: that is its label, drawn on the arrow, so never make a separate text shape for a label. ' +
				'Read the returned warnings: they flag arrows that pass through other shapes or are too short to see. ' +
				'Everything created is marked author "agent".',
			inputSchema: {
				shapes: z.array(ShapeInput).min(1),
				pageId: z.string().optional().describe('Defaults to the page the user is on'),
				replace: z
					.boolean()
					.optional()
					.describe('If a shape with the same id exists, recreate it instead of failing. Makes retried calls safe.'),
			},
		},
		({ shapes, pageId, replace }) =>
			guard(() => {
				const out = createShapes(shapes, pageId, replace)
				// Page-scoped, so the agent does not need a get_canvas just to learn where things ended up.
				return {
					page: listPages().find((p) => p.id === out.pageId),
					created: out.created,
					warnings: out.warnings,
					contentBounds: contentBounds(out.pageId),
				}
			})
	)

	server.registerTool(
		'update_shapes',
		{
			description: 'Patch existing shapes by id: move, resize, change text, color or fill.',
			inputSchema: { updates: z.array(ShapePatch).min(1) },
		},
		({ updates }) => guard(() => ({ updated: updateShapes(updates) }))
	)

	server.registerTool(
		'delete_shapes',
		{
			description: 'Delete shapes by id. Arrow bindings to the deleted shapes are removed too.',
			inputSchema: { ids: z.array(z.string()).min(1) },
		},
		({ ids }) => guard(() => ({ deleted: deleteShapes(ids) }))
	)

	server.registerTool(
		'view_image',
		{
			description: 'See an image shape on the canvas (get_canvas only lists it). Returns the actual image.',
			inputSchema: { shapeId: z.string().describe('Id of an image shape, e.g. "shape:abc"') },
		},
		({ shapeId }) => {
			try {
				const img = readImage(shapeId)
				return {
					content: [
						{ type: 'text' as const, text: `${img.name} (${img.mimeType})` },
						{ type: 'image' as const, data: img.base64, mimeType: img.mimeType },
					],
				}
			} catch (e) {
				return failure(e)
			}
		}
	)

	server.registerTool(
		'get_changes',
		{
			description:
				'What changed on the canvas since a clock value from an earlier result (canvas.clock): shapes added or modified ' +
				'(with author, so you can tell the user\'s edits from yours) and ids deleted. Call it before editing and after long tasks.',
			inputSchema: { sinceClock: z.number().int().min(0).describe('canvas.clock from your previous call') },
		},
		({ sinceClock }) => guard(() => changesSince(sinceClock))
	)

	server.registerTool(
		'add_media',
		{
			description:
				'Put an image, GIF or video on the canvas (PNG, JPEG, GIF, WebP, MP4, WebM). Source: `path` (local file on the machine ' +
				'running this server), `url` (the server downloads it, max 100 MB) or `base64` (small files only). ' +
				'Auto-placed in free space unless x/y/near given. Optional caption is written under it.',
			inputSchema: {
				path: z.string().optional(),
				url: z.string().url().optional(),
				base64: z.string().optional(),
				name: z.string().optional().describe('File name, defaults to the path or URL basename'),
				w: z.number().optional().describe('Display width, default min(original, 480)'),
				h: z.number().optional().describe('Display height, default keeps the aspect ratio'),
				x: z.number().optional(),
				y: z.number().optional(),
				near: z.string().optional(),
				caption: z.string().optional(),
				pageId: z.string().optional().describe('Defaults to the page the user is on'),
			},
		},
		async ({ path, url, base64, name, ...rest }) => {
			try {
				const sources = [path, url, base64].filter(Boolean).length
				if (sources !== 1) throw new Error('Provide exactly one of `path`, `url` or `base64`')
				let file: Buffer
				let fallbackName = 'media'
				if (path) {
					file = readFileSync(path)
					fallbackName = basename(path)
				} else if (url) {
					file = await download(url)
					fallbackName = basename(new URL(url).pathname) || 'download'
				} else {
					file = Buffer.from(base64!, 'base64')
				}
				return json(addMedia({ file, name: name ?? fallbackName, ...rest }))
			} catch (e) {
				return failure(e)
			}
		}
	)

	return server
}
