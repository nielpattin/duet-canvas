import { memo } from 'react'
import { CheckIcon, CloseIcon, DashIcon } from '../icons.tsx'
import { Md } from './Markdown.tsx'
import type { WireMessage } from './store.ts'

const toolLabel = (name: string) => name.replace(/^mcp__duet_canvas_/, '').replaceAll('_', ' ')

// `tools` is one "id:state" line per tool call of this message. Passing it as a string (not a Map) keeps the
// props comparable, so memo skips every message except the one that is streaming.
export const Message = memo(function Message({ message, tools }: { message: WireMessage; tools: string }) {
	if (message.role === 'summary') {
		return (
			<details className="chat-summary">
				<summary>Earlier messages were summarized</summary>
				{message.blocks.map((b, i) => b.type === 'text' && <Md key={i} text={b.text} />)}
			</details>
		)
	}
	if (message.role === 'user') {
		return (
			<div className="chat-user">
				{message.blocks.map((b, i) => {
					if (b.type === 'text') return b.text && <p key={i}>{b.text}</p>
					if (b.type !== 'image') return null
					return b.src ? (
						<a key={i} href={b.src} target="_blank" rel="noreferrer noopener" className="chat-thumb">
							<img src={b.src} alt="Attached" loading="lazy" />
						</a>
					) : (
						<span key={i} className="chat-muted">Image</span>
					)
				})}
			</div>
		)
	}
	const state = new Map(
		tools.split('\n').filter(Boolean).map((s) => {
			const i = s.lastIndexOf(':') // tool call ids may contain other punctuation, the state never does
			return [s.slice(0, i), s.slice(i + 1)] as const
		})
	)
	return (
		<div className="chat-assistant">
			{message.blocks.map((b, i) => {
				if (b.type === 'text') return b.text && <Md key={i} text={b.text} />
				if (b.type === 'thinking') {
					// Claude Code, Codex and opencode often send thinking without readable text; an empty block is just noise.
					if (!b.text.trim()) return null
					return (
						<details key={i} className="chat-thinking">
							<summary>Thinking</summary>
							<p>{b.text}</p>
						</details>
					)
				}
				if (b.type !== 'tool') return null
				const s = state.get(b.id) ?? 'stopped'
				return (
					<div key={i} className="chat-tool" data-state={s} title={b.args}>
						<span className="chat-tool-mark" role="img" aria-label={s}>
							{s === 'done' && <CheckIcon />}
							{s === 'error' && <CloseIcon size={12} />}
							{s === 'stopped' && <DashIcon />}
						</span>
						{toolLabel(b.name)}
						{s === 'running' && <span className="chat-muted">working…</span>}
					</div>
				)
			})}
			{message.error && <p className="chat-error">{message.error}</p>}
		</div>
	)
})
