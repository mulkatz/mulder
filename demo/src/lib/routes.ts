export const routes = {
  desk: () => '/',
  archive: () => '/archive',
  caseFile: (id: string) => `/archive/${id}`,
  reading: (id: string, storyId: string) => `/archive/${id}/read/${storyId}`,
  board: () => '/board',
  ask: () => '/ask',
  login: () => '/auth/login',
  acceptInvite: (token: string) => `/auth/invitations/${token}`,
};
