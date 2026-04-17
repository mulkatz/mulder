import { useEffect, useRef } from 'react';

const SEQUENCE_TIMEOUT_MS = 700;

function isEditableElement(element: Element | null) {
  if (!element) {
    return false;
  }

  const tagName = element.tagName.toLowerCase();
  return tagName === 'input' || tagName === 'textarea' || element.hasAttribute('contenteditable');
}

function getKey(event: KeyboardEvent) {
  return event.key.length === 1 ? event.key.toLowerCase() : event.key.toLowerCase();
}

function matchesModifierShortcut(event: KeyboardEvent, combo: string) {
  const key = getKey(event);

  if (combo === 'mod+k') {
    return (event.metaKey || event.ctrlKey) && key === 'k';
  }

  if (combo === 'mod+.') {
    return (event.metaKey || event.ctrlKey) && key === '.';
  }

  return false;
}

function matchesSingleShortcut(event: KeyboardEvent, combo: string) {
  const key = getKey(event);

  if (combo === '/') {
    return key === '/';
  }

  if (combo === '?') {
    return key === '?';
  }

  if (combo === 'esc') {
    return event.key === 'Escape';
  }

  return false;
}

export function useShortcut(combo: string, handler: (event: KeyboardEvent) => void, enabled = true) {
  const handlerRef = useRef(handler);

  useEffect(() => {
    handlerRef.current = handler;
  }, [handler]);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    const normalizedCombo = combo.toLowerCase();
    const sequence = normalizedCombo.split(/\s+/).filter(Boolean);
    let pendingIndex = 0;
    let sequenceTimer: number | null = null;

    function resetSequence() {
      pendingIndex = 0;
      if (sequenceTimer !== null) {
        window.clearTimeout(sequenceTimer);
        sequenceTimer = null;
      }
    }

    function onKeyDown(event: KeyboardEvent) {
      const activeEditable = isEditableElement(document.activeElement);
      const key = getKey(event);

      if (matchesModifierShortcut(event, normalizedCombo)) {
        event.preventDefault();
        handlerRef.current(event);
        return;
      }

      if (matchesSingleShortcut(event, normalizedCombo)) {
        if (activeEditable && normalizedCombo !== 'esc') {
          return;
        }

        event.preventDefault();
        handlerRef.current(event);
        return;
      }

      if (sequence.length === 2) {
        if (activeEditable) {
          return;
        }

        if (pendingIndex === 0 && key === sequence[0]) {
          event.preventDefault();
          pendingIndex = 1;
          if (sequenceTimer !== null) {
            window.clearTimeout(sequenceTimer);
          }
          sequenceTimer = window.setTimeout(() => {
            resetSequence();
          }, SEQUENCE_TIMEOUT_MS);
          return;
        }

        if (pendingIndex === 1 && key === sequence[1]) {
          event.preventDefault();
          resetSequence();
          handlerRef.current(event);
          return;
        }

        resetSequence();
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => {
      resetSequence();
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [combo, enabled]);
}

export function focusSearchInput(selector = '[data-mulder-search-input="true"]') {
  const input = document.querySelector<HTMLInputElement>(selector);
  if (!input) {
    return false;
  }

  input.focus();
  input.select?.();
  return true;
}
