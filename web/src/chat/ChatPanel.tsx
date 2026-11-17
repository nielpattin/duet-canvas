import { useCallback, useState } from 'react'
import './chat.css'
import { CloseIcon } from '../icons.tsx'
import { Composer } from './Composer.tsx'
import { HistoryPicker } from './HistoryPicker.tsx'
import { Message } from './Message.tsx'
import { chat, useChat, type WireMessage } from './store.ts'
import { useDarkMode } from './theme.ts'

const SUGGESTIONS = ['Answer my open marks', 'Describe what is on the canvas', 'Tidy up the selected shapes']
// Long chats render only the newest messages; scrolling to the top reveals more, so the DOM stays small.
const WINDOW = 30

// Offered wherever a chat can exist or be unlocked; a Docker server has none, so the button is absent there.
export function ChatToggle() {
	const kind = useChat((s) => s.availability.kind)
	const open = useChat((s) => s.open)
	if (kind !== 'ready' && kind !== 'no-omp' && kind !== 'locked') return null
	return (
		<button type="button" className="chat-toggle" aria-pressed={open} onClick={chat.toggle}>
			Agent chat
		</button>
	)
}

export function ChatPanel() {
	const availability = useChat((s) => s.availability)
	const open = useChat((s) => s.open)
	const connected = useChat((s) => s.connected)
	const dark = useDarkMode()
	const kind = availability.kind
	if (!open || (kind !== 'ready' && kind !== 'no-omp' && kind !== 'locked')) return null
	return (
		<aside className="chat" data-theme={dark ? 'dark' : 'light'} aria-label="Agent chat">
			<header className="chat-head">
				<h2>Agent</h2>
				{kind === 'ready' && !connected && <span className="chat-muted">Reconnecting…</span>}
				<span className="chat-spacer" />
				{kind === 'ready' && (
					<>
						<HistoryPicker />
						<button type="button" className="chat-link" onClick={chat.newChat} disabled={!connected}>
							New chat
						</button>
					</>
				)}
				<button type="button" className="chat-icon" aria-label="Close chat" onClick={chat.toggle}>
					<CloseIcon size={16} />
				</button>
			</header>
			{kind === 'locked' && (
				<div className="chat-empty">
					<p>This browser is not unlocked for the agent chat. Open the link printed by <code>canvas-idea start</code>, or run <code>canvas-idea open</code>.</p>
					<button type="button" className="chat-link" onClick={chat.recheck}>
						Check again
					</button>
				</div>
			)}
			{availability.kind === 'no-omp' && (
				<div className="chat-empty">
					<p>{availability.message}</p>
					<button type="button" className="chat-link" onClick={chat.recheck}>
						Check again
					</button>
				</div>
			)}
			{kind === 'ready' && <Conversation />}
		</aside>
	)
}

// "id:state" lines for a message's tool calls, a primitive so Message's memo can compare it.
function toolStates(message: WireMessage, results: Map<string, boolean>, running: boolean) {
	return message.blocks
		.flatMap((b) => (b.type === 'tool' ? [`${b.id}:${results.has(b.id) ? (results.get(b.id) ? 'error' : 'done') : running ? 'running' : 'stopped'}`] : []))
		.join('\n')
}

function Conversation() {
	const items = useChat((s) => s.items)
	const running = useChat((s) => s.running)
	const error = useChat((s) => s.error)
	const extraTools = useChat((s) => s.extraTools)
	const [limit, setLimit] = useState(WINDOW)

	// Callback ref (no effect): watches the "earlier messages" sentinel. A new limit gives a new observer, which
	// reports the sentinel's current visibility again, so a short list keeps loading until it fills the view.
	const watchTop = useCallback(
		(node: HTMLDivElement | null) => {
			if (!node) return
			const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && setLimit(limit + WINDOW))
			io.observe(node)
			return () => io.disconnect()
		},
		[limit]
	)

	const results = new Map<string, boolean>()
	for (const { message: m } of items) if (m.role === 'tool' && m.toolCallId) results.set(m.toolCallId, Boolean(m.isError))
	const shown = items.filter((i) => i.message.role !== 'tool')
	const visible = shown.length > limit ? shown.slice(-limit) : shown

	return (
		<>
			{extraTools.length > 0 && (
				<p className="chat-warn" title={extraTools.join('\n')}>
					{extraTools.length} tools from your own MCP servers are also available to this agent.
				</p>
			)}
			{/* column-reverse keeps the scroll pinned to the newest message without any scroll code */}
			<div className="chat-scroll">
				<div className="chat-log">
					{shown.length > visible.length && <div ref={watchTop} className="chat-more">Loading earlier messages…</div>}
					{shown.length === 0 && !running ? (
						<div className="chat-empty">
							<p>Ask the agent to draw, move or answer things on the canvas. It sees your selection and open marks.</p>
							<ul className="chat-suggestions">
								{SUGGESTIONS.map((s) => (
									<li key={s}>
										<button type="button" onClick={() => chat.prompt(s)}>
											{s}
										</button>
									</li>
								))}
							</ul>
						</div>
					) : (
						visible.map((item) => <Message key={item.id} message={item.message} tools={toolStates(item.message, results, running)} />)
					)}
					{running && (
						<p className="chat-working">
							<span className="chat-spin" aria-hidden="true" />
							Working…
						</p>
					)}
				</div>
			</div>
			{error && (
				<div className="chat-banner" role="alert">
					<span>{error}</span>
					<button type="button" className="chat-link" onClick={chat.dismissError}>
						Dismiss
					</button>
				</div>
			)}
			<Composer />
		</>
	)
}
