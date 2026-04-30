import { motion } from 'framer-motion';
import type { ReactNode } from 'react';
import { pageMotion } from '@/app/motion';

export function PageTransition({ children }: { children: ReactNode }) {
	return (
		<motion.div className="min-h-full" {...pageMotion}>
			{children}
		</motion.div>
	);
}
