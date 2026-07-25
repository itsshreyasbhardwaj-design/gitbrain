import { describe, expect, it } from 'vitest';

import type { KnowledgeDoc, KnowledgeDocId } from '../types';
import { buildKnowledgeBase } from './index';
import { makeBareContext, makeNpmContext, makeRichContext } from './testing/fixtures';

/** The contract order declared by `KnowledgeDocId` in src/core/types.ts. */
const EXPECTED_IDS: readonly KnowledgeDocId[] = [
  'executive-summary',
  'project-purpose',
  'folder-explanation',
  'architecture-overview',
  'dependency-analysis',
  'code-complexity',
  'technical-debt',
  'entry-points',
  'data-flow',
  'authentication-flow',
  'api-overview',
  'database-overview',
  'deployment-guide',
  'setup-guide',
  'environment-variables',
  'performance-bottlenecks',
  'security-risks',
  'suggested-improvements',
];

const rich = buildKnowledgeBase(makeRichContext());
const bare = buildKnowledgeBase(makeBareContext());

function doc(base: typeof rich, id: KnowledgeDocId): KnowledgeDoc {
  const found = base.docs.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`Expected document ${id} to exist`);
  return found;
}

describe('buildKnowledgeBase', () => {
  it('generates every declared document, in contract order', () => {
    expect(rich.docs.map((d) => d.id)).toEqual(EXPECTED_IDS);
  });

  it('generates the full set even for a nearly empty repository', () => {
    expect(bare.docs.map((d) => d.id)).toEqual(EXPECTED_IDS);
  });

  it('gives every document a title, a summary and real body content', () => {
    for (const generated of rich.docs) {
      expect(generated.title.length, `${generated.id} title`).toBeGreaterThan(0);
      expect(generated.summary.length, `${generated.id} summary`).toBeGreaterThan(0);
      expect(generated.markdown.trim().length, `${generated.id} markdown`).toBeGreaterThan(80);
    }
  });

  it('records derived provenance and no model when no LLM ran', () => {
    expect(rich.model).toBeNull();
    for (const generated of rich.docs) {
      expect(generated.provenance).toBe('derived');
    }
  });

  it('stamps an ISO timestamp', () => {
    expect(new Date(rich.generatedAt).toISOString()).toBe(rich.generatedAt);
  });

  it('never emits an unresolved value or template placeholder', () => {
    // A generator that fell through would leave one of these behind. Cheap
    // insurance against shipping "undefined" or "[object Object]" to a user.
    //
    // Note: a bare "TODO" is NOT checked, because `technical-debt` legitimately
    // reports TODO markers it found in the repository's own source.
    for (const generated of [...rich.docs, ...bare.docs]) {
      expect(generated.markdown, generated.id).not.toMatch(/undefined|NaN|\[object Object\]/);
      expect(generated.markdown, generated.id).not.toMatch(/<!--\s*placeholder|\{\{\s*\w+\s*\}\}/i);
    }
  });

  it('produces balanced Markdown code fences', () => {
    for (const generated of [...rich.docs, ...bare.docs]) {
      const fences = generated.markdown.match(/^```/gm) ?? [];
      expect(fences.length % 2, `${generated.id} has an unclosed fence`).toBe(0);
    }
  });
});

describe('citations', () => {
  it('only ever cites files that exist in the repository', () => {
    const context = makeRichContext();
    const known = new Set(context.files.map((file) => file.path));

    for (const generated of rich.docs) {
      for (const cite of generated.citations) {
        expect(known, `${generated.id} cites a missing file: ${cite.file}`).toContain(cite.file);
      }
    }
  });

  it('uses positive line numbers when it gives them', () => {
    for (const generated of rich.docs) {
      for (const cite of generated.citations) {
        if (cite.startLine !== undefined) expect(cite.startLine).toBeGreaterThan(0);
        if (cite.startLine !== undefined && cite.endLine !== undefined) {
          expect(cite.endLine).toBeGreaterThanOrEqual(cite.startLine);
        }
      }
    }
  });

  it('attaches sources to the documents where evidence matters most', () => {
    for (const id of ['executive-summary', 'setup-guide', 'entry-points'] as const) {
      expect(doc(rich, id).citations.length, id).toBeGreaterThan(0);
    }
  });
});

describe('honesty when a subsystem is absent', () => {
  // The single most important property of this engine: it must never invent an
  // authentication flow, a database or an API that the analyzers did not find.
  //
  // These assert on the OPENING of each document, because a doc is allowed to
  // go on to list the markers it searched for — naming `vercel.json` as
  // something checked and not found is honest, and useful. What must not
  // happen is an affirmative claim.

  const NEGATION = /\b(no|none|not|never|without|absent)\b|n't/i;

  function opening(id: KnowledgeDocId): string {
    // The headline claim: everything before the first list or subheading.
    return doc(bare, id).markdown.split(/\n(?:-|\d+\.|#{2,})/)[0] ?? '';
  }

  it.each([
    ['authentication-flow'],
    ['database-overview'],
    ['api-overview'],
    ['deployment-guide'],
  ] as const)('opens %s with an explicit negative statement', (id) => {
    expect(opening(id)).toMatch(NEGATION);
  });

  it('does not present an authentication flow diagram it cannot support', () => {
    // A sequence diagram would be a concrete, confident claim about a flow
    // that was never found — the exact failure mode this engine must avoid.
    expect(doc(bare, 'authentication-flow').markdown).not.toContain('sequenceDiagram');
  });

  it('only cites files that exist, even when reporting an absence', () => {
    // Citing the file it inspected and found nothing in is legitimate; citing
    // a file that does not exist would not be.
    const known = new Set(makeBareContext().files.map((file) => file.path));

    for (const generated of bare.docs) {
      for (const cite of generated.citations) {
        expect(known, `${generated.id} cites a missing file: ${cite.file}`).toContain(cite.file);
      }
    }
  });

  it('still produces a useful setup guide for a bare repository', () => {
    // Absence of a stack is not absence of instructions — the guide should
    // degrade to something honest rather than to nothing.
    expect(doc(bare, 'setup-guide').markdown.trim().length).toBeGreaterThan(80);
  });
});

describe('grounding in real analysis facts', () => {
  it('names the repository in the executive summary', () => {
    expect(doc(rich, 'executive-summary').markdown).toContain('orbit-api');
  });

  it('reports the detected framework rather than a generic one', () => {
    const markdown = `${doc(rich, 'executive-summary').markdown}${doc(rich, 'architecture-overview').markdown}`;
    expect(markdown).toContain('Express');
  });

  it('uses the package manager whose lockfile is committed', () => {
    expect(doc(rich, 'setup-guide').markdown).toContain('pnpm');
  });

  it('switches the setup commands when the package manager changes', () => {
    const npm = buildKnowledgeBase(makeNpmContext());
    const markdown = doc(npm, 'setup-guide').markdown;

    expect(markdown).toContain('npm');
    // The old manager must not linger in the install instructions.
    expect(markdown).not.toMatch(/pnpm (install|run)/);
  });

  it('lists environment variables that the security scan actually found', () => {
    const context = makeRichContext();
    const markdown = doc(rich, 'environment-variables').markdown;

    for (const variable of context.security.envVars.slice(0, 3)) {
      expect(markdown, `expected ${variable.name} to be documented`).toContain(variable.name);
    }
  });

  it('reflects the real dependency count', () => {
    const context = makeRichContext();
    const markdown = doc(rich, 'dependency-analysis').markdown;
    expect(markdown).toContain(String(context.dependencies.dependencies.length));
  });

  it('names the measured complexity hotspot', () => {
    const context = makeRichContext();
    const hotspot = context.complexity.hotspots[0];
    if (!hotspot) return;
    expect(doc(rich, 'code-complexity').markdown).toContain(hotspot.path);
  });

  it('never leaks an unredacted secret into the security document', () => {
    // Findings arrive already redacted; this guards against a generator
    // reconstructing or echoing raw credential material.
    const markdown = doc(rich, 'security-risks').markdown;
    expect(markdown).not.toMatch(/AKIA[0-9A-Z]{16}/);
    expect(markdown).not.toMatch(/sk_live_[A-Za-z0-9]{10,}/);
    expect(markdown).not.toMatch(/gh[pousr]_[A-Za-z0-9]{30,}/);
  });
});

describe('diagrams', () => {
  it('emits at least one Mermaid diagram for a repository with structure', () => {
    const withDiagrams = rich.docs.filter((generated) => generated.markdown.includes('```mermaid'));
    expect(withDiagrams.length).toBeGreaterThan(0);
  });

  it('closes every Mermaid fence it opens', () => {
    for (const generated of rich.docs) {
      const opens = (generated.markdown.match(/```mermaid/g) ?? []).length;
      if (opens === 0) continue;
      const allFences = (generated.markdown.match(/^```/gm) ?? []).length;
      expect(allFences % 2, `${generated.id}`).toBe(0);
    }
  });
});

describe('determinism', () => {
  it('produces identical documents for identical input', () => {
    const first = buildKnowledgeBase(makeRichContext());
    const second = buildKnowledgeBase(makeRichContext());

    // `generatedAt` is the one intentionally non-deterministic field.
    expect(second.docs).toEqual(first.docs);
  });
});
