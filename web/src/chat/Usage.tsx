import { useChat } from './store.ts'

const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 })
const money = (n: number) => (n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`)

// Spend for the current chat plus how full the model's context window is. Context is what decides when a chat gets
// slow, costly and forgetful, so it gets the bar; it turns amber and red as it fills.
export function Usage() {
	const usage = useChat((s) => s.usage)
	if (!usage) return null
	const { cost, tokens, context } = usage
	const pct = context ? Math.min(100, context.percent) : 0
	const detail = [
		`Input ${compact.format(tokens.input ?? 0)} · output ${compact.format(tokens.output ?? 0)}`,
		`Cache read ${compact.format(tokens.cacheRead ?? 0)} · cache write ${compact.format(tokens.cacheWrite ?? 0)}`,
		'Cost and tokens are for this chat',
	].join('\n')
	return (
		<div className="chat-usage" title={detail}>
			<span>{money(cost)}</span>
			{context && (
				<>
					<span className="chat-usage-bar" data-level={pct >= 90 ? 'high' : pct >= 70 ? 'mid' : 'low'} role="meter" aria-label="Context used" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
						<i style={{ width: `${Math.max(pct, 1)}%` }} />
					</span>
					<span>
						{compact.format(context.tokens)} / {compact.format(context.contextWindow)} context
					</span>
				</>
			)}
		</div>
	)
}
