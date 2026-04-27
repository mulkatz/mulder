import { AlertTriangle, GitBranch, Layers3, ShieldCheck, Sigma } from 'lucide-react';
import { Drawer, DrawerContent } from '@/components/primitives/Drawer';
import { DialogTitle } from '@/components/primitives/Dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/primitives/Tabs';
import { VisuallyHidden } from '@/components/primitives/VisuallyHidden';
import { useAuditDrawer } from '@/app/stores/AuditDrawerStore';
import { useEntities } from '@/features/entities/useEntities';
import { useContradictions } from '@/features/evidence/useContradictions';
import { useEvidenceChains } from '@/features/evidence/useEvidenceChains';
import { useEvidenceClusters } from '@/features/evidence/useEvidenceClusters';
import { useEvidenceReliabilitySources } from '@/features/evidence/useEvidenceReliabilitySources';
import { useEvidenceSummary } from '@/features/evidence/useEvidenceSummary';
import { formatConfidence, formatTimestamp } from '@/lib/format';

const tabs = [
  { value: 'summary', label: 'Summary', icon: Sigma },
  { value: 'contradictions', label: 'Contradictions', icon: AlertTriangle },
  { value: 'reliability', label: 'Reliability', icon: ShieldCheck },
  { value: 'chains', label: 'Chains', icon: GitBranch },
  { value: 'clusters', label: 'Clusters', icon: Layers3 },
];

function EmptyAuditState({ text }: { text: string }) {
  return <p className="rounded-xl border border-thread bg-surface p-4 text-sm text-ink-muted">{text}</p>;
}

