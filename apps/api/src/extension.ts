import { randomBytes } from 'node:crypto';
import { BROWSER_TEXT_SCHEMA_VERSION,BrowserTextSchema,CandidateSchema,VerificationSchema,candidateDigest,z } from '@humanize/domain';
import type { BrowserText,CandidateFinding,EvidenceRecord,ModelProvider } from '@humanize/domain';
import { DEFAULT_CONFIDENCE,REVIEWER_SYSTEM,VERIFIER_SYSTEM,applyVerification,reviewerInput,validateCandidate,verifierInput } from '@humanize/review';
import type { CategoryName,ReviewableUnit } from '@humanize/review';
import type { FastifyInstance,FastifyReply,FastifyRequest } from 'fastify';

/**
 * An authenticated caller of the browser surface. Deliberately not a runner, a GitHub
 * installation or a dashboard session — a distinct actor namespace with its own credential.
 */
export interface ExtensionActor { actorId:string; }

/**
 * Resolves a bearer credential to an actor, or refuses it. Deliberately a port: credential
 * issuance for this surface is unresolved (ADR-040), so no concrete implementation lives here.
 * A concrete implementation should compare credentials the way `SessionSigner`/`RunnerStore`
 * already do elsewhere in this codebase — hashed at rest, compared in constant time
 * (`constantEqual` in `@humanize/security`) — but that is this port's responsibility, not the
 * route's.
 */
export interface ExtensionAuthenticator { authenticate(credential:string|null):Promise<ExtensionActor|null>; }

/**
 * Per-actor abuse control, checked after authentication so the key is always an authenticated
 * identity, never anything drawn from the request body. A concrete implementation may be a
 * simple in-memory token bucket today and a shared store later; this route only needs the
 * allow/deny answer.
 */
export interface ExtensionRateLimiter { check(actorId:string):Promise<boolean>; }

/**
 * Reviewer/verifier ports for the browser surface. Deliberately the same shape as the model
 * side of `@humanize/review`'s `ReviewPorts` (no `context`/`rules`, which are repository-only
 * concerns this surface never has): one review behavior, reused, not duplicated. Authentication
 * and rate limiting are required, not optional, so a caller cannot wire this route without both.
 */
export interface ExtensionReviewPorts {
  reviewer:ModelProvider; reviewerModel:string; verifier:ModelProvider; verifierModel:string;
  authenticator:ExtensionAuthenticator; rateLimiter:ExtensionRateLimiter;
}

export interface BrowserFinding {
  category:CandidateFinding['category']; severity:CandidateFinding['severity'];
  exactText:string; range:{start:number;end:number}; explanation:string; confidence:number;
}
export interface BrowserReviewResponse { requestId:string; schemaVersion:string; findings:BrowserFinding[]; }

// A request body this large is hostile or a mistake; text itself is bounded far below this by
// BrowserTextSchema, so this is a transport-level backstop, not the size limit that matters.
const BODY_LIMIT=32*1024;
// Two sequential model calls must fit inside the app's global request timeout (apps/api/src/app.ts).
// This is a known, unresolved operational tension against a slow local model, not solved here.
const MODEL_TIMEOUT_MS=20000;

// repository_style and approved_voice compare submitted content against a repository's own
// established baseline, which does not exist for browser-selected text. Fixed and narrow rather
// than configurable, because there is no per-caller configuration surface for this route yet.
const BROWSER_CATEGORIES:readonly CategoryName[]=['ai_like_generic','clarity','terminology','repetition','claim_inconsistency','unsupported_claim'];
// A single-process, in-memory bound on simultaneous model calls this route will hold open at
// once, independent of which actor made them — a blunt but sufficient backstop against a
// request stream (authenticated or not, once past rate limiting) overwhelming the configured
// model. Not a queue: a request over the limit is refused immediately, never held.
const MAX_CONCURRENT_REVIEWS=4;

/** Reads a bearer credential without judging its validity; the authenticator decides that. */
function bearerCredential(request:FastifyRequest):string|null {
  const header=request.headers.authorization;
  if(typeof header!=='string'||!header.startsWith('Bearer '))return null;
  const token=header.slice(7);
  return token.length>0?token:null;
}

/** True only when the request body names an incompatible version; a missing field is not a mismatch. */
function unsupportedSchemaVersion(value:unknown):boolean {
  const body=(value??{}) as Record<string,unknown>;
  return body.schemaVersion!==undefined&&body.schemaVersion!==BROWSER_TEXT_SCHEMA_VERSION;
}

