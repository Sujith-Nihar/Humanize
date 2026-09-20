import type { DiffMap, FileDiff } from '@humanize/domain';
import { parseFileDiff } from './index.js';
import type { GitHubTransport } from './transport.js';

/** GitHub returns at most 3000 files for a pull request, 100 at a time. */
const PER_PAGE = 100;
const MAX_PAGES = 30;

interface PullRequestFile { filename: string; previous_filename?: string; status: string; patch?: string }

/**
 * Builds the diff geometry the control plane uses to place inline comments.
 *
 * The runner computes its own diff locally, but the control plane must never take comment
 * coordinates from the runner: a compromised one could move a finding onto a line the author
 * never wrote. This reads the same geometry from GitHub, which is also the authority on what
 * is representable as a comment.
 *
 * A file GitHub reports without a patch — binary, or too large to diff — contributes no
 * commentable lines rather than being guessed at.
 */
export async function fetchDiffMap(
  transport: GitHubTransport,
  target: { owner: string; repo: string; pullNumber: number; repositoryId: string; baseSha: string; headSha: string; mergeBaseSha?: string },
): Promise<DiffMap> {
  const files: FileDiff[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const { data } = await transport.request<PullRequestFile[]>('GET /repos/{owner}/{repo}/pulls/{pull_number}/files', {
      owner: target.owner, repo: target.repo, pull_number: target.pullNumber, per_page: PER_PAGE, page,
    });
    for (const file of data) {
      const newPath = file.status === 'removed' ? null : file.filename;
      const oldPath = file.status === 'added' ? null : file.previous_filename ?? file.filename;
      if (file.patch === undefined) { files.push({ oldPath, newPath, addedLines: [], deletedLines: [], hunks: [] }); continue; }
      try { files.push(parseFileDiff(oldPath, newPath, file.patch)); }
      // An unparseable patch yields no commentable lines; it must not abort the publication.
      catch { files.push({ oldPath, newPath, addedLines: [], deletedLines: [], hunks: [] }); }
    }
    if (data.length < PER_PAGE) break;
  }
  return {
    repositoryId: target.repositoryId, baseSha: target.baseSha, headSha: target.headSha,
    mergeBaseSha: target.mergeBaseSha ?? target.baseSha, files,
  };
}