export function AuditDrawer() {
  const drawer = useAuditDrawer();
  const summary = useEvidenceSummary({ enabled: drawer.open });
  const contradictions = useContradictions({ status: 'all', limit: 50, enabled: drawer.open });
  const reliability = useEvidenceReliabilitySources({ scoredOnly: false, limit: 50, enabled: drawer.open });
  const chains = useEvidenceChains(undefined, { enabled: drawer.open });
  const clusters = useEvidenceClusters(undefined, { enabled: drawer.open });
  const entities = useEntities({ limit: 100, enabled: drawer.open });
  const entityNameById = new Map((entities.data?.data ?? []).map((entity) => [entity.id, entity.name]));

  return (
    <Drawer open={drawer.open} onOpenChange={(open) => (!open ? drawer.close() : drawer.openAudit(drawer.tab ?? 'summary'))}>
      <DrawerContent aria-describedby={undefined} className="w-[min(95vw,44rem)] overflow-y-auto p-0">
        <VisuallyHidden>
          <DialogTitle>Audit drawer</DialogTitle>
        </VisuallyHidden>
        <div className="border-b border-thread p-6">
          <p className="font-mono text-[11px] uppercase tracking-[0.24em] text-amber">Audit</p>
          <h2 className="mt-2 font-serif text-4xl text-ink">What the archive believes.</h2>
          <p className="mt-2 text-sm text-ink-muted">
            Evidence endpoints are read-only in this milestone. Unsupported mutations are intentionally omitted.
          </p>
        </div>

        <Tabs value={drawer.tab ?? 'summary'} onValueChange={drawer.openAudit}>
          <TabsList className="sticky top-0 z-10 flex flex-wrap bg-raised px-5">
            {tabs.map((tab) => {
              const Icon = tab.icon;
              return (
                <TabsTrigger key={tab.value} value={tab.value}>
                  <Icon className="size-4" />
                  {tab.label}
                </TabsTrigger>
              );
            })}
          </TabsList>

          <div className="p-6">
            <TabsContent value="summary">
              {summary.data ? (
                <div className="grid gap-3 sm:grid-cols-2">
                  <Metric label="Entities" value={String(summary.data.data.entities.total)} />
                  <Metric
                    label="Corroboration"
                    value={
                      summary.data.data.entities.avg_corroboration === null
                        ? 'Insufficient corpus'
                        : formatConfidence(summary.data.data.entities.avg_corroboration)
                    }
                  />
                  <Metric label="Potential contradictions" value={String(summary.data.data.contradictions.potential)} />
                  <Metric label="Confirmed contradictions" value={String(summary.data.data.contradictions.confirmed)} />
                  <Metric label="Reliability" value={summary.data.data.sources.data_reliability} />
                  <Metric label="Evidence chains" value={String(summary.data.data.evidence_chains.record_count)} />
                </div>
              ) : (
                <EmptyAuditState text="Loading evidence summary." />
              )}
            </TabsContent>

            <TabsContent value="contradictions">
              <div className="space-y-3">
                {(contradictions.data?.data ?? []).map((edge) => (
                  <article key={edge.id} className="rounded-xl border border-thread bg-surface p-4">
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-carmine">
                          {edge.edge_type.replaceAll('_', ' ').toLowerCase()}
                        </p>
                        <h3 className="mt-1 font-serif text-2xl text-ink">{edge.relationship}</h3>
                      </div>
                      <span className="rounded-full bg-carmine-faint px-3 py-1 text-xs text-carmine">
                        {formatConfidence(edge.confidence)}
                      </span>
                    </div>
                    <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
                      <div>
                        <dt className="text-ink-subtle">Claim A</dt>
                        <dd className="text-ink">{edge.attributes.valueA}</dd>
                      </div>
                      <div>
                        <dt className="text-ink-subtle">Claim B</dt>
                        <dd className="text-ink">{edge.attributes.valueB}</dd>
                      </div>
                    </dl>
                    <p className="mt-3 text-sm text-ink-muted">
                      {entityNameById.get(edge.source_entity_id) ?? 'Source entity'} vs{' '}
                      {entityNameById.get(edge.target_entity_id) ?? 'Target entity'}
                    </p>
                    {edge.analysis ? <p className="mt-3 text-sm text-ink">{edge.analysis.explanation}</p> : null}
                  </article>
                ))}
                {contradictions.data?.data.length === 0 ? <EmptyAuditState text="No contradictions in this corpus." /> : null}
              </div>
            </TabsContent>

            <TabsContent value="reliability">
              <div className="space-y-2">
                {(reliability.data?.data ?? []).map((source) => (
                  <div key={source.id} className="flex items-center justify-between gap-4 rounded-xl border border-thread bg-surface p-4">
                    <div>
                      <p className="font-serif text-xl text-ink">{source.filename}</p>
                      <p className="text-xs text-ink-muted">{formatTimestamp(source.created_at)}</p>
                    </div>
                    <span className="font-mono text-sm text-ink">{formatConfidence(source.reliability_score)}</span>
                  </div>
                ))}
              </div>
            </TabsContent>

            <TabsContent value="chains">
              <div className="space-y-3">
                {(chains.data?.data ?? []).map((group) => (
                  <article key={group.thesis} className="rounded-xl border border-thread bg-surface p-4">
                    <h3 className="font-serif text-2xl text-ink">{group.thesis}</h3>
                    <div className="mt-3 space-y-2">
                      {group.chains.map((chain) => (
                        <div key={chain.id} className="rounded-lg bg-raised p-3 text-sm text-ink-muted">
                          <span className="text-ink">{chain.supports ? 'Supports' : 'Challenges'}</span> with{' '}
                          {formatConfidence(chain.strength)} strength across {chain.path.length} nodes.
                        </div>
                      ))}
                    </div>
                  </article>
                ))}
              </div>
            </TabsContent>

            <TabsContent value="clusters">
              <div className="space-y-3">
                {(clusters.data?.data ?? []).map((cluster) => (
                  <article key={cluster.id} className="rounded-xl border border-thread bg-surface p-4">
                    <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-amber">{cluster.cluster_type}</p>
                    <h3 className="mt-1 font-serif text-2xl text-ink">{cluster.event_count} linked events</h3>
                    <p className="mt-2 text-sm text-ink-muted">
                      {cluster.time_start && cluster.time_end
                        ? `${formatTimestamp(cluster.time_start)} to ${formatTimestamp(cluster.time_end)}`
                        : 'No reliable temporal window yet.'}
                    </p>
                    <p className="mt-1 text-sm text-ink-muted">
                      {cluster.center_lat && cluster.center_lng
                        ? `Center ${cluster.center_lat.toFixed(2)}, ${cluster.center_lng.toFixed(2)}`
                        : 'No reliable spatial center yet.'}
                    </p>
                  </article>
                ))}
              </div>
            </TabsContent>
          </div>
        </Tabs>
      </DrawerContent>
    </Drawer>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-thread bg-surface p-4">
      <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-subtle">{label}</p>
      <p className="mt-2 font-serif text-3xl capitalize text-ink">{value}</p>
    </div>
  );
}
