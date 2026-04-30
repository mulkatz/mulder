export const appTransition = {
	duration: 0.16,
	ease: [0.2, 0, 0, 1],
} as const;

export const pageMotion = {
	initial: { opacity: 0, y: 6 },
	animate: { opacity: 1, y: 0 },
	exit: { opacity: 0, y: -4 },
	transition: appTransition,
} as const;
