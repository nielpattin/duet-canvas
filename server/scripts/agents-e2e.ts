// End-to-end check of the chat agents against a throwaway canvas.
//
//   pnpm test:agents                          every agent, every scenario
//   pnpm test:agents -- --agent claude,codex  only some agents
//   pnpm test:agents -- --scenario flow,marks only some scenarios
//
// It starts this repo's server in-process on a temp data dir (your canvas is never touched), drives the real agent
// CLIs through the same WebSocket the browser uses, and then reads the canvas back to check what was drawn.
// The test models are cheap on purpose; they spend a little of your plans/credits.
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { WebSocket } from 'ws'
import type { AgentId } from '../src/chat/driver.ts'
import type { ShapeInput } from '../src/shapes.ts'

const { values: opt } = parseArgs({
	options: {
		agent: { type: 'string' },
		scenario: { type: 'string' },
		port: { type: 'string', default: '5981' },
		timeout: { type: 'string', default: '300' },
		keep: { type: 'boolean', default: false },
	},
	// `pnpm test:agents -- --agent x` passes the separator on to the script.
	args: process.argv.slice(2).filter((a) => a !== '--'),
})

// What each agent runs on for the test: the cheap model and the lowest effort.
const MODELS: Record<AgentId, { provider: string; id: string; label: string }> = {
	omp: { provider: 'opencode-go', id: 'deepseek-v4.1-flash', label: 'opencode-go/deepseek-v4.1-flash' },
	opencode: { provider: 'opencode-go', id: 'opencode-go/deepseek-v4.1-flash', label: 'opencode-go/deepseek-v4.1-flash' },
	claude: { provider: 'anthropic', id: 'haiku', label: 'haiku' },
	codex: { provider: 'openai', id: 'gpt-6-luna', label: 'gpt-6-luna' },
}
const EFFORT = 'low'

const PORT = Number(opt.port)
const PROMPT_MS = Number(opt.timeout) * 1000
const dir = mkdtempSync(join(tmpdir(), 'canvas-agents-'))
const token = randomBytes(32).toString('hex')
let failed = false

// config.ts reads these when it loads, so the server (and shapes.ts) must load after this block.
process.env.DATA_DIR = dir
process.env.PORT = String(PORT)
process.env.HOST = '127.0.0.1'
writeFileSync(join(dir, 'chat-token'), token, { mode: 0o600 })
await import('../src/index.ts')
const S = await import('../src/shapes.ts')
const { room } = await import('../src/room.ts')
// The server's own shutdown ends with process.exit(0), so the verdict and the cleanup are set on exit.
process.on('exit', () => {
	// Windows keeps a folder locked while an agent process that ran in it is still shutting down; a leftover temp dir is harmless.
	if (!opt.keep) {
		try {
			rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
		} catch {
			console.log(`(could not delete ${dir})`)
		}
	}
	process.exitCode = failed ? 1 : 0
})

// ---- Reading and seeding the canvas -----------------------------------------------------------

type Rec = {
	id: string
	type: string
	x: number
	y: number
	w?: number
	h?: number
	text?: string
	color?: string
	author: string
	pageName?: string
	kind?: string
	status?: string
	targetIds?: string[]
	replyTo?: string
	from?: string
	to?: string
	media?: { kind: string }
}
const everything = () => S.describeShapes() as Rec[]
/** Ordinary shapes the agent drew (no marks, replies or other chat furniture). */
const drawn = () => everything().filter((s) => s.author === 'agent' && !s.kind)
const label = (s: Rec) => (s.text ?? '').trim().toLowerCase()
const withLabel = (list: Rec[], text: string, type?: string) => list.find((s) => label(s) === text.toLowerCase() && (!type || s.type === type))
const overlap = (a: Rec, b: Rec) => a.x < b.x + (b.w ?? 0) && b.x < a.x + (a.w ?? 0) && a.y < b.y + (b.h ?? 0) && b.y < a.y + (a.h ?? 0)
const anyOverlap = (list: Rec[]) => list.some((a, i) => list.slice(i + 1).some((b) => overlap(a, b)))

const resetCanvas = () => void S.deleteShapes(everything().map((s) => s.id))

