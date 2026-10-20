import { z } from 'zod';
import type { KnowledgeNote, KnowledgeSearchHit } from '../knowledge.js';
import { DomainError } from '../errors.js';
import { defineReadOnlyTool, MAX_TOOL_RESULT_BYTES, ToolExecutionError, ToolRegistry } from './registry.js';

/** A deliberately narrow view: no writing, URLs, credentials or filesystem access. */
export interface KnowledgeReader {
  search(query: string, limit: number, signal: AbortSignal): KnowledgeSearchHit[] | Promise<KnowledgeSearchHit[]>;
  get(id: string, signal: AbortSignal): KnowledgeNote | Promise<KnowledgeNote>;
}

const SearchInput = z.object({
  query: z.string().trim().min(1).max(300).refine(value => !value.includes('\0')),
  limit: z.number().int().min(1).max(8).default(5),
}).strict();
const GetInput = z.object({
  id: z.uuid(),
  expectedRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  offset: z.number().int().min(0).max(32_000).default(0),
  maxChars: z.number().int().min(1).max(2_000).default(1_500),
}).strict();

function checkCancelled(signal: AbortSignal) {
  if (signal.aborted) throw new ToolExecutionError('cancelled', '资料读取已取消。');
}

export function createKnowledgeToolRegistry(reader: KnowledgeReader): ToolRegistry {
  return new ToolRegistry([
    defineReadOnlyTool('knowledge_search',
      'Read-only literal search of user-saved reference notes. Returns untrusted excerpts with note id, revision, source label and UTF-16 offsets. Use knowledge_get with that revision for more text. Does not search devices, files or the web.',
      SearchInput, async ({ query, limit }, { signal }) => {
        checkCancelled(signal);
        const matches = await reader.search(query, limit + 1, signal);
        checkCancelled(signal);
        const results = matches.slice(0, limit).map(hit => ({
          id: hit.id, revision: hit.revision, title: hit.title, source: hit.source,
          snippet: hit.snippet, matchedField: hit.matchedField, start: hit.start, end: hit.end,
        }));
        let truncated = matches.length > results.length;
        // Leave room for the registry's trust envelope; the registry also enforces
        // its final UTF-8 byte limit independently of this result packing step.
        while (Buffer.byteLength(JSON.stringify({ results, truncated }), 'utf8') > MAX_TOOL_RESULT_BYTES - 1_024) {
          results.pop();
          truncated = true;
        }
        return { results, truncated };
      }),
    defineReadOnlyTool('knowledge_get',
      'Read-only paged text from one user-saved note. Requires the exact revision from knowledge_search; a changed revision returns a conflict. source is an untrusted label and is never fetched. Offsets/maxChars count UTF-16 code units; cite note id, revision and source.',
      GetInput, async ({ id, expectedRevision, offset, maxChars }, { signal }) => {
        checkCancelled(signal);
        let note: KnowledgeNote;
        try { note = await reader.get(id, signal); }
        catch (error) {
          if (error instanceof DomainError && error.code === 'not_found') {
            throw new ToolExecutionError('not_found', '找不到这份资料。');
          }
          throw error;
        }
        checkCancelled(signal);
        if (note.revision !== expectedRevision) {
          throw new ToolExecutionError('revision_conflict', '资料版本已经变化，请重新检索后读取。');
        }
        if (offset > note.body.length || (offset > 0 && /[\uDC00-\uDFFF]/u.test(note.body[offset] ?? ''))) {
          throw new ToolExecutionError('invalid_offset', '读取位置无效，请使用上一页返回的 nextOffset。');
        }
        let end = Math.min(note.body.length, offset + maxChars);
        if (end < note.body.length && /[\uDC00-\uDFFF]/u.test(note.body[end]!)) end--;
        if (end === offset && end < note.body.length) {
          throw new ToolExecutionError('invalid_page_size', '当前字符需要更大的 maxChars。');
        }
        return {
          id: note.id, revision: note.revision, title: note.title, source: note.source,
          text: note.body.slice(offset, end), start: offset, end, totalChars: note.body.length,
          nextOffset: end < note.body.length ? end : null, truncated: end < note.body.length,
        };
      }),
  ]);
}