import picomatch from 'picomatch';
import { LIMITS } from '@humanize/domain';
import type { InventoryEntry } from '@humanize/domain';
import { safePath } from '@humanize/shared';
import type { TreeEntry } from './git.js';
export { GitRepository } from './git.js';
export type { TreeEntry, ChangedFile } from './git.js';
export { Workspace, withWorkspace, sweepWorkspaces } from './workspace.js';

export interface ScanConfig {include?:string[];exclude?:string[];maxFileBytes?:number;}
export function classify(entry:TreeEntry,bytes:Buffer|undefined,config:ScanConfig={}):InventoryEntry {
  const base={path:entry.path,blobSha:entry.sha,mode:entry.mode,size:entry.size};
  const result=(classification:InventoryEntry['classification']):InventoryEntry=>({...base,classification});
  if(!safePath(entry.path)||entry.mode==='120000'||entry.type==='commit')return result('NON_CONTENT_SOURCE');
  // Unknown until the blob is read; reading it enforces the same cap for that one file.
  if(entry.size!==undefined&&entry.size>(config.maxFileBytes??LIMITS.fileBytes))return result('TOO_LARGE');
  if(config.exclude?.some(pattern=>picomatch(pattern,{dot:true})(entry.path)))return result('IGNORED_BY_CONFIG');
  if(config.include?.length&&!config.include.some(pattern=>picomatch(pattern,{dot:true})(entry.path)))return result('IGNORED_BY_CONFIG');
  if(/(^|\/)(node_modules|vendor)\//.test(entry.path))return result('DEPENDENCY');
  if(/(^|\/)(dist|build|coverage|\.next|\.cache)\/|(?:\.min\.[cm]?js|\.map|(?:pnpm-lock|yarn|package-lock)\.(?:yaml|lock|json))$/.test(entry.path))return result('GENERATED');
  if(bytes?.includes(0)||/\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|woff2?|mp4|wasm)$/i.test(entry.path))return result('BINARY');
  if(bytes&&/@generated|do not edit.*generated|generated file/i.test(bytes.subarray(0,2048).toString()))return result('GENERATED');
  if(/\.(tsx?|jsx?|[cm]?[jt]s|html?|mdx?|vue|svelte|css)$/i.test(entry.path))return result('SUPPORTED_CONTENT');
  if(/\.(json|ya?ml)$/i.test(entry.path))return result(/(^|\/)(locales?|i18n|translations|messages)(\/|\.)/.test(entry.path)?'SUPPORTED_CONTENT':'POSSIBLE_CONTENT');
  if(/\.(lock|sql|sh|py|go|rs|java|c|cpp|h)$/i.test(entry.path))return result('NON_CONTENT_SOURCE');
  return result('UNKNOWN');
}
