/**
 * Source resolution and b-roll insertion into clip ordering.
 *
 * Resolves edit sources (generated clips or final.mp4) from the project's output
 * directory, validates artifact existence and count constraints, and merges
 * b-roll clips into the final orden_clips at their specified indexes.
 *
 * Requirements: 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 3.6, 4.1, 4.3, 4.4, 4.5
 */

import fs from "node:fs";
import path from "node:path";
import { getMaxClipsPerJob } from "./config";
import { validateOrdering } from "./statusMap";
import { projectDir, clipsDir } from "../storage";
import { projectsDb, jobsDb } from "../db";
import type { EditSource, ClipOrderEntry } from "./types";
import type { BrollBank } from "./brollBank";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A resolved input: an absolute path to an existing file on disk.
 */
export interface ResolvedInput {
  /** Unique identifier for this input (clip id or broll id). */
  id: string;
  /** Absolute path to the file on disk. */
  absPath: string;
  /** Whether this is a b-roll clip. */
  isBroll: boolean;
}

/**
 * Result of source resolution (before b-roll merge).
 */
export interface SourceResolutionResult {
  inputs?: ResolvedInput[];
  error?: string;
}

/**
 * Result of the combined ordering (generated + b-roll merged).
 */
export interface OrderedInputsResult {
  /** The final list of inputs ordered by the user-specified ordering. */
  ordenClips?: ResolvedInput[];
  error?: string;
}

// ---------------------------------------------------------------------------
// Source resolution (sub-task 7.1)
// ---------------------------------------------------------------------------

/**
 * Resolve source artifacts from a project.
 *
 * - For "clips" source: resolves each clipId to a video file in the project's
 *   output directory by looking up the corresponding JobRecord.
 * - For "final" source: resolves the single final.mp4 artifact.
 *
 * Validates:
 * - Each artifact exists on disk (returns error identifying missing artifact).
 * - Count is between 1 and MAX_CLIPS_PER_JOB (returns error reporting range).
 *
 * @param projectId  The project to resolve from.
 * @param source     The EditSource selection.
 */
export function resolveSource(
  projectId: string,
  source: EditSource
): SourceResolutionResult {
  const maxClips = getMaxClipsPerJob();

  if (source.type === "final") {
    // Single final.mp4
    const finalPath = path.join(projectDir(projectId), source.artifactKey);
    if (!fs.existsSync(finalPath)) {
      return {
        error: `Missing artifact: "${source.artifactKey}" does not exist for project ${projectId}.`,
      };
    }
    return {
      inputs: [
        {
          id: source.artifactKey,
          absPath: finalPath,
          isBroll: false,
        },
      ],
    };
  }

  // source.type === "clips"
  const clipIds = source.clipIds;

  // Validate count
  if (clipIds.length < 1 || clipIds.length > maxClips) {
    return {
      error: `Number of input clips must be between 1 and ${maxClips}. Got ${clipIds.length}.`,
    };
  }

  // Resolve each clip by looking at the project's jobs
  const jobs = jobsDb.byProject(projectId);
  const jobByRef = new Map(jobs.filter((j) => j.type === "video").map((j) => [j.refId, j]));

  const resolved: ResolvedInput[] = [];
  for (const clipId of clipIds) {
    const job = jobByRef.get(clipId);
    if (!job || !job.outputPath) {
      // Try to find the file directly in the clips dir by clipId
      const clipsDirPath = clipsDir(projectId);
      let found = false;
      if (fs.existsSync(clipsDirPath)) {
        const files = fs.readdirSync(clipsDirPath);
        for (const f of files) {
          if (f.includes(clipId) || f === clipId) {
            const fullPath = path.join(clipsDirPath, f);
            resolved.push({ id: clipId, absPath: fullPath, isBroll: false });
            found = true;
            break;
          }
        }
      }
      if (!found) {
        return {
          error: `Missing artifact: clip "${clipId}" does not exist for project ${projectId}.`,
        };
      }
    } else {
      // Job has an outputPath (relative to project dir)
      const absPath = path.join(projectDir(projectId), job.outputPath);
      if (!fs.existsSync(absPath)) {
        return {
          error: `Missing artifact: clip "${clipId}" output file not found at "${job.outputPath}".`,
        };
      }
      resolved.push({ id: clipId, absPath, isBroll: false });
    }
  }

  return { inputs: resolved };
}

/**
 * Resolves the default source for a project: all generated clips with done status.
 * (Requirement 1.3: default source is the set of generated clips, not final.mp4)
 *
 * @param projectId  The project to resolve from.
 */
