import { Gauge } from 'lucide-react';
import type { ReactNode } from 'react';

export function AuthFrame({
	children,
	description,
	title,
}: {
	children: ReactNode;
	description: string;
	title: string;
}) {
	return (
		<main className="flex min-h-screen bg-canvas text-text">
			<section className="flex w-full items-center justify-center p-4 sm:p-6">
				<div className="w-full max-w-[420px]">
					<div className="mb-6 flex items-center gap-3">
						<div className="flex size-9 items-center justify-center rounded-md bg-accent text-text-inverse">
							<Gauge className="size-4" />
						</div>
						<div>
							<p className="text-sm font-semibold text-text">Mulder</p>
							<p className="font-mono text-[11px] text-text-subtle">app</p>
						</div>
					</div>

					<div className="panel p-5">
						<div>
							<p className="font-mono text-xs text-accent">Secure Access</p>
							<h1 className="mt-1 text-xl font-semibold text-text">{title}</h1>
							<p className="mt-2 text-sm text-text-muted">{description}</p>
						</div>
						<div className="mt-5">{children}</div>
					</div>
				</div>
			</section>
		</main>
	);
}
