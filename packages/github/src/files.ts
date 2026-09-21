import { githubClient } from './client.js';
import type { GitHubTokenBroker } from './client.js';

/**
 * A configuration file is small by nature. This bound is a transport guard, checked before
 * anything is decoded, so a large file is refused rather than pulled into memory; the
 * configuration loader applies its own limit to the text it receives.
 */
export const MAX_TRUSTED_FILE_BYTES = 64 * 1024;

export interface TrustedFileRequest {
  installationId: number;
  githubRepositoryId: number;
  owner: string;
  name: string;
  ref: string;
  path: string;
}

/**
 * Reads one file from GitHub at a named revision, with a token scoped to that single
 * repository and Contents read alone.
 *
 * Callers use this for `.humanize.yml` at the pull request base commit, never the head
 * (ADR-027), so a pull request cannot change the rules it is judged by. A missing file is
 * normal and returns null: that means administrator defaults apply, not that review stops.
 */
export class GitHubFileSource {
  constructor(private readonly broker: GitHubTokenBroker) {}

  async read(request: TrustedFileRequest, maxBytes: number = MAX_TRUSTED_FILE_BYTES): Promise<{ content: string; sha: string } | null> {
    const token = await this.broker.token(request.installationId, request.githubRepositoryId, 'read');
    try {
      const { data } = await githubClient(token).request('GET /repos/{owner}/{repo}/contents/{path}', {
        owner: request.owner, repo: request.name, path: request.path, ref: request.ref,
      });
      // A directory, a symlink or a submodule at this path is not a configuration file.
      if (Array.isArray(data) || data.type !== 'file') return null;
      if (data.size > maxBytes) return null;
      // Content is absent above GitHub's own inline limit; the size guard above precedes it.
      if (typeof data.content !== 'string' || data.encoding !== 'base64') return null;
      return { content: Buffer.from(data.content, 'base64').toString('utf8'), sha: data.sha };
    } catch (error) {
      // No configuration file is the ordinary case, not a failure.
      if ((error as { status?: number }).status === 404) return null;
      throw error;
    }
  }
}
