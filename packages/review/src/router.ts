import type { Category,ContentNode,z } from '@humanize/domain';

export type CategoryName=z.infer<typeof Category>;
export interface RoutingDecision {
  categories:CategoryName[];
  /** Below this, a node is indexed for context but never sent for review. */
  eligible:boolean;
  reason:'routed'|'below_visibility_threshold'|'dynamic_unresolved'|'no_enabled_category'|'too_short';
  words:number;
}
export interface RoutingOptions {
  enabled:Readonly<Record<CategoryName,boolean>>;
  visibilityThreshold?:number;
}

// Long-form categories are wasted on a two-word label and produce noise.
const LONG_FORM:CategoryName[]=['ai_like_generic','repetition','claim_inconsistency','unsupported_claim'];
const ALWAYS:CategoryName[]=['clarity','terminology'];

function byKind(node:ContentNode,words:number):CategoryName[] {
  switch(node.kind){
    // Accessibility text is read aloud; correctness and clarity matter, prose style does not.
    case 'accessibility':
    case 'css_generated':
      return ['clarity','terminology'];
    case 'button':
    case 'label':
    case 'placeholder':
    case 'tooltip':
      return ['clarity','terminology','approved_voice'];
    case 'error':
    case 'notification':
      return ['clarity','terminology','approved_voice','repository_style'];
    case 'marketing':
      return ['ai_like_generic','clarity','approved_voice','repository_style','terminology','repetition','unsupported_claim','claim_inconsistency'];
    case 'documentation':
      return ['clarity','terminology','repository_style','claim_inconsistency','unsupported_claim',...(words>=25?['ai_like_generic' as const,'repetition' as const]:[])];
    case 'heading':
      return ['clarity','terminology','approved_voice','repository_style',...(words>=8?['ai_like_generic' as const]:[])];
    case 'metadata':
      return ['clarity','terminology','approved_voice'];
    default:
      return words>=25
        ? ['ai_like_generic','clarity','repository_style','terminology','repetition']
        : ['clarity','terminology','repository_style'];
  }
}

/**
 * Deterministic routing from node metadata alone. Applying every reviewer to every string
 * would cost more and comment more without reviewing better, so each node receives only the
 * categories its kind and length can support. Nothing here calls a model.
 */
export function routeNode(node:ContentNode,options:RoutingOptions):RoutingDecision {
  const threshold=options.visibilityThreshold??0.8;
  const words=node.text.split(/\s+/u).filter(Boolean).length;
  const empty={categories:[],words};
  if(node.visibilityConfidence<threshold)return {...empty,eligible:false,reason:'below_visibility_threshold'};
  if(node.dynamic)return {...empty,eligible:false,reason:'dynamic_unresolved'};
  if(!node.text.trim())return {...empty,eligible:false,reason:'too_short'};

  const selected=byKind(node,words).filter(category=>options.enabled[category]);
  const categories=[...new Set(words<3?selected.filter(category=>!LONG_FORM.includes(category)||ALWAYS.includes(category)):selected)].sort();
  return categories.length
    ? {categories,eligible:true,reason:'routed',words}
    : {...empty,eligible:false,reason:'no_enabled_category'};
}
