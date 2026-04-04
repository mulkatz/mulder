/**
 * Semantic chunker — splits story Markdown into overlap-aware chunks
 * at paragraph/heading boundaries with configurable size and overlap.
 *
 * The chunker respects semantic boundaries (headings, paragraphs, list blocks,
 * code blocks) and tracks the active heading hierarchy for each chunk.
 *
 * @see docs/specs/32_embedding_wrapper_semantic_chunker_chunk_repository.spec.md §4.3
 * @see docs/functional-spec.md §2.6
 */

// ────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────

/** A single semantic chunk produced by the chunker. */
export type SemanticChunk = {
	content: string;
	chunkIndex: number;
	pageStart: number | null;
	pageEnd: number | null;
	metadata: {
		headings: string[]; // Active heading hierarchy at chunk start
		entityMentions: string[]; // Entity names mentioned in this chunk (placeholder)
	};
};

/** Configuration for the semantic chunker. */
export type ChunkerConfig = {
	chunkSizeTokens: number; // Default: 512
	chunkOverlapTokens: number; // Default: 50
};

// ────────────────────────────────────────────────────────────
// Internal types
// ────────────────────────────────────────────────────────────

/** A semantic block within the Markdown. */
interface SemanticBlock {
	content: string;
	tokens: number;
	type: 'heading' | 'paragraph' | 'list' | 'code' | 'empty';
	headingLevel?: number; // 1-6 for heading blocks
	headingText?: string; // The heading text (without # prefix)
}

// ────────────────────────────────────────────────────────────
// Token estimation
// ────────────────────────────────────────────────────────────

/**
 * Estimates the token count for a text string.
 * Heuristic: `text.length / 4` — close enough for chunking decisions.
 */
function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

// ────────────────────────────────────────────────────────────
// Markdown parsing
// ────────────────────────────────────────────────────────────

