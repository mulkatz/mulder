export const routes = {
  desk: () => '/',
  archive: () => '/archive',
  caseFile: (id: string, options?: { page?: number; storyId?: string; citationId?: string }) => {
    if (!options?.page && !options?.storyId && !options?.citationId) {
      return `/archive/${id}`;
    }

    const params = new URLSearchParams();
    if (typeof options.page === 'number' && options.page > 0) {
      params.set('page', String(options.page));
    }
    if (options.storyId) {
      params.set('story', options.storyId);
    }
    if (options.citationId) {
      params.set('citation', options.citationId);
    }

    return `/archive/${id}?${params.toString()}`;
  },
  reading: (id: string, storyId: string) => `/archive/${id}/read/${storyId}`,
  board: () => '/board',
  ask: () => '/ask',
  login: () => '/auth/login',
  acceptInvite: (token: string) => `/auth/invitations/${token}`,
};
