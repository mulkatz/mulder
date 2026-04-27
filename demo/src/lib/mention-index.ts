function unwrapMark(mark: HTMLElement) {
  const parent = mark.parentNode;

  if (!parent) {
    return;
  }

  while (mark.firstChild) {
    parent.insertBefore(mark.firstChild, mark);
  }

  parent.removeChild(mark);
  parent.normalize();
}

function createBoundaryRegex(term: string) {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\p{L}\\p{N}_])(${escaped})(?=$|[^\\p{L}\\p{N}_])`, 'giu');
}

export function clearHighlights(marks: HTMLElement[]) {
  for (const mark of marks) {
    unwrapMark(mark);
  }
}

export function highlightTerms(root: HTMLElement, terms: string[]) {
  const marks: HTMLElement[] = [];
  const candidates = [...new Set(terms.map((term) => term.trim()).filter((term) => term.length >= 3))]
    .sort((left, right) => right.length - left.length);

  if (candidates.length === 0) {
    return marks;
  }

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.textContent?.trim()) {
        return NodeFilter.FILTER_REJECT;
      }

      const parent = node.parentElement;

      if (!parent || parent.closest('[data-mention-ignore="true"]')) {
        return NodeFilter.FILTER_REJECT;
      }

      if (parent.tagName === 'MARK') {
        return NodeFilter.FILTER_REJECT;
      }

      return NodeFilter.FILTER_ACCEPT;
    },
  });

  const textNodes: Text[] = [];
  let current = walker.nextNode();

  while (current) {
    if (current.nodeType === Node.TEXT_NODE) {
      textNodes.push(current as Text);
    }
    current = walker.nextNode();
  }

  for (const node of textNodes) {
    const text = node.textContent ?? '';
    let bestMatch:
      | {
          term: string;
          start: number;
          end: number;
        }
      | null = null;

    for (const term of candidates) {
      const regex = createBoundaryRegex(term);
      const match = regex.exec(text);

      if (!match || typeof match.index !== 'number') {
        continue;
      }

      const prefix = match[1] ?? '';
      const matchedTerm = match[2] ?? '';
      const start = match.index + prefix.length;
      const end = start + matchedTerm.length;

      bestMatch = { term, start, end };
      break;
    }

    if (!bestMatch) {
      continue;
    }

    const before = text.slice(0, bestMatch.start);
    const matchText = text.slice(bestMatch.start, bestMatch.end);
    const after = text.slice(bestMatch.end);
    const fragment = document.createDocumentFragment();

    if (before) {
      fragment.appendChild(document.createTextNode(before));
    }

    const mark = document.createElement('mark');
    mark.className = 'amber-underline amber-underline-active rounded-[2px] bg-transparent px-[1px] text-inherit';
    mark.textContent = matchText;
    fragment.appendChild(mark);
    marks.push(mark);

    if (after) {
      fragment.appendChild(document.createTextNode(after));
    }

    node.parentNode?.replaceChild(fragment, node);
  }

  return marks;
}
