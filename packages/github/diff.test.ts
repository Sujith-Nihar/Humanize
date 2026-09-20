import { expect,it } from 'vitest';
import { parseFileDiff,representableRange } from './src/index.js';

it('maps RIGHT-side lines and requires an intersecting representable hunk',()=>{
  const diff=parseFileDiff('a.md','a.md','@@ -1,3 +1,4 @@\n same\n-old\n+new\n+another\n last\n');
  expect(diff.addedLines).toEqual([2,3]);expect(diff.deletedLines).toEqual([2]);
  expect(representableRange(diff,2,3)).toBe(true);expect(representableRange(diff,1,1)).toBe(false);expect(representableRange(diff,2,5)).toBe(false);
});
it('rejects truncated geometry',()=>{expect(()=>parseFileDiff(null,'a.md','@@ -0,0 +1,2 @@\n+only one\n')).toThrow();});