// Shapes the user would have drawn: createShapes stamps "agent", so the stamp is taken off (plus optional meta).
function seed(inputs: ShapeInput[], meta: Record<string, unknown> = {}): string[] {
	const made = S.createShapes(inputs).created.map((c) => c.id)
	room.storage.transaction((txn) => {
		for (const id of made) {
			const r = txn.get(id as never) as { meta: Record<string, unknown> }
			const m = { ...r.meta, ...meta }
			delete m.author
			txn.set(id as never, { ...r, meta: m } as never)
		}
	})
	return made
}
const seedMark = (text: string, at: { x: number; y: number }, targetIds: string[] = []) =>
	seed([{ type: 'note', text, ...at }], { kind: 'mark', status: 'open', targetIds })[0]!

// ---- Chat client: the browser's side of /chat ---------------------------------------------------

type Wire = { role: string; blocks: { type: string; text?: string; id?: string; name?: string }[]; toolCallId?: string; isError?: boolean }
type ModelRow = { provider: string; id: string }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

class Chat {
	items = new Map<string, Wire>()
	agent = ''
	state: { model: ModelRow | null; thinking: string | null; levels: string[]; usage: { cost: number } } | undefined
	models: ModelRow[] = []
	running = false
	runs = 0
	histories = 0
	errors: string[] = []
	#ws: WebSocket

	constructor(ws: WebSocket) {
		this.#ws = ws
		ws.on('message', (raw) => {
			const m = JSON.parse(raw.toString())
			if (m.t === 'message') this.items.set(m.id, m.message)
			else if (m.t === 'history') {
				this.items.clear()
				m.messages.forEach((x: Wire, i: number) => this.items.set(`h${i}`, x))
				this.histories++
			} else if (m.t === 'state') this.state = m
			else if (m.t === 'agent') {
				// Everything after this frame belongs to the newly selected agent.
				this.agent = m.agent
				this.state = undefined
				this.histories = 0
			}
			else if (m.t === 'models') this.models = m.models
			else if (m.t === 'running') {
				this.running = m.running
				if (m.running) this.runs++
			} else if (m.t === 'error') this.errors.push(m.message)
		})
	}

	static async open() {
		const ws = new WebSocket(`ws://127.0.0.1:${PORT}/chat`, { headers: { cookie: `canvas_chat_${PORT}=${token}`, origin: `http://127.0.0.1:${PORT}` } })
		// The server talks first, so the listeners must be on before the socket opens.
		const chat = new Chat(ws)
		const { promise, resolve, reject } = Promise.withResolvers<void>()
		ws.once('open', () => resolve())
		ws.once('error', reject)
		await promise
		return chat
	}

	send(m: Record<string, unknown>) {
		this.#ws.send(JSON.stringify(m))
	}
	close() {
		this.#ws.close()
	}

	async until(pred: () => unknown, ms: number, what: string) {
		const t0 = Date.now()
		while (!pred()) {
			if (Date.now() - t0 > ms) throw new Error(`Timed out waiting for ${what}${this.errors.length ? ` (chat said: ${this.errors.join(' | ')})` : ''}`)
			await sleep(50)
		}
	}

	async prompt(text: string) {
		const before = this.runs
		this.send({ t: 'prompt', message: text, mode: 'steer' })
		await this.until(() => this.runs > before, 60_000, 'the agent to start')
		await this.until(() => !this.running, PROMPT_MS, 'the run to finish')
		await sleep(400) // the last state and message frames trail the end of the run
	}

	async newChat() {
		const before = this.histories
		this.send({ t: 'new_chat' })
		await this.until(() => this.histories > before, 60_000, 'a new chat')
	}

	/** Tool calls of the chat so far, each with its result. */
	tools() {
		const results = new Map<string, Wire>()
		for (const m of this.items.values()) if (m.role === 'tool' && m.toolCallId) results.set(m.toolCallId, m)
		return [...this.items.values()]
			.filter((m) => m.role === 'assistant')
			.flatMap((m) => m.blocks.filter((b) => b.type === 'tool'))
			.map((b) => {
				const r = results.get(b.id!)
				return { name: b.name!, answered: Boolean(r), error: r?.isError ? (r.blocks.find((x) => x.type === 'text')?.text ?? 'error') : undefined }
			})
	}

	/** What the agent said in chat, newest last. */
	said() {
		return [...this.items.values()].filter((m) => m.role === 'assistant').flatMap((m) => m.blocks.filter((b) => b.type === 'text').map((b) => b.text ?? ''))
	}
}

