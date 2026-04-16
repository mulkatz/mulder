/* eslint-disable react-hooks/set-state-in-effect */

import { useEffect, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist/types/src/display/api';
import { pdfjs } from '@/lib/pdf';

export function usePdfDocument(url: string) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    let loadedDoc: PDFDocumentProxy | null = null;

    const task = pdfjs.getDocument({ url, withCredentials: true });

    task.promise
      .then((nextDoc) => {
        if (!cancelled) {
          loadedDoc = nextDoc;
          setDoc(nextDoc);
          setLoading(false);
        }
      })
      .catch((nextError: Error) => {
        if (!cancelled) {
          setError(nextError);
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
      void task.destroy();
      void loadedDoc?.destroy();
    };
  }, [url]);

  return {
    doc,
    numPages: doc?.numPages ?? 0,
    loading,
    error,
  };
}
