import type { WireMessage } from './wire.ts'

// One chat agent behind the browser chat. The hub owns sockets, the chat index and preferences; a driver owns one
// agent CLI (omp, Claude Code, Codex, opencode) and turns its protocol into this small surface.
export const AGENTS = ['omp', 'claude', 'codex', 'opencode', 'pi'] as const
export type AgentId = (typeof AGENTS)[number]

export type ModelInfo = { provider: string; id: string; name: string; image: boolean }
export type Usage = {
	cost: number
	tokens: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number }
	context: { tokens: number; contextWindow: number; percent: number } | null
}
export type DriverState = {
	model: { provider: string; id: string; name: string } | null
	thinking: string | null
	levels: string[]
	running: boolean
	queue: { steering: string[]; followUp: string[] }
	usage: Usage
	extraTools: string[]
	/** The open chat; undefined until an agent without eager sessions gets its first message. */
	current?: { id: string; file: string }
}
export type Image = { mimeType: string; data: string }
export type Restored = { text?: string; images?: Image[] }
export type PromptInput = { text: string; files: string[]; images: Image[]; mode: 'steer' | 'followUp' }

export type DriverEvents = {
	runStart(): void
	runEnd(): void
	/** `id` is unique per message within this driver; the whole message so far is sent on every update. */
	message(id: string, message: WireMessage, done: boolean): void
	queue(steering: string[], followUp: string[]): void
	/** Model, effort, usage or queue changed. `touch`: a run ended, so the chat index should be refreshed. */
	changed(touch: boolean): void
	error(message: string): void
	closed(reason: string): void
}

export type AgentPrefs = { model?: { provider: string; id: string }; thinking?: string }
export type PrefsStore = { get(): AgentPrefs; set(patch: AgentPrefs): void }

export interface ChatDriver {
	closed: boolean
	start(): Promise<void>
	state(): Promise<DriverState>
	history(): Promise<WireMessage[]>
	/** Resolves once the agent accepted the message (not when the run ends); returns the chat it landed in. */
	prompt(input: PromptInput): Promise<{ id: string; file: string } | undefined>
	/** Stops the run and hands back everything still queued. */
	abort(): Promise<Restored[]>
	unqueue(message: string, queue: 'steering' | 'followUp'): Promise<Restored | undefined>
	promote(message: string): Promise<void>
	newChat(): Promise<void>
	openChat(file: string): Promise<void>
	models(): Promise<ModelInfo[]>
	setModel(provider: string, id: string): Promise<void>
	setThinking(level: string): Promise<void>
	close(): void
}

export type DriverFactory = (events: DriverEvents, prefs: PrefsStore) => ChatDriver
export type Detected = { ok: true; version: string } | { ok: false; message: string }