export function resolveDefaultSource(projectId: string): SourceResolutionResult {
  const jobs = jobsDb.byProject(projectId);
  const videoJobs = jobs.filter(
    (j) => j.type === "video" && j.status === "done" && j.outputPath
  );

  if (videoJobs.length === 0) {
    return { error: "No generated clips available for this project." };
  }

  const maxClips = getMaxClipsPerJob();
  if (videoJobs.length > maxClips) {
    return {
      error: `Number of input clips must be between 1 and ${maxClips}. Got ${videoJobs.length}.`,
    };
  }

  const resolved: ResolvedInput[] = [];
  for (const job of videoJobs) {
    const absPath = path.join(projectDir(projectId), job.outputPath!);
    if (!fs.existsSync(absPath)) {
      return {
        error: `Missing artifact: clip "${job.refId}" output file not found at "${job.outputPath}".`,
      };
    }
    resolved.push({ id: job.refId, absPath, isBroll: false });
  }

  return { inputs: resolved };
}

// ---------------------------------------------------------------------------
// Combined generated + b-roll ordering (sub-task 7.2)
// ---------------------------------------------------------------------------

/**
 * Merge b-roll clips into the generated clip ordering.
 *
 * Takes the resolved generated inputs and a user-specified ordering that may
 * include b-roll clips at specific zero-based indexes. Validates the combined
 * ordering using validateOrdering, then resolves b-roll paths from the BrollBank.
 *
 * Validation rules (HTTP 400 on violation):
 * - Combined count must be between 1 and MAX_CLIPS_PER_JOB.
 * - All indexes must be within range [0, count-1].
 * - Indexes must be unique and contiguous (0..n-1).
 * - All b-roll clip IDs must exist in the bank.
 *
 * @param generatedInputs  The already-resolved generated clip inputs.
 * @param ordering         The full user-specified ordering (generated + b-roll).
 * @param brollBank        The BrollBank instance for resolving b-roll paths.
 * @returns Ordered inputs ready to send as orden_clips.
 */
export async function mergeOrdering(
  generatedInputs: ResolvedInput[],
  ordering: ClipOrderEntry[],
  brollBank: BrollBank
): Promise<OrderedInputsResult> {
  const maxClips = getMaxClipsPerJob();

  // Validate combined count
  if (ordering.length < 1 || ordering.length > maxClips) {
    return {
      error: `Combined clip count must be between 1 and ${maxClips}. Got ${ordering.length}.`,
    };
  }

  // Validate ordering semantics (uniqueness, contiguity, index range)
  const validationResult = validateOrdering(ordering);
  if (!validationResult.success) {
    return { error: validationResult.error };
  }

  // Build a map of generated inputs by their clip id for lookup
  const generatedMap = new Map(generatedInputs.map((inp) => [inp.id, inp]));

  // Separate b-roll entries and validate their existence
  const brollEntries = ordering.filter((e) => e.isBroll);
  const brollIds = brollEntries.map((e) => e.clipId);

  // Validate each b-roll clip exists in the bank
  for (const brollId of brollIds) {
    const clipPath = await brollBank.getClipPath(brollId);
    if (!clipPath) {
      return {
        error: `B-roll clip not found: "${brollId}" does not exist in the b-roll bank.`,
      };
    }
  }

  // Also validate that generated clips referenced in the ordering exist
  const genEntries = ordering.filter((e) => !e.isBroll);
  for (const entry of genEntries) {
    if (!generatedMap.has(entry.clipId)) {
      return {
        error: `Generated clip not found: "${entry.clipId}" is not in the resolved inputs.`,
      };
    }
  }

  // Sort by index and build the final ordered list
  const sorted = [...ordering].sort((a, b) => a.index - b.index);
  const ordenClips: ResolvedInput[] = [];

  for (const entry of sorted) {
    if (entry.isBroll) {
      const clipPath = await brollBank.getClipPath(entry.clipId);
      ordenClips.push({
        id: entry.clipId,
        absPath: clipPath!,
        isBroll: true,
      });
    } else {
      const gen = generatedMap.get(entry.clipId)!;
      ordenClips.push(gen);
    }
  }

  return { ordenClips };
}

/**
 * Build the default ordering from generated inputs (no b-roll, natural order).
 * Each clip gets an index equal to its position in the array.
 *
 * @param generatedInputs  Already-resolved generated clip inputs.
 * @returns A ClipOrderEntry[] with sequential indexes.
 */
export function buildDefaultOrdering(
  generatedInputs: ResolvedInput[]
): ClipOrderEntry[] {
  return generatedInputs.map((inp, i) => ({
    index: i,
    clipId: inp.id,
    isBroll: false,
  }));
}
