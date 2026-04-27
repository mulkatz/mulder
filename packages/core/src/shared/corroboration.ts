/**
 * Presentation helpers for corroboration scores.
 *
 * Graph computation persists numeric scores whenever it can. User-facing
 * surfaces should still suppress those scores until the corpus is large
 * enough for the values to be meaningful.
 */

export type CorroborationPresentationStatus = 'scored' | 'not_scored' | 'insufficient_data';

export interface CorroborationPresentationContext {
	corpusSize: number;
	threshold: number;
}

export interface PresentedCorroborationScore {
	score: number | null;
	status: CorroborationPresentationStatus;
	corpusSize: number;
	threshold: number;
}

export function isCorroborationMeaningful(context: CorroborationPresentationContext): boolean {
	return context.corpusSize >= context.threshold;
}

export function presentCorroborationScore(
	score: number | null,
	context: CorroborationPresentationContext,
): PresentedCorroborationScore {
	if (!isCorroborationMeaningful(context)) {
		return {
			score: null,
			status: 'insufficient_data',
			corpusSize: context.corpusSize,
			threshold: context.threshold,
		};
	}

	return {
		score,
		status: score === null ? 'not_scored' : 'scored',
		corpusSize: context.corpusSize,
		threshold: context.threshold,
	};
}
