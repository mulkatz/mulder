import type { Key, ReactNode } from 'react';
import { cn } from '@/lib/cn';

export interface DataColumn<T> {
	key: string;
	header: string;
	className?: string;
	render: (row: T) => ReactNode;
}

export function DataTable<T>({
	rows,
	columns,
	getRowKey,
	selectedKey,
	onRowClick,
	emptyMessage = 'No rows',
	minWidth = 760,
}: {
	rows: T[];
	columns: DataColumn<T>[];
	getRowKey: (row: T) => Key;
	selectedKey?: Key;
	onRowClick?: (row: T) => void;
	emptyMessage?: string;
	minWidth?: number;
}) {
	return (
		<div className="overflow-x-auto">
			<table className="w-full border-collapse text-left" style={{ minWidth }}>
				<thead>
					<tr className="border-b border-border bg-panel-raised">
						{columns.map((column) => (
							<th
								className={cn('px-4 py-3 text-xs font-medium text-text-subtle', column.className)}
								key={column.key}
								scope="col"
							>
								{column.header}
							</th>
						))}
					</tr>
				</thead>
				<tbody>
					{rows.map((row) => {
						const rowKey = getRowKey(row);
						const isSelected = selectedKey === rowKey;
						return (
							<tr
								className={cn(
									'border-b border-border transition-colors last:border-b-0',
									onRowClick && 'cursor-pointer hover:bg-accent-soft/60',
									isSelected && 'bg-accent-soft',
								)}
								key={rowKey}
								onClick={onRowClick ? () => onRowClick(row) : undefined}
								onKeyDown={
									onRowClick
										? (event) => {
												if (event.key === 'Enter' || event.key === ' ') {
													event.preventDefault();
													onRowClick(row);
												}
											}
										: undefined
								}
								role={onRowClick ? 'button' : undefined}
								tabIndex={onRowClick ? 0 : undefined}
							>
								{columns.map((column) => (
									<td className={cn('px-4 py-3 align-middle text-sm text-text', column.className)} key={column.key}>
										{column.render(row)}
									</td>
								))}
							</tr>
						);
					})}
					{rows.length === 0 ? (
						<tr>
							<td className="px-4 py-8 text-center text-sm text-text-muted" colSpan={columns.length}>
								{emptyMessage}
							</td>
						</tr>
					) : null}
				</tbody>
			</table>
		</div>
	);
}