/** Maps a BrowserTextSchema validation failure to one of the documented browser error codes. */
function classifyRequestError(error:z.ZodError):'TEXT_TOO_LARGE'|'INVALID_CHARACTER_RANGE'|'INVALID_REQUEST' {
  if(error.issues.some(issue=>issue.path[0]==='text'&&issue.code==='too_big'))return 'TEXT_TOO_LARGE';
  if(error.issues.some(issue=>issue.path[0]==='characterRange'))return 'INVALID_CHARACTER_RANGE';
  return 'INVALID_REQUEST';
}

/**
 * Locates a quotation that `validateCandidate` has already proven occurs in `text` at least
 * once. A second occurrence makes the anchor ambiguous, and this never guesses which one the
 * model meant — the finding is dropped instead (mirrors "unverified never publishes").
 */
function locateQuote(text:string,quote:string):{start:number;end:number}|'ambiguous' {
  const start=text.indexOf(quote);
  return text.indexOf(quote,start+1)===-1?{start,end:start+quote.length}:'ambiguous';
}

/**
 * The browser reviewer's own response schema — smaller than the shared `ReviewerResponseSchema`
 * because browser candidates never carry repository evidence, a suggested replacement, or the
 * unused `requiresVerification` flag (none of those are read anywhere in this route once a
 * candidate reaches `validateCandidate`/`applyVerification`). Every field reuses the exact
 * validator `CandidateSchema` already declares — nothing here redefines a domain concept, so
 * this cannot silently drift from the shared schema's length/enum constraints. `searches` is
 * dropped too: this route never reads it today, and neither does the GitHub path yet.
 */
export const BrowserCandidateSchema=z.object({
  nodeId:CandidateSchema.shape.nodeId,
  category:CandidateSchema.shape.category,
  severity:CandidateSchema.shape.severity,
  confidence:CandidateSchema.shape.confidence,
  exactText:CandidateSchema.shape.exactText,
  explanation:CandidateSchema.shape.explanation,
}).strict();
export const BrowserReviewerResponseSchema=z.object({
  candidates:z.array(BrowserCandidateSchema).max(100),
}).strict();
export type BrowserCandidate=z.infer<typeof BrowserCandidateSchema>;

/**
 * Expands a minimal browser candidate into the full `CandidateFinding` shape
 * `validateCandidate`/`applyVerification` (packages/review/src/core.ts, unchanged) expect.
 * `nodeId` is copied exactly as the model returned it — never defaulted or overwritten — because
 * `validateCandidate`'s `foreign_node` check depends on it genuinely matching `unit.id`, not on
 * this function assuming agreement. `evidence` is always `[]` (no repository or rule evidence
 * exists for browser text, and validateCandidate already requires it to be empty here since the
 * evidence map this route supplies is always empty). `replacement` is always `null` and
 * `requiresVerification` is always `false`: this route never asks the model for either, and
 * never reads or invents one — no suggestion is ever generated for a browser finding.
 */
export function toCandidateFinding(candidate:BrowserCandidate):CandidateFinding {
  return {
    nodeId:candidate.nodeId,category:candidate.category,severity:candidate.severity,
    confidence:candidate.confidence,exactText:candidate.exactText,explanation:candidate.explanation,
    evidence:[],replacement:null,requiresVerification:false,
  };
}

export function registerExtensionRoutes(app:FastifyInstance,ports:ExtensionReviewPorts):void {
  let inFlight=0;
  app.post('/extension/reviews',{bodyLimit:BODY_LIMIT},async(request,reply)=>{
    const body=request.body??{};
    // Ordered exactly: schema shape first (cheap, local, no I/O), then authentication, then
    // rate/concurrency, and only then anything that could reach a model. No branch below this
    // point runs before authentication has returned a real actor.
    if(unsupportedSchemaVersion(body))return reply.code(409).send({error:'SCHEMA_VERSION_UNSUPPORTED'});
    const parsed=BrowserTextSchema.safeParse(body);
    if(!parsed.success){
      const code=classifyRequestError(parsed.error);
      return reply.code(code==='TEXT_TOO_LARGE'?413:400).send({error:code});
    }
    const browserText:BrowserText=parsed.data;

    // Authentication. The credential itself is read but never logged, never echoed, and the
    // response never states whether a *particular* credential was recognised — only whether the
    // request may proceed.
    const actor=await ports.authenticator.authenticate(bearerCredential(request));
    if(!actor)return reply.code(401).send({error:'UNAUTHENTICATED'});

    // Rate limiting, keyed only by the authenticated actor — never by anything drawn from the
    // request body, so no submitted text, quote, hostname or URL can ever become a limiter key.
    if(!await ports.rateLimiter.check(actor.actorId))return reply.code(429).send({error:'RATE_LIMITED'});

    // A concurrency gate, not a queue: a request over the bound is refused immediately rather
    // than held, so this never becomes an unbounded backlog.
    if(inFlight>=MAX_CONCURRENT_REVIEWS)return reply.code(429).send({error:'RATE_LIMITED'});
    inFlight++;
    try{
      return await runReview(browserText,ports,reply);
    }finally{
      inFlight--;
    }
  });
}