async function setUp(agent: AgentId): Promise<Chat> {
	const chat = await Chat.open()
	await chat.until(() => chat.agent, 30_000, 'the chat to connect')
	// A new data dir starts on omp; switching must not wait for omp, which may be slow or missing. Every start and switch
	// ends with a state and a history frame of the selected agent.
	if (chat.agent !== agent) chat.send({ t: 'set_agent', agent })
	await chat.until(() => chat.agent === agent && chat.histories > 0 && chat.state, 180_000, `${agent} to start`)
	const want = MODELS[agent]
	chat.send({ t: 'models' })
	await chat.until(() => chat.models.length, 60_000, 'the model list')
	if (!chat.models.some((m) => m.provider === want.provider && m.id === want.id)) {
		throw new Error(`${agent} does not offer ${want.provider}/${want.id} (it offers ${chat.models.length} models)`)
	}
	chat.send({ t: 'set_model', provider: want.provider, modelId: want.id })
	await chat.until(() => chat.state?.model?.id === want.id, 120_000, 'the model to be set')
	if (!chat.state?.levels.includes(EFFORT)) throw new Error(`${agent} offers no "${EFFORT}" effort (it offers ${chat.state?.levels.join(', ')})`)
	chat.send({ t: 'set_thinking', level: EFFORT })
	await chat.until(() => chat.state?.thinking === EFFORT, 60_000, 'the effort to be set')
	return chat
}

// ---- Scenarios -----------------------------------------------------------------------------------

type Check = (name: string, ok: unknown, detail?: string) => void
type Step = { prompt: string; verify?: (c: Check) => void }
type Scenario = {
	id: string
	title: string
	setup?: (agent: AgentId) => void
	steps: (agent: AgentId) => Step[]
	verify: (c: Check, agent: AgentId, chat: Chat) => void
}

const SHAPE_KINDS = ['rectangle', 'ellipse', 'diamond', 'triangle', 'hexagon', 'star', 'cloud', 'note']
const PHOTO = resolve(import.meta.dirname, '../../examples/media/photo.jpg')
const pageName = (agent: AgentId) => `Test page ${agent}`

