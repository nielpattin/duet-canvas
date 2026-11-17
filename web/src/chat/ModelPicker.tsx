import { useMemo, useRef, useState } from 'react'
import { ChevronDownIcon } from '../icons.tsx'
import { chat, useChat, type ModelInfo } from './store.ts'

// Providers are a rail on the left and only the active provider's models are listed, so the ~120 models never render at once.
// Typing in the search box looks across every provider instead. The popover API gives light-dismiss and Esc for free.
export function ModelPicker() {
	const model = useChat((s) => s.model)
	const models = useChat((s) => s.models)
	const [query, setQuery] = useState('')
	const [picked, setPicked] = useState<string | null>(null)
	const popover = useRef<HTMLDivElement>(null)
	const search = useRef<HTMLInputElement>(null)

	const providers = useMemo(() => {
		const counts = new Map<string, number>()
		for (const m of models ?? []) counts.set(m.provider, (counts.get(m.provider) ?? 0) + 1)
		return [...counts]
	}, [models])

	const active = picked ?? model?.provider ?? providers[0]?.[0]
	const q = query.trim().toLowerCase()
	const visible = !models
		? []
		: q
			? models.filter((m) => `${m.provider} ${m.name} ${m.id}`.toLowerCase().includes(q))
			: models.filter((m) => m.provider === active)

	function choose(m: ModelInfo) {
		chat.setModel(m)
		popover.current?.hidePopover()
	}

	return (
		<>
			<button type="button" className="model-trigger" popoverTarget="model-popover" title="Change model">
				<span className="model-trigger-name">{model?.name ?? 'Model'}</span>
				<ChevronDownIcon />
			</button>
			<div
				id="model-popover"
				ref={popover}
				popover="auto"
				className="model-popover"
				onToggle={(e) => {
					if (e.newState === 'open') {
						chat.loadModels()
						search.current?.focus()
					} else {
						setQuery('')
						setPicked(null)
					}
				}}
			>
				<input
					ref={search}
					className="model-search"
					type="search"
					placeholder="Search all models"
					aria-label="Search models"
					value={query}
					onChange={(e) => setQuery(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === 'Enter' && visible[0]) choose(visible[0])
					}}
				/>
				<div className="model-body">
					<ul className="model-providers" aria-label="Providers" data-dimmed={q !== ''}>
						{providers.map(([p, n]) => (
							<li key={p}>
								<button type="button" aria-pressed={p === active && q === ''} onClick={() => (setPicked(p), setQuery(''))}>
									<span>{p}</span>
									<span className="count">{n}</span>
								</button>
							</li>
						))}
					</ul>
					<ul className="model-list">
						{!models && <li className="model-note">Loading models…</li>}
						{models && visible.length === 0 && <li className="model-note">No model matches “{query}”.</li>}
						{visible.map((m) => (
							<li key={`${m.provider}/${m.id}`}>
								<button type="button" aria-current={m.provider === model?.provider && m.id === model?.id} onClick={() => choose(m)}>
									<span className="model-name">{m.name}</span>
									<span className="model-meta">
										{q ? `${m.provider} · ` : ''}
										{m.id !== m.name ? m.id : ''}
										{m.image ? '' : `${m.id !== m.name ? ' · ' : ''}no images`}
									</span>
								</button>
							</li>
						))}
					</ul>
				</div>
			</div>
		</>
	)
}