/**
 * Everything from here on runs only for an authenticated, rate-limit-cleared, concurrency-admitted
 * request. Provider, model, timeout, retry and verification behaviour are fixed constants the
 * caller cannot influence — `BrowserTextSchema` carries no such field, and `.strict()` refuses one.
 */
async function runReview(browserText:BrowserText,ports:ExtensionReviewPorts,reply:FastifyReply) {
    // The only place BrowserText is materialized; nothing downstream ever sees a fabricated
    // repositoryId, commitSha, blobSha or file path, because none of those fields exist here.
    const unit:ReviewableUnit={id:browserText.requestId,text:browserText.text,placeholders:[]};
    const marker=`hz-${randomBytes(12).toString('hex')}`;
    const noEvidence=new Map<string,EvidenceRecord>();

    let reviewed:{data:z.infer<typeof BrowserReviewerResponseSchema>};
    try{
      reviewed=await ports.reviewer.generateStructured({
        model:ports.reviewerModel,system:REVIEWER_SYSTEM,
        input:reviewerInput({unit,categories:BROWSER_CATEGORIES,evidence:[],ruleNotes:[],marker}),
        schema:BrowserReviewerResponseSchema,timeoutMs:MODEL_TIMEOUT_MS,traceContext:{traceId:browserText.requestId},
      });
    }catch{return reply.code(503).send({error:'PROVIDER_UNAVAILABLE'});}

    try{
      const accepted:CandidateFinding[]=[];
      for(const raw of reviewed.data.candidates){
        const candidate=toCandidateFinding(BrowserCandidateSchema.parse(raw));
        if(validateCandidate(candidate,unit,BROWSER_CATEGORIES,noEvidence))continue;
        if(candidate.confidence<DEFAULT_CONFIDENCE||candidate.severity==='nit')continue;
        accepted.push(candidate);
      }
      if(!accepted.length)return reply.code(200).send({requestId:browserText.requestId,schemaVersion:browserText.schemaVersion,findings:[]} satisfies BrowserReviewResponse);

      let verified:{data:z.infer<typeof VerificationSchema>};
      try{
        verified=await ports.verifier.generateStructured({
          model:ports.verifierModel,system:VERIFIER_SYSTEM,
          input:verifierInput({unit,evidence:[],marker,
            candidates:accepted.map(candidate=>({id:candidateDigest(candidate),category:candidate.category,severity:candidate.severity,exactText:candidate.exactText,explanation:candidate.explanation}))}),
          schema:VerificationSchema,timeoutMs:MODEL_TIMEOUT_MS,traceContext:{traceId:browserText.requestId},
        });
      }catch{return reply.code(503).send({error:'PROVIDER_UNAVAILABLE'});}

      const byIdentity=new Map(VerificationSchema.parse(verified.data).results.map(result=>[result.candidateId,result]));
      const findings:BrowserFinding[]=[];
      for(const candidate of accepted){
        const verdict=byIdentity.get(candidateDigest(candidate));
        if(!verdict||!verdict.publish||verdict.confidence<DEFAULT_CONFIDENCE)continue;
        // The model returns a quotation, never a coordinate; the server derives the range from
        // the submitted text it already holds, exactly as GitHub-path coordinates are attached
        // from the node rather than the model (INV-014's principle, applied here).
        const located=locateQuote(browserText.text,candidate.exactText);
        if(located==='ambiguous')continue;
        const applied=applyVerification(candidate,verdict,VERIFIER_SYSTEM);
        findings.push({category:candidate.category,severity:candidate.severity,exactText:candidate.exactText,range:located,explanation:applied.explanation,confidence:verdict.confidence});
      }
      return reply.code(200).send({requestId:browserText.requestId,schemaVersion:browserText.schemaVersion,findings} satisfies BrowserReviewResponse);
    }catch{
      // Something after the model calls themselves failed unexpectedly (never a provider
      // transport issue, which the two catches above already handle) — no internal detail
      // reaches the caller.
      return reply.code(502).send({error:'REVIEW_FAILED'});
    }
}
