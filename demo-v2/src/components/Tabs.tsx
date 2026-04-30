import { cn } from '@/lib/cn';

export interface TabItem {
  value: string;
  label: string;
  count?: number;
}

export function Tabs({
  tabs,
  value,
  onChange,
}: {
  tabs: TabItem[];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="max-w-full overflow-x-auto">
      <div className="inline-flex rounded-md border border-border bg-field p-0.5">
        {tabs.map((tab) => (
          <button
            className={cn(
              'inline-flex h-8 shrink-0 items-center gap-2 rounded-sm px-3 text-sm text-text-muted transition-colors hover:text-text',
              value === tab.value && 'bg-panel text-text shadow-soft',
            )}
            key={tab.value}
            onClick={() => onChange(tab.value)}
            type="button"
          >
            <span>{tab.label}</span>
            {tab.count !== undefined ? <span className="font-mono text-xs text-text-subtle">{tab.count}</span> : null}
          </button>
        ))}
      </div>
    </div>
  );
}