const SCENARIOS: Scenario[] = [
	{
		id: 'flow',
		title: 'a flow: labelled boxes joined by bound arrows',
		steps: () => [
			{
				prompt:
					'Draw a login flow on the canvas: three rectangles labelled exactly "Start", "Login" and "Dashboard", in a row from left to right, ' +
					'joined by two arrows (Start to Login, Login to Dashboard). Give the shapes ids and bind each arrow to its two shapes.',
			},
		],
		verify: (c) => {
			const shapes = drawn().filter((s) => s.type !== 'arrow')
			const arrows = drawn().filter((s) => s.type === 'arrow')
			const [a, b, d] = ['start', 'login', 'dashboard'].map((l) => withLabel(shapes, l, 'rectangle'))
			c('three labelled rectangles', a && b && d, `found ${shapes.map((s) => `${s.type}:${label(s)}`).join(', ') || 'nothing'}`)
			if (!a || !b || !d) return
			c('Start → Login arrow is bound to both shapes', arrows.some((r) => r.from === a.id && r.to === b.id))
			c('Login → Dashboard arrow is bound to both shapes', arrows.some((r) => r.from === b.id && r.to === d.id))
			c('laid out left to right', a.x < b.x && b.x < d.x)
			c('boxes do not overlap', !anyOverlap([a, b, d]))
		},
	},
	{
		id: 'shapes',
		title: 'every shape kind, with colors',
		steps: () => [
			{
				prompt:
					'Draw one shape of each kind, each labelled with its own name in lowercase: rectangle, ellipse, diamond, triangle, hexagon, star, cloud, ' +
					'and a sticky note labelled "note". Use at least four different colors. Draw nothing else.',
			},
		],
		verify: (c) => {
			const made = drawn().filter((s) => s.type !== 'arrow')
			const found = SHAPE_KINDS.map((k) => withLabel(made, k, k))
			const missing = SHAPE_KINDS.filter((_, i) => !found[i])
			c('all eight kinds, each labelled', missing.length === 0, `missing: ${missing.join(', ')}`)
			const colors = new Set(made.map((s) => s.color).filter(Boolean))
			c('at least four colors', colors.size >= 4, `colors: ${[...colors].join(', ')}`)
			c('nothing else drawn', made.length === SHAPE_KINDS.length, `${made.length} shapes`)
			c('shapes do not overlap', !anyOverlap(made))
		},
	},
	{
		id: 'edit',
		title: 'update and delete what it drew',
		steps: () => [
			{
				prompt: 'Create a blue rectangle labelled "Old" and a text block on the canvas that says "Hello canvas".',
				verify: (c) => {
					const rect = withLabel(drawn(), 'old', 'rectangle')
					c('blue rectangle "Old"', rect?.color === 'blue', rect ? `color ${rect.color}` : 'missing')
					c('text block "Hello canvas"', everything().some((s) => label(s).includes('hello canvas')))
				},
			},
			{ prompt: 'Now rename the rectangle to "New", make it red, and delete the text block. Change the existing shapes; do not draw new ones.' },
		],
		verify: (c) => {
			const rects = drawn().filter((s) => s.type === 'rectangle')
			c('one rectangle, renamed and red', rects.length === 1 && label(rects[0]!) === 'new' && rects[0]!.color === 'red', rects.map((r) => `${label(r)}/${r.color}`).join(', ') || 'none')
			c('text block deleted', !everything().some((s) => label(s).includes('hello canvas')))
		},
	},
	{
		id: 'pages',
		title: 'a new page',
		steps: (agent) => [{ prompt: `Create a new page named "${pageName(agent)}" and draw one diamond labelled "Decision" on that page, and nothing on any other page.` }],
		verify: (c, agent) => {
			c('page exists', S.listPages().some((p) => p.name === pageName(agent)))
			const diamonds = drawn().filter((s) => s.type === 'diamond' && label(s) === 'decision')
			c('diamond "Decision" is on the new page', diamonds.length === 1 && diamonds[0]!.pageName === pageName(agent), diamonds.map((d) => d.pageName).join(', ') || 'missing')
			c('nothing drawn on other pages', drawn().every((s) => s.pageName === pageName(agent)))
		},
	},
	{
		id: 'marks',
		title: 'answer marks: reply on one, do the work and close the other',
		setup: () => {
			const [box] = seed([{ type: 'rectangle', id: 'idea-box', text: 'Shared whiteboard for agents', x: 100, y: 100, w: 260, h: 120, color: 'blue' }])
			markIds.box = box!
			markIds.explain = seedMark('Explain in one sentence what this box is for.', { x: 420, y: 100 }, [box!])
			markIds.build = seedMark('Add a green ellipse labelled "Done" next to this note, then close this mark.', { x: 420, y: 320 })
		},
		steps: () => [{ prompt: 'Answer my open marks.' }],
		verify: (c) => {
			const marks = S.listMarks('all') as unknown as { id: string; status: string }[]
			c('both marks answered', marks.length === 2 && marks.every((m) => m.status === 'answered'), marks.map((m) => m.status).join(', '))
			const reply = everything().find((s) => s.kind === 'agent-reply' && s.replyTo === markIds.explain)
			c('the question got a written reply on the canvas', reply && (reply.text ?? '').length > 15, reply ? 'too short' : 'no reply block')
			c('green ellipse "Done" drawn', withLabel(drawn(), 'done', 'ellipse')?.color === 'green')
			const box = everything().find((s) => s.id === markIds.box)
			c("the user's box was left alone", box && box.x === 100 && box.y === 100 && label(box) === 'shared whiteboard for agents')
			c('no placeholder left behind', !everything().some((s) => s.status === 'pending'))
		},
	},
	{
		id: 'media',
		title: 'an image from a local file',
		steps: () => [{ prompt: `Add the image file ${PHOTO} to the canvas with the caption "Test photo".` }],
		verify: (c) => {
			const media = everything().filter((s) => s.type === 'media')
			c('one image card on the canvas', media.length === 1 && media[0]!.media?.kind === 'image', `${media.length} media shapes`)
			c('caption "Test photo"', media.some((s) => label(s) === 'test photo'), media.map(label).join(', '))
		},
	},
	{
		id: 'read',
		title: 'read the canvas without changing it',
		setup: () => {
			seed(['one', 'two', 'three', 'four', 'five'].map((text, i) => ({ type: 'rectangle' as const, text, x: 100 + i * 220, y: 100, w: 160, h: 80 })))
			before = everything().map((s) => `${s.id}@${s.x},${s.y}`).sort().join('|')
		},
		steps: () => [{ prompt: 'Using the canvas tools, how many shapes are on the canvas right now? Answer with just the number.' }],
		verify: (c, _agent, chat) => {
			c('answered 5', chat.said().some((t) => /\b5\b|\bfive\b/i.test(t)), chat.said().join(' / ') || 'no answer')
			c('looked at the canvas', chat.tools().some((t) => /get_canvas|get_context/.test(t.name)))
			c('canvas unchanged', everything().map((s) => `${s.id}@${s.x},${s.y}`).sort().join('|') === before)
		},
	},
]
const markIds: Record<string, string> = {}
let before = ''

// ---- Running -------------------------------------------------------------------------------------