/** Heading pattern: one or more `#` followed by a space and text. */
const HEADING_REGEX = /^(#{1,6})\s+(.+)$/;

/**
 * Splits Markdown into semantic blocks: headings, paragraphs,
 * list items, code blocks.
 */
function splitIntoBlocks(markdown: string): SemanticBlock[] {
	const lines = markdown.split('\n');
	const blocks: SemanticBlock[] = [];
	let currentBlock: string[] = [];
	let inCodeBlock = false;

	function flushBlock(): void {
		if (currentBlock.length === 0) return;
		const content = currentBlock.join('\n').trim();
		if (content.length === 0) {
			currentBlock = [];
			return;
		}

		const headingMatch = content.match(HEADING_REGEX);
		if (headingMatch && !inCodeBlock) {
			blocks.push({
				content,
				tokens: estimateTokens(content),
				type: 'heading',
				headingLevel: headingMatch[1].length,
				headingText: headingMatch[2].trim(),
			});
		} else {
			// Detect list blocks vs paragraphs
			const isListBlock = content.split('\n').every((line) => /^[\s]*[-*+]\s|^[\s]*\d+\.\s|^[\s]*$/.test(line));
			blocks.push({
				content,
				tokens: estimateTokens(content),
				type: isListBlock ? 'list' : 'paragraph',
			});
		}
		currentBlock = [];
	}

	for (const line of lines) {
		// Handle code fences
		if (line.trim().startsWith('```')) {
			if (inCodeBlock) {
				// End of code block
				currentBlock.push(line);
				const content = currentBlock.join('\n').trim();
				blocks.push({
					content,
					tokens: estimateTokens(content),
					type: 'code',
				});
				currentBlock = [];
				inCodeBlock = false;
				continue;
			}
			// Start of code block
			flushBlock();
			currentBlock.push(line);
			inCodeBlock = true;
			continue;
		}

		if (inCodeBlock) {
			currentBlock.push(line);
			continue;
		}

		// Empty line = paragraph break
		if (line.trim() === '') {
			flushBlock();
			continue;
		}

		// Heading = always its own block
		if (HEADING_REGEX.test(line.trim())) {
			flushBlock();
			currentBlock.push(line);
			flushBlock();
			continue;
		}

		currentBlock.push(line);
	}

	// Flush remaining content (including unclosed code blocks)
	if (currentBlock.length > 0) {
		if (inCodeBlock) {
			const content = currentBlock.join('\n').trim();
			if (content.length > 0) {
				blocks.push({
					content,
					tokens: estimateTokens(content),
					type: 'code',
				});
			}
		} else {
			flushBlock();
		}
	}

	return blocks;
}

// ────────────────────────────────────────────────────────────
// Sentence splitting for oversized blocks
// ────────────────────────────────────────────────────────────

/**
 * Force-splits a single block at sentence boundaries (`. `, `! `, `? `)
 * when it exceeds `maxTokens`.
 */
function forceSplitBlock(block: SemanticBlock, maxTokens: number): SemanticBlock[] {
	if (block.tokens <= maxTokens) {
		return [block];
	}

	// Split at sentence boundaries
	const sentences = block.content.split(/(?<=[.!?])\s+/);
	const result: SemanticBlock[] = [];
	let currentSentences: string[] = [];
	let currentTokens = 0;

	for (const sentence of sentences) {
		const sentenceTokens = estimateTokens(sentence);

		if (currentTokens + sentenceTokens > maxTokens && currentSentences.length > 0) {
			const content = currentSentences.join(' ');
			result.push({
				content,
				tokens: estimateTokens(content),
				type: block.type,
			});
			currentSentences = [];
			currentTokens = 0;
		}

		currentSentences.push(sentence);
		currentTokens += sentenceTokens;
	}

	if (currentSentences.length > 0) {
		const content = currentSentences.join(' ');
		result.push({
			content,
			tokens: estimateTokens(content),
			type: block.type,
		});
	}

	return result;
}

// ────────────────────────────────────────────────────────────
// Heading hierarchy tracker
// ────────────────────────────────────────────────────────────

/**
 * Tracks the active heading hierarchy as blocks are processed.
 * When a heading of level N is encountered, all headings at level >= N
 * are cleared and the new heading is set.
 */
function updateHeadingHierarchy(hierarchy: Map<number, string>, block: SemanticBlock): string[] {
	if (block.type === 'heading' && block.headingLevel !== undefined && block.headingText !== undefined) {
		// Clear all headings at or below this level
		for (const level of hierarchy.keys()) {
			if (level >= block.headingLevel) {
				hierarchy.delete(level);
			}
		}
		hierarchy.set(block.headingLevel, block.headingText);
	}

	// Return ordered list of headings
	const sorted = [...hierarchy.entries()].sort(([a], [b]) => a - b);
	return sorted.map(([, text]) => text);
}

// ────────────────────────────────────────────────────────────
// Page interpolation
// ────────────────────────────────────────────────────────────

/**
 * Interpolates page range for a chunk based on its proportional
 * position within the total story text.
 */
function interpolatePageRange(
	chunkStartOffset: number,
	chunkEndOffset: number,
	totalLength: number,
	storyPageStart: number | null,
	storyPageEnd: number | null,
): { pageStart: number | null; pageEnd: number | null } {
	if (storyPageStart === null || storyPageEnd === null) {
		return { pageStart: storyPageStart, pageEnd: storyPageEnd };
	}

	const totalPages = storyPageEnd - storyPageStart + 1;
	if (totalPages <= 1 || totalLength === 0) {
		return { pageStart: storyPageStart, pageEnd: storyPageEnd };
	}

	const startRatio = chunkStartOffset / totalLength;
	const endRatio = chunkEndOffset / totalLength;

	const pageStart = Math.floor(storyPageStart + startRatio * (totalPages - 1));
	const pageEnd = Math.ceil(storyPageStart + endRatio * (totalPages - 1));

	return {
		pageStart: Math.max(storyPageStart, pageStart),
		pageEnd: Math.min(storyPageEnd, pageEnd),
	};
}

// ────────────────────────────────────────────────────────────
// Main chunking function
// ────────────────────────────────────────────────────────────

/**
 * Splits story Markdown into semantic chunks respecting heading/paragraph
 * boundaries with configurable overlap.
 *
 * Algorithm:
 * 1. Split Markdown into semantic blocks (headings, paragraphs, lists, code blocks).
 * 2. Estimate token count per block (heuristic: `text.length / 4`).
 * 3. Greedily accumulate blocks into chunks until `chunkSizeTokens` is reached.
 * 4. On chunk boundary: backtrack to last paragraph/heading break.
 * 5. Overlap: the next chunk starts `chunkOverlapTokens` worth of text before
 *    the current chunk's end boundary.
 * 6. Track heading hierarchy — each chunk records active headings at its start.
 * 7. Interpolate page ranges based on proportional offset.
 *
 * @param markdown - The story Markdown text to chunk
 * @param pageStart - The starting page number of the story (or null)
 * @param pageEnd - The ending page number of the story (or null)
 * @param config - Chunker configuration (chunk size, overlap)
 * @returns Array of semantic chunks
 */
export function chunkStory(
	markdown: string,
	pageStart: number | null,
	pageEnd: number | null,
	config: ChunkerConfig,
): SemanticChunk[] {
	// Edge case: empty story
	if (!markdown || markdown.trim().length === 0) {
		return [];
	}

	// Edge case: very short story (< chunkSizeTokens)
	const totalTokens = estimateTokens(markdown);
	if (totalTokens <= config.chunkSizeTokens) {
		return [
			{
				content: markdown.trim(),
				chunkIndex: 0,
				pageStart,
				pageEnd,
				metadata: {
					headings: [],
					entityMentions: [],
				},
			},
		];
	}

	// 1. Split into semantic blocks
	const rawBlocks = splitIntoBlocks(markdown);

	// 2. Force-split any oversized blocks at sentence boundaries
	const blocks: SemanticBlock[] = [];
	for (const block of rawBlocks) {
		if (block.tokens > config.chunkSizeTokens) {
			blocks.push(...forceSplitBlock(block, config.chunkSizeTokens));
		} else {
			blocks.push(block);
		}
	}

	if (blocks.length === 0) {
		return [];
	}

	// 3. Greedily accumulate blocks into chunks
	const chunks: SemanticChunk[] = [];
	const headingHierarchy = new Map<number, string>();
	const totalLength = markdown.length;

	let blockIndex = 0;
	let chunkIndex = 0;
	let textOffset = 0; // Running character offset into the original text

	while (blockIndex < blocks.length) {
		const chunkBlocks: SemanticBlock[] = [];
		let chunkTokens = 0;
		const startOffset = textOffset;

		// Capture current heading hierarchy for this chunk
		const currentHeadings = [...headingHierarchy.entries()].sort(([a], [b]) => a - b).map(([, text]) => text);

		// Accumulate blocks until we exceed chunk size
		while (blockIndex < blocks.length) {
			const block = blocks[blockIndex];

			// If adding this block would exceed the limit and we already have content, stop
			if (chunkTokens + block.tokens > config.chunkSizeTokens && chunkBlocks.length > 0) {
				break;
			}

			// Update heading hierarchy
			updateHeadingHierarchy(headingHierarchy, block);

			chunkBlocks.push(block);
			chunkTokens += block.tokens;
			textOffset += block.content.length + 1; // +1 for paragraph separator
			blockIndex++;

			// If this single block fills the chunk, move on
			if (chunkTokens >= config.chunkSizeTokens) {
				break;
			}
		}

		// Build chunk content
		const content = chunkBlocks.map((b) => b.content).join('\n\n');

		// Interpolate page range
		const endOffset = startOffset + content.length;
		const pageRange = interpolatePageRange(startOffset, endOffset, totalLength, pageStart, pageEnd);

		chunks.push({
			content,
			chunkIndex,
			pageStart: pageRange.pageStart,
			pageEnd: pageRange.pageEnd,
			metadata: {
				headings: currentHeadings,
				entityMentions: [],
			},
		});

		chunkIndex++;

		// 5. Overlap: move blockIndex back to include overlap tokens
		if (blockIndex < blocks.length && config.chunkOverlapTokens > 0) {
			let overlapTokens = 0;
			let overlapBlocksBack = 0;

			// Walk backwards from the current block index to find overlap blocks
			for (let i = blockIndex - 1; i >= 0 && overlapTokens < config.chunkOverlapTokens; i--) {
				overlapTokens += blocks[i].tokens;
				overlapBlocksBack++;
			}

			if (overlapBlocksBack > 0) {
				blockIndex = blockIndex - overlapBlocksBack;
				// Recalculate text offset for the overlap start
				textOffset = 0;
				for (let i = 0; i < blockIndex; i++) {
					textOffset += blocks[i].content.length + 1;
				}
			}
		}
	}

	return chunks;
}
