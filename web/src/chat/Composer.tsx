import { useRef, useState } from 'react'
import { MAX_IMAGES } from './images.ts'
import { ModelPicker } from './ModelPicker.tsx'
import { chat, useChat } from './store.ts'
import { Usage } from './Usage.tsx'

function QueueChips() {
	const queue = useChat((s) => s.queue)
	const rows = [
		...queue.steering.map((text) => ({ text, queue: 'steering' as const })),
		...queue.followUp.map((text) => ({ text, queue: 'followUp' as const })),
	]
	if (!rows.length) return null
	return (
		<ul className="chat-queue" aria-label="Queued messages">
			{rows.map(({ text, queue: q }, i) => (
				<li key={`${q}${i}${text}`}>
					<span className="chat-queue-kind">{q === 'steering' ? 'Steering' : 'Next'}</span>
					<span className="chat-queue-text">{text}</span>
					{q === 'followUp' && (
						<button type="button" onClick={() => chat.promote(text)} title="Deliver it now instead of after this run">
							Steer now
						</button>
					)}
					<button type="button" aria-label="Take it back into the message box" title="Take it back to edit" onClick={() => chat.unqueue(text, q)}>
						×
					</button>
				</li>
			))}
		</ul>
	)
}

function AttachIcon() {
	return (
		<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
			<path d="M13.5 7.5 8 13a3.2 3.2 0 0 1-4.5-4.5l5.6-5.6a2.1 2.1 0 0 1 3 3L6.4 11.4a1 1 0 0 1-1.5-1.4L10 4.9" />
		</svg>
	)
}

export function Composer() {
	const connected = useChat((s) => s.connected)
	const running = useChat((s) => s.running)
	const stopping = useChat((s) => s.stopping)
	const levels = useChat((s) => s.levels)
	const thinking = useChat((s) => s.thinking)
	const draft = useChat((s) => s.draft)
	const autoAnswer = useChat((s) => s.autoAnswer)
	const [dragging, setDragging] = useState(false)
	const files = useRef<HTMLInputElement>(null)
	const canSend = connected && (draft.text.trim() !== '' || draft.images.length > 0)

	const submit = (mode: 'steer' | 'followUp') => canSend && chat.send(mode)
	const addFiles = (list: Iterable<File>) => {
		const images = [...list].filter((f) => f.type.startsWith('image/'))
		if (images.length) void chat.addImages(images)
	}

	return (
		<>
			<QueueChips />
			<div
				className="chat-composer"
				data-drop={dragging}
				onDragOver={(e) => {
					if (!e.dataTransfer.types.includes('Files')) return
					e.preventDefault()
					setDragging(true)
				}}
				onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setDragging(false)}
				onDrop={(e) => {
					e.preventDefault()
					setDragging(false)
					addFiles(e.dataTransfer.files)
				}}
			>
				{draft.images.length > 0 && (
					<ul className="chat-attachments" aria-label="Attached images">
						{draft.images.map((img) => (
							<li key={img.id}>
								<img src={img.url} alt="Attached" />
								<button type="button" aria-label="Remove image" onClick={() => chat.removeImage(img.id)}>
									×
								</button>
							</li>
						))}
					</ul>
				)}
				<textarea
					value={draft.text}
					rows={1}
					placeholder={!connected ? 'Connecting…' : running ? 'Enter to steer · Alt+Enter to follow up · Esc to stop' : 'Message the agent. Paste or drop an image to attach it.'}
					aria-label="Message"
					onChange={(e) => chat.setDraftText(e.target.value)}
					onPaste={(e) => {
						const pasted = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/'))
						if (!pasted.length) return
						e.preventDefault()
						addFiles(pasted)
					}}
					onKeyDown={(e) => {
						if (e.key === 'Escape' && running) {
							e.preventDefault()
							chat.stop()
						} else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
							e.preventDefault()
							// Same keys as omp: Enter steers the run in progress, Alt+Enter waits for it to finish.
							submit(e.altKey ? 'followUp' : 'steer')
						}
					}}
				/>
				<div className="chat-controls">
					<input ref={files} type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden onChange={(e) => (addFiles(e.target.files ?? []), (e.target.value = ''))} />
					<button type="button" className="chat-icon" title="Attach image" aria-label="Attach image" disabled={draft.images.length >= MAX_IMAGES} onClick={() => files.current?.click()}>
						<AttachIcon />
					</button>
					<ModelPicker />
					{levels.length > 1 && (
						<select className="chat-effort" aria-label="Thinking effort" title="Thinking effort" value={thinking ?? ''} onChange={(e) => chat.setThinking(e.target.value)}>
							{levels.map((l) => (
								<option key={l} value={l}>
									{l}
								</option>
							))}
						</select>
					)}
					{running && (
						<button type="button" className="chat-ghost" disabled={stopping} onClick={chat.stop} title="Stop the agent (Esc)">
							{stopping ? 'Stopping…' : 'Stop'}
						</button>
					)}
					<button type="button" className="chat-send" disabled={!canSend} onClick={() => submit('steer')} title="Send (Enter). While the agent works: Enter steers, Alt+Enter follows up.">
						Send
					</button>
				</div>
			</div>
			<div className="chat-foot">
				<Usage />
				<label className="chat-auto" title="Answer new marks automatically when the agent is idle">
					<input type="checkbox" checked={autoAnswer} onChange={(e) => chat.setAutoAnswer(e.target.checked)} />
					Auto-answer marks
				</label>
			</div>
		</>
	)
}
