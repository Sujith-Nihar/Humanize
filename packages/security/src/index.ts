import { createCipheriv,createDecipheriv,createHash,createHmac,randomBytes,timingSafeEqual } from 'node:crypto';

export interface EncryptedSecret {version:1;keyVersion:string;iv:string;tag:string;ciphertext:string;}
export class SecretCipher {
  constructor(private readonly keys:ReadonlyMap<string,Buffer>,readonly activeVersion:string) {
    if(!keys.has(activeVersion)||[...keys.values()].some(k=>k.length!==32))throw Error('INVALID_ENCRYPTION_KEYS');
  }
  encrypt(organizationId:string,reference:string,value:string):EncryptedSecret {
    if(!value||value.length>65536)throw Error('INVALID_SECRET');
    const iv=randomBytes(12);const cipher=createCipheriv('aes-256-gcm',this.keys.get(this.activeVersion)!,iv);
    cipher.setAAD(Buffer.from(JSON.stringify([1,organizationId,reference,this.activeVersion])));
    const ciphertext=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);
    return {version:1,keyVersion:this.activeVersion,iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),ciphertext:ciphertext.toString('base64')};
  }
  decrypt(organizationId:string,reference:string,value:EncryptedSecret):string {
    try {
      const key=this.keys.get(value.keyVersion);if(!key||value.version!==1)throw Error();
      const cipher=createDecipheriv('aes-256-gcm',key,Buffer.from(value.iv,'base64'));
      cipher.setAAD(Buffer.from(JSON.stringify([1,organizationId,reference,value.keyVersion])));cipher.setAuthTag(Buffer.from(value.tag,'base64'));
      return Buffer.concat([cipher.update(Buffer.from(value.ciphertext,'base64')),cipher.final()]).toString('utf8');
    }catch{throw Error('SECRET_UNAVAILABLE');}
  }
}
export function opaqueToken():string {return randomBytes(32).toString('base64url');}
export function tokenHash(token:string):string {return createHash('sha256').update(token).digest('hex');}
export function constantEqual(a:string,b:string):boolean {const left=Buffer.from(a),right=Buffer.from(b);return left.length===right.length&&timingSafeEqual(left,right);}
export function requireRepositoryAdmin(enabledIds:readonly string[],adminIds:ReadonlySet<string>,repositoryId?:string):void {
  const required=repositoryId?[repositoryId]:enabledIds;
  if(!required.length||required.some(id=>!enabledIds.includes(id)||!adminIds.has(id)))throw Error('FORBIDDEN');
}

export interface SessionClaims { userId:string; organizationIds:readonly string[]; expiresAt:number; }

/** Sessions are signed, never encrypted: they carry identity, never secrets. */
export class SessionSigner {
  constructor(private readonly key:Buffer,private readonly ttlMs=12*60*60*1000) {
    if(key.length<32)throw Error('WEAK_SESSION_KEY');
  }
  issue(userId:string,organizationIds:readonly string[],now=Date.now()):string {
    const claims:SessionClaims={userId,organizationIds:[...organizationIds],expiresAt:now+this.ttlMs};
    const body=Buffer.from(JSON.stringify(claims),'utf8').toString('base64url');
    return `${body}.${createHmac('sha256',this.key).update(body).digest('base64url')}`;
  }
  /** Returns null for anything not provably issued here and still current. */
  verify(token:string|undefined,now=Date.now()):SessionClaims|null {
    if(!token)return null;
    const separator=token.lastIndexOf('.');
    if(separator<=0)return null;
    const body=token.slice(0,separator),signature=token.slice(separator+1);
    const expected=createHmac('sha256',this.key).update(body).digest('base64url');
    // Constant-time comparison: a signature check that leaks timing is a forgery oracle.
    if(!constantEqual(signature,expected))return null;
    try{
      const claims=JSON.parse(Buffer.from(body,'base64url').toString('utf8')) as SessionClaims;
      if(typeof claims.expiresAt!=='number'||claims.expiresAt<=now)return null;
      if(typeof claims.userId!=='string'||!Array.isArray(claims.organizationIds))return null;
      return {userId:claims.userId,organizationIds:claims.organizationIds,expiresAt:claims.expiresAt};
    }catch{return null;}
  }
}

/** Throws unless the session carries membership of the organization being acted on. */
export function requireOrganization(claims:SessionClaims|null,organizationId:string):SessionClaims {
  if(!claims||!claims.organizationIds.includes(organizationId))throw Error('FORBIDDEN');
  return claims;
}

/**
 * Builds a cipher from deployment secret management. Keys never live in the database
 * (spec 26.3), so they arrive as environment values a deployment injects.
 *
 * `HUMANIZE_ENCRYPTION_KEYS` is `version:base64` pairs separated by commas, and
 * `HUMANIZE_ENCRYPTION_ACTIVE_KEY` names the one to encrypt with. Several may be present at
 * once, which is what makes rotation possible: a new key becomes active for writes while the
 * old one stays available to decrypt what it wrote, and each stored secret records the
 * version that encrypted it.
 *
 * Returns undefined when no keys are configured, so a deployment without them starts and
 * reports which capability is unavailable rather than failing obscurely.
 */
export function cipherFromEnvironment(env:Record<string,string|undefined>=process.env):SecretCipher|undefined {
  const raw=env.HUMANIZE_ENCRYPTION_KEYS?.trim();
  if(!raw)return undefined;
  const keys=new Map<string,Buffer>();
  for(const entry of raw.split(',')){
    const separator=entry.indexOf(':');
    if(separator<1)throw Error('INVALID_ENCRYPTION_KEYS');
    const version=entry.slice(0,separator).trim();
    const key=Buffer.from(entry.slice(separator+1).trim(),'base64');
    // A short key is rejected here rather than silently padded: a 16-byte value reaching
    // aes-256-gcm would fail far from its cause, or worse, encrypt under a weaker secret.
    if(!version||key.length!==32)throw Error('INVALID_ENCRYPTION_KEYS');
    keys.set(version,key);
  }
  const active=env.HUMANIZE_ENCRYPTION_ACTIVE_KEY?.trim()??(keys.size===1?[...keys.keys()][0]:undefined);
  if(!active)throw Error('INVALID_ENCRYPTION_KEYS');
  return new SecretCipher(keys,active);
}
