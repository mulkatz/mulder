import { useMemo } from 'react';
import ReactMarkdown, { type Components, defaultUrlTransform } from 'react-markdown';
import type { EntityRecord, TranslatedStoryRecord } from '@/lib/api-types';
import { cn } from '@/lib/cn';

const MENTION_URL_PREFIX = 'mulder-mention:';

type TranslatedMention = TranslatedStoryRecord['mentions'][number];

export interface SafeTranslatedMention extends TranslatedMention {
	href: string;
}

interface MdastPoint {
	offset?: number;
}

interface MdastPosition {
	start?: MdastPoint;
	end?: MdastPoint;
}

interface MdastNode {
	type: string;
	value?: string;
	url?: string;
	title?: string | null;
	children?: MdastNode[];
	position?: MdastPosition;
}

function mentionHref(mentionId: string) {
	return `${MENTION_URL_PREFIX}${encodeURIComponent(mentionId)}`;
}

function decodeMentionHref(href: string | undefined): string | null {
	if (!href?.startsWith(MENTION_URL_PREFIX)) return null;
	return decodeURIComponent(href.slice(MENTION_URL_PREFIX.length));
}

export function getSafeTranslatedMentions(markdown: string, mentions: TranslatedMention[]): SafeTranslatedMention[] {
	const sorted = [...mentions]
		.filter((mention) => {
			return (
				mention.entity &&
				Number.isInteger(mention.start_offset) &&
				Number.isInteger(mention.end_offset) &&
				mention.start_offset >= 0 &&
				mention.end_offset > mention.start_offset &&
				mention.end_offset <= markdown.length &&
				markdown.slice(mention.start_offset, mention.end_offset) === mention.surface_text
			);
		})
		.sort((left, right) => left.start_offset - right.start_offset || left.end_offset - right.end_offset);

	const safe: SafeTranslatedMention[] = [];
	let cursor = 0;
	for (const mention of sorted) {
		if (mention.start_offset < cursor) continue;
		safe.push({ ...mention, href: mentionHref(mention.id) });
		cursor = mention.end_offset;
	}
	return safe;
}

function createTranslatedMentionPlugin(mentions: SafeTranslatedMention[]) {
	return function translatedMentionPlugin() {
		return function transform(tree: MdastNode) {
			function transformChildren(parent: MdastNode) {
				if (!parent.children || parent.type === 'link') return;
				const nextChildren: MdastNode[] = [];
				for (const child of parent.children) {
					if (child.type === 'text' && typeof child.value === 'string') {
						nextChildren.push(...splitTextNode(child));
					} else {
						transformChildren(child);
						nextChildren.push(child);
					}
				}
				parent.children = nextChildren;
			}

			function splitTextNode(node: MdastNode): MdastNode[] {
				const text = node.value;
				const nodeStart = node.position?.start?.offset;
				const nodeEnd = node.position?.end?.offset;
				if (typeof text !== 'string' || typeof nodeStart !== 'number' || typeof nodeEnd !== 'number') {
					return [node];
				}
				const candidates = mentions.filter(
					(mention) => mention.start_offset >= nodeStart && mention.end_offset <= nodeEnd,
				);
				if (candidates.length === 0) return [node];

				const parts: MdastNode[] = [];
				let cursor = 0;
				for (const mention of candidates) {
					const localStart = mention.start_offset - nodeStart;
					const localEnd = mention.end_offset - nodeStart;
					if (
						localStart < cursor ||
						localStart < 0 ||
						localEnd > text.length ||
						text.slice(localStart, localEnd) !== mention.surface_text
					) {
						continue;
					}
					if (localStart > cursor) {
						parts.push({ type: 'text', value: text.slice(cursor, localStart) });
					}
					parts.push({
						type: 'link',
						url: mention.href,
						title: null,
						children: [{ type: 'text', value: text.slice(localStart, localEnd) }],
					});
					cursor = localEnd;
				}
				if (cursor === 0) return [node];
				if (cursor < text.length) {
					parts.push({ type: 'text', value: text.slice(cursor) });
				}
				return parts;
			}

			transformChildren(tree);
		};
	};
}

function markdownComponents(
	mentionByHref: Map<string, SafeTranslatedMention>,
	onSelectEntity: (entity: EntityRecord) => void,
	selectedEntityId?: string,
): Components {
	return {
		a: ({ children, href }) => {
			const mentionId = decodeMentionHref(href);
			const mention = mentionId ? mentionByHref.get(mentionHref(mentionId)) : undefined;
			if (mention?.entity) {
				return (
					<button
						className={cn(
							'rounded-sm bg-accent-soft px-1 text-accent underline decoration-accent/40 decoration-1 underline-offset-2 transition-colors hover:bg-accent hover:text-text-inverse',
							selectedEntityId === mention.entity_id && 'bg-accent text-text-inverse',
						)}
						onClick={() => mention.entity && onSelectEntity(mention.entity)}
						type="button"
					>
						{children}
					</button>
				);
			}
			return (
				<a className="text-accent underline underline-offset-2 hover:text-accent-hover" href={href}>
					{children}
				</a>
			);
		},
		blockquote: ({ children }) => (
			<blockquote className="border-l-2 border-border pl-4 text-text-muted">{children}</blockquote>
		),
		code: ({ children }) => (
			<code className="rounded-sm bg-field px-1 py-0.5 font-mono text-[0.9em] text-text">{children}</code>
		),
		h1: ({ children }) => <h1 className="text-2xl font-semibold text-text">{children}</h1>,
		h2: ({ children }) => <h2 className="text-xl font-semibold text-text">{children}</h2>,
		h3: ({ children }) => <h3 className="text-lg font-semibold text-text">{children}</h3>,
		li: ({ children }) => <li className="pl-1">{children}</li>,
		ol: ({ children }) => <ol className="list-decimal space-y-2 pl-5">{children}</ol>,
		p: ({ children }) => <p>{children}</p>,
		strong: ({ children }) => <strong className="font-semibold text-text">{children}</strong>,
		ul: ({ children }) => <ul className="list-disc space-y-2 pl-5">{children}</ul>,
	};
}

export function TranslatedAnnotatedMarkdown({
	markdown,
	mentions,
	onSelectEntity,
	selectedEntityId,
}: {
	markdown: string;
	mentions: TranslatedMention[];
	onSelectEntity: (entity: EntityRecord) => void;
	selectedEntityId?: string;
}) {
	const safeMentions = useMemo(() => getSafeTranslatedMentions(markdown, mentions), [markdown, mentions]);
	const mentionByHref = useMemo(() => new Map(safeMentions.map((mention) => [mention.href, mention])), [safeMentions]);
	const remarkPlugins = useMemo(() => [createTranslatedMentionPlugin(safeMentions)], [safeMentions]);
	const components = useMemo(
		() => markdownComponents(mentionByHref, onSelectEntity, selectedEntityId),
		[mentionByHref, onSelectEntity, selectedEntityId],
	);

	return (
		<div className="space-y-4 text-sm leading-7 text-text">
			<ReactMarkdown
				components={components}
				remarkPlugins={remarkPlugins}
				urlTransform={(url) => (url.startsWith(MENTION_URL_PREFIX) ? url : defaultUrlTransform(url))}
			>
				{markdown}
			</ReactMarkdown>
		</div>
	);
}
