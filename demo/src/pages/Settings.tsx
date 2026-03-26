import { useState } from 'react';
import { Settings as SettingsIcon, Palette, Brain, FileText, Users, Sliders, Save, Plus, Trash2, GripVertical } from 'lucide-react';
import { entityTypeLabels } from '../data/mock';
import type { EntityType } from '../data/mock';

type Tab = 'domain' | 'entities' | 'ai' | 'team' | 'system';

const tabs: { id: Tab; label: string; icon: React.ElementType }[] = [
  { id: 'domain', label: 'Domain', icon: SettingsIcon },
  { id: 'entities', label: 'Entity Taxonomy', icon: Palette },
  { id: 'ai', label: 'AI Context', icon: Brain },
  { id: 'team', label: 'Team', icon: Users },
  { id: 'system', label: 'System', icon: Sliders },
];

const entityTypes: { name: string; type: EntityType; color: string; colorHex: string; count: number; subtypes?: string[] }[] = [
  { name: 'Person', type: 'person', color: 'bg-blue-500', colorHex: '#3b82f6', count: 847, subtypes: ['Witness', 'Researcher', 'Official', 'Journalist'] },
  { name: 'Organization', type: 'organization', color: 'bg-orange-500', colorHex: '#f97316', count: 412, subtypes: ['Government', 'Corporate', 'NGO', 'Media'] },
  { name: 'Event', type: 'event', color: 'bg-purple-500', colorHex: '#a855f7', count: 234, subtypes: ['Hearing', 'Meeting', 'Incident', 'Publication'] },
  { name: 'Location', type: 'location', color: 'bg-green-500', colorHex: '#22c55e', count: 389, subtypes: ['City', 'Country', 'Address', 'Region'] },
  { name: 'Document', type: 'event' as EntityType, color: 'bg-slate-500', colorHex: '#64748b', count: 156, subtypes: ['Court Filing', 'Report', 'Memo', 'Legislation'] },
];

const storyCategories = [
  { name: 'Investigation', color: '#3b82f6', count: 342 },
  { name: 'Analysis', color: '#8b5cf6', count: 218 },
  { name: 'Report', color: '#06b6d4', count: 187 },
  { name: 'Profile', color: '#f59e0b', count: 145 },
  { name: 'Deep Dive', color: '#10b981', count: 98 },
  { name: 'Editorial', color: '#6b7280', count: 64 },
];

const teamMembers = [
  { name: 'Franz Liedke', email: 'franz@mulkatz.dev', role: 'Admin', avatar: 'FL', active: true },
  { name: 'Sarah Martinez', email: 'sarah.m@example.com', role: 'Researcher', avatar: 'SM', active: true },
  { name: 'Alex Kim', email: 'alex.k@example.com', role: 'Researcher', avatar: 'AK', active: true },
  { name: 'Dr. Julia Weber', email: 'j.weber@example.com', role: 'Viewer', avatar: 'JW', active: false },
];

