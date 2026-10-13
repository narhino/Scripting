import { z } from 'zod';
import { STATUSES } from './store.js';

const httpUrl = z.url({ protocol: /^https?$/, error: 'Must be an http(s) URL' });
const optionalUrl = z.union([z.literal(''), httpUrl]);
const label = z.string().trim().min(1).max(60);

export const packagingShape = {
  titles: z.array(z.string().trim().min(1).max(200)).max(20).optional()
    .describe('Title options for the video (best first)'),
  chosen_title: z.string().trim().max(200).optional()
    .describe('The title to use; defaults to the first option'),
  thumbnail_text: z.string().max(200).optional()
    .describe('Short text overlay for the thumbnail'),
  thumbnail_concept: z.string().max(5000).optional()
    .describe('Description of the thumbnail idea / composition'),
  thumbnail_urls: z.array(httpUrl).max(20).optional()
    .describe('Links to thumbnail images or mockups'),
  description: z.string().max(10000).optional()
    .describe('Video description'),
  video_tags: z.array(z.string().trim().min(1).max(100)).max(100).optional()
    .describe('Video tags / keywords'),
};
export const packagingInput = z.object(packagingShape);

export const scriptShape = {
  title: z.string().trim().min(1).max(300).describe('Working title of the script'),
  body: z.string().trim().min(1).max(500_000).describe('The full script text (narration)'),
  channel: z.string().trim().max(100).optional().describe('Channel or project this script is for'),
  source: z.string().trim().max(200).optional().describe('Name of the agent/conversation that wrote it'),
  source_url: optionalUrl.optional().describe('Link back to the conversation that produced it'),
  notes: z.string().max(20_000).optional().describe('Anything the editor should know (sources, tone, b-roll ideas)'),
  tags: z.array(label).max(30).optional().describe('Internal labels, e.g. "series:wars" or "batch-3"'),
  external_id: z.string().trim().min(1).max(200).optional()
    .describe('Your own stable id; re-uploading with the same id revises the script instead of duplicating it'),
  packaging: packagingInput.optional().describe('Titles, thumbnail and description for the video'),
};
export const scriptInput = z.object(scriptShape);

export const scriptPatch = z.object({
  title: scriptShape.title.optional(),
  body: scriptShape.body.optional(),
  channel: z.string().trim().max(100).optional(),
  source: z.string().trim().max(200).optional(),
  source_url: optionalUrl.optional(),
  notes: z.string().max(20_000).optional(),
  tags: z.array(label).max(30).optional(),
  video_url: optionalUrl.optional(),
});

export const statusInput = z.object({
  status: z.enum(STATUSES),
  video_url: optionalUrl.optional(),
});

export const listQuery = z.object({
  view: z.enum(['todo', 'archive', 'all']).default('todo'),
  status: z.enum(STATUSES).optional(),
  channel: z.string().max(100).optional(),
  q: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
  offset: z.coerce.number().int().min(0).default(0),
});
