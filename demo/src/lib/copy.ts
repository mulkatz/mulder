export const copy = {
  nav: {
    desk: 'The Desk',
    archive: 'Archive',
    board: 'Board',
    ask: 'Ask',
  },
  auth: {
    loginTitle: 'Enter the archive',
    loginBody: 'Use the invitation-backed session for this browser.',
    inviteTitle: 'You have been invited to the Mulder archive.',
    loginFailure: "Those credentials didn't match.",
    sessionExpired: 'Your session has ended. Please log in again.',
    forgotPassword: 'Forgot your password? Ask your operator for a fresh invitation.',
  },
  empty: {
    archive: {
      title: 'The archive is empty.',
      body: 'Add documents to the archive to begin.',
    },
    story: {
      title: 'No story is selected.',
      body: 'Pick a story to inspect the extracted text and entities.',
    },
  },
  loading: {
    document: (page: number, total: number) => `Reading page ${page} of ${total}`,
  },
  errors: {
    generic: 'Something went wrong while reading the archive.',
    documentNotFound: 'This document could not be found.',
    layoutUnavailable: "This document has been ingested but stories haven't been extracted yet.",
    pdfRead: "Couldn't read this PDF. The scan may be corrupted.",
    storiesUnavailable: "The story artifacts for this document couldn't be loaded.",
  },
};
