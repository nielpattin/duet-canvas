import { useRef } from 'react'
import { ChevronDownIcon } from '../icons.tsx'
import { chat, useChat } from './store.ts'

// Which CLI answers in this chat. It replaces the panel's title; agents that are not installed are listed but disabled,
// with the reason, so the user can see what to install. Popover API: light-dismiss and Esc for free.
export function AgentPicker() {
	const availability = useChat((s) => s.availability)
	const agent = useChat((s) => s.agent)
	const connected = useChat((s) => s.connected)
	const popover = useRef<HTMLDivElement>(null)
	if (availability.kind !== 'ready') return <h2>Agent</h2>
	const current = availability.agents.find((a) => a.id === agent)

	return (
		<>
			<button type="button" className="agent-trigger" popoverTarget="agent-popover" title="Change agent" disabled={!connected}>
				<span>{current?.label ?? 'Agent'}</span>
				<ChevronDownIcon />
			</button>
			<div id="agent-popover" ref={popover} popover="auto" className="agent-popover">
				<ul aria-label="Agents">
					{availability.agents.map((a) => (
						<li key={a.id}>
							<button
								type="button"
								aria-current={a.id === agent}
								disabled={!a.ok}
								onClick={() => {
									if (a.id !== agent) chat.setAgent(a.id)
									popover.current?.hidePopover()
								}}
							>
								<span className="agent-name">{a.label}</span>
								<span className="chat-muted">{a.ok ? a.version : 'Not found'}</span>
								{!a.ok && <span className="chat-muted agent-why">{a.message}</span>}
							</button>
						</li>
					))}
				</ul>
			</div>
		</>
	)
}
