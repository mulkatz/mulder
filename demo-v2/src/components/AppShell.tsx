import { useState } from 'react';
import { Outlet } from 'react-router-dom';
import { Sidebar } from '@/components/Sidebar';
import { Topbar } from '@/components/Topbar';

export function AppShell() {
	const [sidebarOpen, setSidebarOpen] = useState(false);

	return (
		<div className="min-h-screen bg-canvas text-text">
			<div className="hidden lg:fixed lg:inset-y-0 lg:left-0 lg:z-40 lg:block">
				<Sidebar />
			</div>

			{sidebarOpen ? (
				<div className="fixed inset-0 z-50 lg:hidden">
					<button
						aria-label="Close sidebar overlay"
						className="absolute inset-0 bg-black/30"
						onClick={() => setSidebarOpen(false)}
						type="button"
					/>
					<div className="absolute inset-y-0 left-0">
						<Sidebar mobile onClose={() => setSidebarOpen(false)} />
					</div>
				</div>
			) : null}

			<div className="lg:pl-[var(--sidebar-width)]">
				<Topbar onOpenSidebar={() => setSidebarOpen(true)} />
				<main className="min-h-[calc(100vh-var(--topbar-height))]">
					<Outlet />
				</main>
			</div>
		</div>
	);
}
