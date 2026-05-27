/**
 * Journal tools: read and write daily journal entries.
 *
 * AFFiNE journals are regular docs whose page-meta has isJournal=true and
 * a title formatted as a date (YYYY-MM-DD). The AI can read or append to
 * journal entries for any given date.
 */
import { Logger } from '@nestjs/common';
import * as Y from 'yjs';
import { z } from 'zod';

import { DocReader, DocWriter } from '../../../core/doc';
import { PgWorkspaceDocStorageAdapter } from '../../../core/doc/adapters/workspace';
import { AccessController } from '../../../core/permission';
import { Models } from '../../../models';
import { toolError } from './error';
import { defineTool } from './tool';
import type { CopilotChatOptions } from './types';

const logger = new Logger('JournalTools');

/** Parse YYYY-MM-DD or return today's date */
function resolveJournalDate(dateStr?: string): string {
  if (dateStr && /^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return dateStr;
  }
  // Use UTC date in YYYY-MM-DD format
  return new Date().toISOString().substring(0, 10);
}

/** Find a journal doc id by date from root doc pages */
function findJournalDocByDate(
  pages: Array<{
    id: string;
    title?: string;
    isJournal?: boolean;
  }>,
  dateStr: string
): string | null {
  for (const page of pages) {
    if (page.isJournal && page.title === dateStr) {
      return page.id;
    }
  }
  return null;
}

/** Parse root doc pages from binary */
function parseRootDocPages(bin: Buffer | Uint8Array) {
  try {
    const buf = Buffer.isBuffer(bin)
      ? bin
      : Buffer.from(
          bin.buffer,
          (bin as Uint8Array).byteOffset,
          (bin as Uint8Array).byteLength
        );
    const doc = new Y.Doc();
    Y.applyUpdate(doc, buf);
    const meta = doc.getMap('meta');
    const pages = meta.get('pages') as Y.Array<Y.Map<unknown>> | undefined;
    if (!pages) return [];
    const result: Array<{
      id: string;
      title?: string;
      isJournal?: boolean;
      trash?: boolean;
    }> = [];
    pages.forEach((page: Y.Map<unknown>) => {
      result.push({
        id: page.get('id') as string,
        title: page.get('title') as string | undefined,
        isJournal: page.get('isJournal') as boolean | undefined,
        trash: page.get('trash') as boolean | undefined,
      });
    });
    return result;
  } catch {
    return [];
  }
}

// ─── Handlers ────────────────────────────────────────────────────────────────

export const buildJournalReadHandler = (
  ac: AccessController,
  storage: PgWorkspaceDocStorageAdapter,
  docReader: DocReader,
  _models: Models
) => {
  return async (options: CopilotChatOptions, date?: string) => {
    if (!options?.user || !options.workspace) {
      return toolError(
        'Journal Read Failed',
        'Missing user or workspace context'
      );
    }
    const dateStr = resolveJournalDate(date);

    // Find journal doc from root doc pages
    const rootDoc = await storage.getDoc(options.workspace, options.workspace);
    if (!rootDoc?.bin) {
      return toolError('Journal Read Failed', 'Workspace root doc not found');
    }
    const rootBin = Buffer.isBuffer(rootDoc.bin)
      ? rootDoc.bin
      : Buffer.from(
          rootDoc.bin.buffer,
          rootDoc.bin.byteOffset,
          rootDoc.bin.byteLength
        );
    const pages = parseRootDocPages(rootBin);
    const journalDocId = findJournalDocByDate(
      pages.filter(p => !p.trash),
      dateStr
    );

    if (!journalDocId) {
      return {
        date: dateStr,
        exists: false,
        content: null,
        message: `No journal entry found for ${dateStr}`,
      };
    }

    // Check read permission
    const canRead = await ac
      .user(options.user)
      .workspace(options.workspace)
      .doc(journalDocId)
      .can('Doc.Read');
    if (!canRead) {
      return toolError(
        'Journal Read Failed',
        `No permission to read journal for ${dateStr}`
      );
    }

    const content = await docReader.getDocMarkdown(
      options.workspace,
      journalDocId,
      true
    );
    return {
      date: dateStr,
      exists: true,
      docId: journalDocId,
      markdown: content?.markdown ?? '',
      wordCount: content?.markdown?.split(/\s+/).filter(Boolean).length ?? 0,
    };
  };
};

