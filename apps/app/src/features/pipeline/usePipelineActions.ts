import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

export type PipelineRestartStep = 'quality' | 'extract' | 'segment' | 'enrich' | 'embed' | 'graph';

interface PipelineAcceptedResponse {
	data: {
		job_id: string;
		status: 'pending';
		run_id: string;
	};
	links: { status: string };
}

function invalidatePipelineQueries(queryClient: ReturnType<typeof useQueryClient>, sourceId?: string) {
	void queryClient.invalidateQueries({ queryKey: ['jobs'] });
	if (sourceId) {
		void queryClient.invalidateQueries({ queryKey: ['documents', sourceId, 'observability'] });
	}
}

export function useRunPipeline(sourceId?: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (input: { from?: PipelineRestartStep; force?: boolean; tag?: string }) => {
			if (!sourceId) throw new Error('sourceId is required to run the pipeline');
			return apiFetch<PipelineAcceptedResponse>('/api/pipeline/run', {
				body: JSON.stringify({
					source_id: sourceId,
					from: input.from,
					force: input.force ?? false,
					tag: input.tag,
				}),
				method: 'POST',
			});
		},
		onSuccess: () => invalidatePipelineQueries(queryClient, sourceId),
	});
}
