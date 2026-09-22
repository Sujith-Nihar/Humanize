import { randomBytes } from 'node:crypto';
import { BROWSER_TEXT_SCHEMA_VERSION,BrowserTextSchema,CandidateSchema,ReviewerResponseSchema,VerificationSchema,candidateDigest,z } from '@humanize/domain';
import type { BrowserText,CandidateFinding,EvidenceRecord,ModelProvider } from '@humanize/domain';
import { DEFAULT_CONFIDENCE,REVIEWER_SYSTEM,VERIFIER_SYSTEM,applyVerification,reviewerInput,validateCandidate,verifierInput } from '@humanize/review';
import type { CategoryName,ReviewableUnit } from '@humanize/review';
import type { FastifyInstance } from 'fastify';

/**
 * Reviewer/verifier ports for the browser surface. Deliberately the same shape as the model
 * side of `@humanize/review`'s `ReviewPorts` (no `context`/`rules`, which are repository-only
 * concerns this surface never has): one review behavior, reused, not duplicated.
 */
export interface ExtensionReviewPorts { reviewer:ModelProvider; reviewerModel:string; verifier:ModelProvider; verifierModel:string; }

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

export function registerExtensionRoutes(app:FastifyInstance,ports:ExtensionReviewPorts):void {
  app.post('/extension/reviews',{bodyLimit:BODY_LIMIT},async(request,reply)=>{
    const body=request.body??{};
    // Rejected before the full schema runs, the same way the runner routes refuse an
    // incompatible protocol version before touching anything else.
    if(unsupportedSchemaVersion(body))return reply.code(409).send({error:'SCHEMA_VERSION_UNSUPPORTED'});
    const parsed=BrowserTextSchema.safeParse(body);
    if(!parsed.success){
      const code=classifyRequestError(parsed.error);
      return reply.code(code==='TEXT_TOO_LARGE'?413:400).send({error:code});
    }
    const browserText:BrowserText=parsed.data;
    // The only place BrowserText is materialized; nothing downstream ever sees a fabricated
    // repositoryId, commitSha, blobSha or file path, because none of those fields exist here.
    const unit:ReviewableUnit={id:browserText.requestId,text:browserText.text,placeholders:[]};
    const marker=`hz-${randomBytes(12).toString('hex')}`;
    const noEvidence=new Map<string,EvidenceRecord>();

    let reviewed:{data:z.infer<typeof ReviewerResponseSchema>};
    try{
      reviewed=await ports.reviewer.generateStructured({
        model:ports.reviewerModel,system:REVIEWER_SYSTEM,
        input:reviewerInput({unit,categories:BROWSER_CATEGORIES,evidence:[],ruleNotes:[],marker}),
        schema:ReviewerResponseSchema,timeoutMs:MODEL_TIMEOUT_MS,traceContext:{traceId:browserText.requestId},
      });
    }catch{return reply.code(503).send({error:'PROVIDER_UNAVAILABLE'});}

    try{
      const accepted:CandidateFinding[]=[];
      for(const raw of reviewed.data.candidates){
        const candidate=CandidateSchema.parse(raw);
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
  });
}
