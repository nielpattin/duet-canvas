import { useRef, useState } from 'react'
import { CloseIcon } from '../icons.tsx'
import { chat, useChat } from './store.ts'

const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto', style: 'short' })
function ago(ts: number) {
	const s = Math.round((ts - Date.now()) / 1000)
	for (const [unit, size] of [['day', 86400], ['hour', 3600], ['minute', 60]] as const) {
		if (Math.abs(s) >= size) return rtf.format(Math.round(s / size), unit)
	}
	return 'just now'
}

// Earlier chats of every agent, each tagged with the agent that wrote it. Their transcripts stay on disk; opening one
// switches the live session to it, and to its agent first when that is another one.
export function HistoryPicker() {
	const chats = useChat((s) => s.chats)
	const availability = useChat((s) => s.availability)
	const labelOf = (id: string) => (availability.kind === 'ready' ? availability.agents.find((a) => a.id === id)?.label : undefined) ?? id
	const connected = useChat((s) => s.connected)
	const [confirm, setConfirm] = useState<string | null>(null)
	const popover = useRef<HTMLDivElement>(null)

	return (
		<>
			<button type="button" className="chat-link history-trigger" popoverTarget="history-popover" disabled={!connected}>
				History
			</button>
			<div
				id="history-popover"
				ref={popover}
				popover="auto"
				className="history-popover"
				onToggle={(e) => {
					setConfirm(null)
					if (e.newState === 'open') chat.loadChats()
				}}
			>
				{!chats && <p className="chat-muted history-note">Loading chats…</p>}
				{chats?.length === 0 && <p className="chat-muted history-note">No earlier chats yet. A chat appears here after its first message.</p>}
				<ul>
					{chats?.map((c) => (
						<li key={c.id}>
							<button
								type="button"
								className="history-open"
								aria-current={c.current}
								onClick={() => {
									if (!c.current) chat.openChat(c.id)
									popover.current?.hidePopover()
								}}
							>
								<span className="history-title">{c.title}</span>
								<span className="chat-muted">
									{labelOf(c.agent)} · {c.current ? 'Current' : ago(c.updatedAt)}
								</span>
							</button>
							{!c.current &&
								(confirm === c.id ? (
									<button type="button" className="history-delete" data-confirm onClick={() => (chat.deleteChat(c.id), setConfirm(null))}>
										Delete?
									</button>
								) : (
									<button type="button" className="history-delete" aria-label={`Delete ${c.title}`} onClick={() => setConfirm(c.id)}>
										<CloseIcon />
									</button>
								))}
						</li>
					))}
				</ul>
			</div>
		</>
	)
}