export const buildJournalWriteHandler = (
  ac: AccessController,
  storage: PgWorkspaceDocStorageAdapter,
  docReader: DocReader,
  docWriter: DocWriter,
  _models: Models
) => {
  return async (
    options: CopilotChatOptions,
    date: string | undefined,
    content: string,
    mode: 'append' | 'replace' = 'append'
  ) => {
    if (!options?.user || !options.workspace) {
      return toolError(
        'Journal Write Failed',
        'Missing user or workspace context'
      );
    }
    const dateStr = resolveJournalDate(date);

    // Find or create journal doc
    const rootDoc = await storage.getDoc(options.workspace, options.workspace);
    if (!rootDoc?.bin) {
      return toolError('Journal Write Failed', 'Workspace root doc not found');
    }
    const rootBin = Buffer.isBuffer(rootDoc.bin)
      ? rootDoc.bin
      : Buffer.from(
          rootDoc.bin.buffer,
          rootDoc.bin.byteOffset,
          rootDoc.bin.byteLength
        );
    const pages = parseRootDocPages(rootBin);
    let journalDocId = findJournalDocByDate(
      pages.filter(p => !p.trash),
      dateStr
    );

    if (!journalDocId) {
      // Create new journal entry
      const canCreate = await ac
        .user(options.user)
        .workspace(options.workspace)
        .can('Workspace.CreateDoc');
      if (!canCreate) {
        return toolError(
          'Journal Write Failed',
          'No permission to create journal entry'
        );
      }
      const result = await docWriter.createDoc(
        options.workspace,
        dateStr,
        content,
        options.user
      );
      journalDocId = result.docId;

      // Mark as journal in root doc
      const updatedRoot = await storage.getDoc(
        options.workspace,
        options.workspace
      );
      if (updatedRoot?.bin) {
        const updatedBin = Buffer.isBuffer(updatedRoot.bin)
          ? updatedRoot.bin
          : Buffer.from(
              updatedRoot.bin.buffer,
              updatedRoot.bin.byteOffset,
              updatedRoot.bin.byteLength
            );
        const updatedDoc = new Y.Doc();
        Y.applyUpdate(updatedDoc, updatedBin);
        const meta = updatedDoc.getMap('meta');
        const updatedPages = meta.get('pages') as
          | Y.Array<Y.Map<unknown>>
          | undefined;
        if (updatedPages) {
          updatedPages.forEach((page: Y.Map<unknown>) => {
            if (page.get('id') === journalDocId) {
              page.set('isJournal', true);
            }
          });
          const journalUpdate = Y.encodeStateAsUpdate(updatedDoc);
          await storage.pushDocUpdates(
            options.workspace,
            options.workspace,
            [journalUpdate],
            options.user
          );
        }
      }

      logger.log(`Created journal entry for ${dateStr}: ${journalDocId}`);
      return {
        success: true,
        docId: journalDocId,
        date: dateStr,
        created: true,
        message: `Journal entry for ${dateStr} created`,
      };
    }

    // Update existing journal entry
    const canUpdate = await ac
      .user(options.user)
      .workspace(options.workspace)
      .doc(journalDocId)
      .can('Doc.Update');
    if (!canUpdate) {
      return toolError(
        'Journal Write Failed',
        `No permission to update journal for ${dateStr}`
      );
    }

    if (mode === 'append') {
      const existing = await docReader.getDocMarkdown(
        options.workspace,
        journalDocId,
        true
      );
      const existingContent = existing?.markdown ?? '';
      const appendedContent = existingContent
        ? `${existingContent}\n\n${content}`
        : content;
      await docWriter.updateDoc(
        options.workspace,
        journalDocId,
        appendedContent,
        options.user
      );
    } else {
      await docWriter.updateDoc(
        options.workspace,
        journalDocId,
        content,
        options.user
      );
    }

    logger.log(`Updated journal entry for ${dateStr}: ${journalDocId}`);
    return {
      success: true,
      docId: journalDocId,
      date: dateStr,
      created: false,
      message: `Journal entry for ${dateStr} ${mode === 'append' ? 'appended to' : 'updated'}`,
    };
  };
};

// ─── Tool Factories ───────────────────────────────────────────────────────────

export const createJournalReadTool = (
  readJournal: (date?: string) => Promise<object>
) =>
  defineTool({
    description:
      'Read a daily journal entry for a specific date (or today if no date given). AFFiNE journals are date-based documents that serve as daily notes. Use this when the user asks to read, check, or see their journal for a specific day.',
    inputSchema: z.object({
      date: z
        .string()
        .optional()
        .describe(
          'The date to read the journal for, in YYYY-MM-DD format. Defaults to today.'
        ),
    }),
    execute: async ({ date }) => {
      try {
        return await readJournal(date);
      } catch (err: any) {
        logger.error(`Failed to read journal for ${date}`, err);
        return toolError('Journal Read Failed', err.message);
      }
    },
  });

export const createJournalWriteTool = (
  writeJournal: (
    date: string | undefined,
    content: string,
    mode: 'append' | 'replace'
  ) => Promise<object>
) =>
  defineTool({
    description:
      'Write to a daily journal entry. Can append to existing content or replace it entirely. If no journal exists for the date, one is created automatically. Use this when the user asks to write, add, or update their journal/daily notes.',
    inputSchema: z.object({
      date: z
        .string()
        .optional()
        .describe(
          'The date to write the journal entry for, in YYYY-MM-DD format. Defaults to today.'
        ),
      content: z
        .string()
        .min(1)
        .describe('The markdown content to write to the journal'),
      mode: z
        .enum(['append', 'replace'])
        .optional()
        .describe(
          '"append" adds to existing content (default), "replace" overwrites it entirely'
        ),
    }),
    execute: async ({ date, content, mode }) => {
      try {
        return await writeJournal(date, content, mode ?? 'append');
      } catch (err: any) {
        logger.error(`Failed to write journal for ${date}`, err);
        return toolError('Journal Write Failed', err.message);
      }
    },
  });
