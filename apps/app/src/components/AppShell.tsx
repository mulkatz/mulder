import { AnimatePresence, motion } from 'framer-motion';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Outlet } from 'react-router-dom';
import { appTransition } from '@/app/motion';
import { Sidebar } from '@/components/Sidebar';
import { Topbar } from '@/components/Topbar';

export function AppShell() {
	const { t } = useTranslation();
	const [sidebarOpen, setSidebarOpen] = useState(false);

	return (
		<div className="min-h-screen bg-canvas text-text">
			<div className="hidden lg:fixed lg:inset-y-0 lg:left-0 lg:z-40 lg:block">
				<Sidebar />
			</div>

			<AnimatePresence>
				{sidebarOpen ? (
					<div className="fixed inset-0 z-50 lg:hidden">
						<motion.button
							aria-label={t('navigation.closeSidebarOverlay')}
							className="absolute inset-0 bg-black/30"
							exit={{ opacity: 0 }}
							initial={{ opacity: 0 }}
							animate={{ opacity: 1 }}
							onClick={() => setSidebarOpen(false)}
							transition={appTransition}
							type="button"
						/>
						<motion.div
							animate={{ x: 0 }}
							className="absolute inset-y-0 left-0"
							exit={{ x: '-100%' }}
							initial={{ x: '-100%' }}
							transition={appTransition}
						>
							<Sidebar mobile onClose={() => setSidebarOpen(false)} />
						</motion.div>
					</div>
				) : null}
			</AnimatePresence>

			<div className="lg:pl-[var(--sidebar-width)]">
				<Topbar onOpenSidebar={() => setSidebarOpen(true)} />
				<main className="min-h-[calc(100vh-var(--topbar-height))]">
					<Outlet />
				</main>
			</div>
		</div>
	);
}