type Outcome = { agent: AgentId; scenario: string; checks: { name: string; ok: boolean; detail: string }[]; ms: number; cost: number }

async function runScenario(chat: Chat, agent: AgentId, sc: Scenario): Promise<Outcome> {
	const checks: Outcome['checks'] = []
	const c: Check = (name, ok, detail = '') => checks.push({ name, ok: Boolean(ok), detail: ok ? '' : String(detail) })
	const t0 = Date.now()
	resetCanvas()
	await chat.newChat()
	chat.errors.length = 0
	try {
		sc.setup?.(agent)
		for (const step of sc.steps(agent)) {
			await chat.prompt(step.prompt)
			step.verify?.(c)
		}
		sc.verify(c, agent, chat)
	} catch (e) {
		c('ran to the end', false, e instanceof Error ? e.message : String(e))
	}
	// What every scenario owes, whatever it drew: the tools were used, correctly, and only the canvas tools.
	const tools = chat.tools()
	const bad = tools.filter((t) => t.error)
	c('used the canvas tools', tools.some((t) => t.name.startsWith('mcp__canvas_')))
	c('no tool errors', bad.length === 0, bad.map((t) => `${t.name}: ${t.error!.replace(/\s+/g, ' ').slice(0, 400)}`).join(' | '))
	c('every tool call was answered', tools.every((t) => t.answered), tools.filter((t) => !t.answered).map((t) => t.name).join(', '))
	c('only canvas tools used', tools.every((t) => t.name.startsWith('mcp__canvas_')), [...new Set(tools.filter((t) => !t.name.startsWith('mcp__canvas_')).map((t) => t.name))].join(', '))
	c('no chat errors', chat.errors.length === 0, chat.errors.join(' | '))
	return { agent, scenario: sc.id, checks, ms: Date.now() - t0, cost: chat.state?.usage.cost ?? 0 }
}

const pick = <T extends string>(arg: string | undefined, all: readonly T[], what: string): T[] => {
	if (!arg) return [...all]
	const wanted = arg.split(',').map((s) => s.trim())
	const unknown = wanted.filter((w) => !all.includes(w as T))
	if (unknown.length) throw new Error(`Unknown ${what}: ${unknown.join(', ')} (known: ${all.join(', ')})`)
	return wanted as T[]
}

const agents = pick<AgentId>(opt.agent, ['omp', 'opencode', 'claude', 'codex'], 'agent')
const scenarios = pick(opt.scenario, SCENARIOS.map((s) => s.id), 'scenario').map((id) => SCENARIOS.find((s) => s.id === id)!)
const outcomes: Outcome[] = []

for (const agent of agents) {
	console.log(`\n${agent} on ${MODELS[agent].label}, effort ${EFFORT}`)
	let chat: Chat
	try {
		chat = await setUp(agent)
	} catch (e) {
		const detail = e instanceof Error ? e.message : String(e)
		console.log(`  SETUP FAILED  ${detail}`)
		for (const sc of scenarios) outcomes.push({ agent, scenario: sc.id, checks: [{ name: 'agent set up', ok: false, detail }], ms: 0, cost: 0 })
		continue
	}
	for (const sc of scenarios) {
		const o = await runScenario(chat, agent, sc)
		outcomes.push(o)
		const bad = o.checks.filter((k) => !k.ok)
		console.log(`  ${bad.length ? 'FAIL' : 'ok  '}  ${sc.id.padEnd(7)} ${(o.ms / 1000).toFixed(0).padStart(3)}s  ${sc.title}`)
		for (const k of bad) console.log(`          x ${k.name}${k.detail ? `: ${k.detail}` : ''}`)
	}
	chat.close()
}

// ---- Summary -------------------------------------------------------------------------------------

console.log('\nSummary')
const width = Math.max(...scenarios.map((s) => s.id.length))
console.log(`${''.padEnd(width)}  ${agents.map((a) => a.padEnd(9)).join('')}`)
for (const sc of scenarios) {
	const cells = agents.map((a) => {
		const o = outcomes.find((x) => x.agent === a && x.scenario === sc.id)!
		const bad = o.checks.filter((k) => !k.ok).length
		return (bad ? `FAIL (${bad})` : 'ok').padEnd(9)
	})
	console.log(`${sc.id.padEnd(width)}  ${cells.join('')}`)
}
failed = outcomes.some((o) => o.checks.some((k) => !k.ok))
console.log(failed ? '\nSome checks failed.' : '\nAll checks passed.')

// The server's own shutdown closes the agents and the database, then exits (see the exit handler above).
process.emit('SIGINT')