export default function Settings() {
  const [activeTab, setActiveTab] = useState<Tab>('domain');

  return (
    <div className="flex h-[calc(100vh-48px)]">
      {/* Sidebar */}
      <div className="w-52 border-r bg-card p-4">
        <h1 className="text-sm font-semibold mb-4 flex items-center gap-2">
          <SettingsIcon size={14} /> Settings
        </h1>
        <nav className="space-y-0.5">
          {tabs.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setActiveTab(id)}
              className={`w-full flex items-center gap-2 rounded-[var(--radius)] px-3 py-2 text-xs font-medium transition-colors text-left ${
                activeTab === id
                  ? 'bg-primary/10 text-primary'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground'
              }`}
            >
              <Icon size={14} />
              {label}
            </button>
          ))}
        </nav>

        <div className="mt-6 rounded-[var(--radius)] border bg-muted/30 p-3">
          <div className="font-mono text-[9px] text-muted-foreground uppercase tracking-wider mb-1.5">Instance</div>
          <div className="text-xs font-semibold">Financial Investigation</div>
          <div className="font-mono text-[10px] text-muted-foreground mt-0.5">ID: mulder-fin-inv</div>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-3xl">
          {/* Domain Tab */}
          {activeTab === 'domain' && (
            <div className="space-y-6">
              <div>
                <h2 className="text-lg font-semibold mb-1">Domain Configuration</h2>
                <p className="text-xs text-muted-foreground">Define your investigation domain. All extraction and analysis adapts to this configuration.</p>
              </div>

              <div className="rounded-[var(--radius)] border bg-card">
                <div className="border-b px-4 py-3">
                  <h3 className="text-sm font-semibold">Instance Identity</h3>
                </div>
                <div className="p-4 space-y-3">
                  <div>
                    <label className="block text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-1">Instance Name</label>
                    <input defaultValue="Financial Investigation Hub" className="w-full rounded-[var(--radius)] border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary" />
                  </div>
                  <div>
                    <label className="block text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-1">Description</label>
                    <textarea defaultValue="Cross-border financial fraud investigation. Analyzing documents from European financial regulators, investigative journalism outlets, and parliamentary inquiries." rows={3} className="w-full rounded-[var(--radius)] border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary" />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-1">UI Language</label>
                      <div className="rounded-[var(--radius)] border bg-background px-3 py-2 text-sm">English</div>
                    </div>
                    <div>
                      <label className="block text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-1">Content Languages</label>
                      <div className="rounded-[var(--radius)] border bg-background px-3 py-2 text-sm font-mono text-xs">DE, EN, FR</div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Story Categories */}
              <div className="rounded-[var(--radius)] border bg-card">
                <div className="border-b px-4 py-3 flex items-center justify-between">
                  <h3 className="text-sm font-semibold">Story Categories</h3>
                  <button className="flex items-center gap-1 text-[11px] text-primary hover:underline">
                    <Plus size={10} /> Add Category
                  </button>
                </div>
                <div className="divide-y">
                  {storyCategories.map((cat) => (
                    <div key={cat.name} className="flex items-center gap-3 px-4 py-2.5">
                      <GripVertical size={12} className="text-muted-foreground/40 cursor-grab" />
                      <div className="h-3 w-3 rounded-sm border" style={{ backgroundColor: cat.color }} />
                      <span className="text-xs font-medium flex-1">{cat.name}</span>
                      <span className="font-mono text-[10px] text-muted-foreground">{cat.count} stories</span>
                      <button className="text-muted-foreground/40 hover:text-destructive"><Trash2 size={12} /></button>
                    </div>
                  ))}
                </div>
              </div>

              <div className="flex justify-end">
                <button className="flex items-center gap-1.5 rounded-[var(--radius)] border border-primary bg-primary px-4 py-2 text-xs font-medium text-primary-foreground">
                  <Save size={12} /> Save Changes
                </button>
              </div>
            </div>
          )}

          {/* Entity Taxonomy Tab */}
          {activeTab === 'entities' && (
            <div className="space-y-6">
              <div>
                <h2 className="text-lg font-semibold mb-1">Entity Taxonomy</h2>
                <p className="text-xs text-muted-foreground">
                  Define which entity types the AI should extract from your documents. Changes can be applied retroactively to existing stories.
                </p>
              </div>

              <div className="space-y-3">
                {entityTypes.map((et) => (
                  <div key={et.name} className="rounded-[var(--radius)] border bg-card">
                    <div className="flex items-center gap-3 px-4 py-3">
                      <div className="h-4 w-4 rounded-sm border-2" style={{ borderColor: et.colorHex, backgroundColor: `${et.colorHex}20` }} />
                      <div className="flex-1">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-semibold">{et.name}</span>
                          <span className="font-mono text-[10px] text-muted-foreground">{et.count} instances</span>
                        </div>
                      </div>
                      <input
                        type="color"
                        defaultValue={et.colorHex}
                        className="h-6 w-6 cursor-pointer rounded border bg-transparent"
                      />
                      <button className="text-muted-foreground/40 hover:text-destructive"><Trash2 size={14} /></button>
                    </div>
                    {et.subtypes && (
                      <div className="border-t px-4 py-2.5 bg-muted/20">
                        <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-1.5">Subtypes</div>
                        <div className="flex items-center gap-1.5 flex-wrap">
                          {et.subtypes.map((st) => (
                            <span key={st} className="rounded-[var(--radius)] border bg-card px-2 py-0.5 text-[11px] font-mono">
                              {st}
                            </span>
                          ))}
                          <button className="rounded-[var(--radius)] border border-dashed px-2 py-0.5 text-[11px] text-muted-foreground hover:border-primary hover:text-primary">
                            + Add
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>

              <button className="flex w-full items-center justify-center gap-1.5 rounded-[var(--radius)] border-2 border-dashed border-muted-foreground/30 py-3 text-xs text-muted-foreground hover:border-primary hover:text-primary transition-colors">
                <Plus size={14} /> Add Entity Type
              </button>

              <div className="rounded-[var(--radius)] border border-amber-300 dark:border-amber-700 bg-amber-50/50 dark:bg-amber-900/10 p-4">
                <div className="text-xs font-semibold text-amber-800 dark:text-amber-300 mb-1">Retroactive Application</div>
                <p className="text-[11px] text-[#92400e] dark:text-amber-400 leading-relaxed">
                  After changing the taxonomy, you can re-scan all existing stories with the updated entity types.
                  Estimated time: ~15 min for 1,284 stories. Previously confirmed entities will not be affected.
                </p>
                <button className="mt-2 rounded-[var(--radius)] border border-amber-400 dark:border-amber-600 px-3 py-1.5 text-[11px] font-medium text-[#92400e] dark:text-amber-400 hover:bg-amber-100 dark:hover:bg-amber-900/30">
                  Re-scan All Stories
                </button>
              </div>
            </div>
          )}

          {/* AI Context Tab */}
          {activeTab === 'ai' && (
            <div className="space-y-6">
              <div>
                <h2 className="text-lg font-semibold mb-1">AI Context</h2>
                <p className="text-xs text-muted-foreground">
                  Guide the AI's understanding of your domain. This context is included with every extraction and analysis call.
                </p>
              </div>

              <div className="rounded-[var(--radius)] border bg-card">
                <div className="border-b px-4 py-3 flex items-center justify-between">
                  <h3 className="text-sm font-semibold">Domain Context</h3>
                  <span className="rounded bg-primary/10 px-2 py-0.5 font-mono text-[10px] font-medium text-primary">Gemini 2.5 Flash</span>
                </div>
                <div className="p-4">
                  <textarea
                    rows={12}
                    defaultValue={`This archive contains investigative journalism documents focused on cross-border financial crime in Europe. Documents include magazine articles, parliamentary reports, regulatory filings, and wire service archives.

Key domain knowledge:
- Shell company structures often span multiple jurisdictions (Cyprus, Luxembourg, Malta)
- Entity names may appear in multiple languages (German, English, French)
- Financial terminology: layering, structuring, beneficial ownership, KYC/AML
- Regulatory bodies: BaFin, FinCEN, Europol Financial Intelligence Group
- Distinguish between confirmed facts (court documents, official reports) and allegations (journalistic investigation)

Layout hints:
- Magazine articles often have multi-column layouts with pull quotes
- Parliamentary reports have structured sections with numbered paragraphs
- Wire service articles are single-column with datelines

Extraction rules:
- Extract monetary amounts as attributes of events or organizations
- Date precision matters: "Summer 2022" should be captured as approximate
- Cross-reference entity names across languages (e.g., "Deutsche Bank" = "Deutsche Bank" in all languages)
- Flag entities that appear in both journalist sources AND official documents — higher credibility`}
                    className="w-full rounded-[var(--radius)] border bg-background px-4 py-3 font-mono text-xs leading-relaxed focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                </div>
                <div className="border-t px-4 py-3 flex items-center justify-between bg-muted/20">
                  <span className="text-[11px] text-muted-foreground">
                    This context is sent with every AI call · ~320 tokens
                  </span>
                  <div className="flex items-center gap-2">
                    <button className="rounded-[var(--radius)] border px-3 py-1.5 text-[11px] text-muted-foreground hover:bg-secondary">
                      Test with Sample Page
                    </button>
                    <button className="flex items-center gap-1.5 rounded-[var(--radius)] border border-primary bg-primary px-3 py-1.5 text-[11px] font-medium text-primary-foreground">
                      <Save size={10} /> Save Context
                    </button>
                  </div>
                </div>
              </div>

              {/* Model config */}
              <div className="rounded-[var(--radius)] border bg-card">
                <div className="border-b px-4 py-3">
                  <h3 className="text-sm font-semibold">Model Configuration</h3>
                </div>
                <div className="p-4 space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-1">Extraction Model</label>
                      <div className="rounded-[var(--radius)] border bg-background px-3 py-2 font-mono text-xs">gemini-2.5-flash</div>
                    </div>
                    <div>
                      <label className="block text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-1">Embedding Model</label>
                      <div className="rounded-[var(--radius)] border bg-background px-3 py-2 font-mono text-xs">gemini-embedding-001</div>
                    </div>
                  </div>
                  <div>
                    <label className="block text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-1">Confidence Threshold (auto-approve)</label>
                    <div className="flex items-center gap-3">
                      <input type="range" min="50" max="100" defaultValue="85" className="flex-1" />
                      <span className="font-mono text-xs font-medium w-10 text-right">85%</span>
                    </div>
                    <p className="text-[10px] text-muted-foreground mt-1">Stories above this threshold are automatically approved. Below goes to review queue.</p>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Team Tab */}
          {activeTab === 'team' && (
            <div className="space-y-6">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-lg font-semibold mb-1">Team</h2>
                  <p className="text-xs text-muted-foreground">{teamMembers.length} members · {teamMembers.filter(m => m.active).length} active</p>
                </div>
                <button className="flex items-center gap-1.5 rounded-[var(--radius)] border border-primary bg-primary px-4 py-2 text-xs font-medium text-primary-foreground">
                  <Plus size={12} /> Invite Member
                </button>
              </div>

              <div className="rounded-[var(--radius)] border bg-card divide-y">
                {teamMembers.map((member) => (
                  <div key={member.email} className="flex items-center gap-3 px-4 py-3">
                    <div className={`flex h-8 w-8 items-center justify-center rounded-full border font-mono text-xs font-medium ${
                      member.active ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'
                    }`}>
                      {member.avatar}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-medium">{member.name}</div>
                      <div className="font-mono text-[10px] text-muted-foreground">{member.email}</div>
                    </div>
                    <span className={`rounded-[var(--radius)] border px-2 py-0.5 text-[10px] font-medium ${
                      member.role === 'Admin' ? 'bg-primary/10 text-primary border-primary/30' :
                      member.role === 'Researcher' ? 'bg-accent/20 text-accent-foreground' :
                      'bg-muted text-muted-foreground'
                    }`}>
                      {member.role}
                    </span>
                    {!member.active && (
                      <span className="text-[10px] text-muted-foreground italic">Inactive</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* System Tab */}
          {activeTab === 'system' && (
            <div className="space-y-6">
              <div>
                <h2 className="text-lg font-semibold mb-1">System</h2>
                <p className="text-xs text-muted-foreground">Infrastructure status and configuration.</p>
              </div>

              <div className="rounded-[var(--radius)] border bg-card">
                <div className="border-b px-4 py-3">
                  <h3 className="text-sm font-semibold">Infrastructure Tier</h3>
                </div>
                <div className="p-4">
                  <div className="grid grid-cols-3 gap-3">
                    {[
                      { name: 'Budget', price: '~37€/mo', features: ['Cloud SQL + pgvector', 'Full pipeline', 'Semantic search'], active: false },
                      { name: 'Standard', price: '~162€/mo', features: ['+ Spanner Graph', 'GQL queries', 'Entity traversal'], active: true },
                      { name: 'Advanced', price: '~183€+/mo', features: ['+ BigQuery Analytics', '+ Vertex AI Search', 'Managed retrieval'], active: false },
                    ].map((tier) => (
                      <div key={tier.name} className={`rounded-[var(--radius)] border p-3 ${tier.active ? 'border-primary bg-primary/5' : ''}`}>
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-xs font-bold">{tier.name}</span>
                          {tier.active && <span className="rounded bg-primary/10 px-1.5 py-0.5 font-mono text-[9px] font-bold text-primary">ACTIVE</span>}
                        </div>
                        <div className="font-mono text-sm font-bold mb-2">{tier.price}</div>
                        <ul className="space-y-1">
                          {tier.features.map((f) => (
                            <li key={f} className="text-[10px] text-muted-foreground">· {f}</li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              <div className="rounded-[var(--radius)] border bg-card">
                <div className="border-b px-4 py-3">
                  <h3 className="text-sm font-semibold">GCP Services Status</h3>
                </div>
                <div className="divide-y">
                  {[
                    { name: 'Cloud SQL (PostgreSQL + pgvector)', status: 'Healthy', region: 'europe-west3' },
                    { name: 'Spanner Graph', status: 'Healthy', region: 'europe-west3' },
                    { name: 'Document AI', status: 'Healthy', region: 'eu' },
                    { name: 'Vertex AI (Gemini)', status: 'Healthy', region: 'europe-west3' },
                    { name: 'Cloud Run', status: 'Healthy', region: 'europe-west3' },
                    { name: 'Cloud Storage', status: 'Healthy', region: 'europe-west3' },
                  ].map((svc) => (
                    <div key={svc.name} className="flex items-center gap-3 px-4 py-2.5">
                      <div className="h-2 w-2 rounded-full bg-green-500" />
                      <span className="text-xs font-medium flex-1">{svc.name}</span>
                      <span className="font-mono text-[10px] text-muted-foreground">{svc.region}</span>
                      <span className="text-[10px] text-green-600 dark:text-green-400 font-medium">{svc.status}</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Config file preview */}
              <div className="rounded-[var(--radius)] border bg-card">
                <div className="border-b px-4 py-3">
                  <h3 className="text-sm font-semibold flex items-center gap-2">
                    <FileText size={14} /> mulder.config.yaml
                  </h3>
                </div>
                <div className="bg-zinc-950 dark:bg-zinc-950 rounded-b-[var(--radius)] p-4 overflow-x-auto">
                  <pre className="font-mono text-[11px] leading-relaxed text-zinc-300">
{`project:
  name: financial-investigation
  gcp_project_id: mulder-fin-inv
  region: europe-west3
  tier: standard

ontology:
  entities:
    - name: person
      attributes:
        - { name: role, type: string }
        - { name: affiliation, type: string }
    - name: organization
      attributes:
        - { name: type, type: enum, values: [government, corporate, ngo, media] }
    - name: event
      attributes:
        - { name: date, type: date }
        - { name: location, type: string }
    - name: location
      attributes:
        - { name: coordinates, type: geo_point, optional: true }

extraction:
  language: [en, de, fr]
  segmentation:
    strategy: llm
    model: gemini-2.5-flash
  entity_extraction:
    model: gemini-2.5-flash
    confidence_threshold: 0.8`}
                  </pre>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
