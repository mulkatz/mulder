import { Copy } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { IconButton } from '@/components/IconButton';

export function CodeBlock({ label = 'params.json', value }: { label?: string; value: unknown }) {
	const { t } = useTranslation();
	const formatted = JSON.stringify(value, null, 2);

	return (
		<div className="overflow-hidden rounded-md border border-border bg-[#171717] text-[#f7f7f5]">
			<div className="flex items-center justify-between border-b border-white/10 px-3 py-2">
				<span className="font-mono text-xs text-white/60">{label}</span>
				<IconButton
					className="size-7 border-white/10 bg-white/5 text-white/70 hover:bg-white/10 hover:text-white"
					label={t('common.copyParameters')}
				>
					<Copy className="size-3.5" />
				</IconButton>
			</div>
			<pre className="overflow-x-auto p-3 font-mono text-xs leading-5">
				<code>{formatted}</code>
			</pre>
		</div>
	);
}
