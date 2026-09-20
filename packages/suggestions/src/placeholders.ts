import { placeholders } from '@humanize/extractors';

export type PlaceholderViolation='PLACEHOLDER_REMOVED'|'PLACEHOLDER_ADDED'|'PLACEHOLDER_ALTERED'|'PLACEHOLDER_COUNT_CHANGED'|'PLACEHOLDER_REORDERED';

const multiset=(values:readonly string[]):Map<string,number>=>{
  const counts=new Map<string,number>();
  for(const value of values)counts.set(value,(counts.get(value)??0)+1);
  return counts;
};

/**
 * Compares the placeholders before and after a replacement. A placeholder is a contract with
 * the code that renders the string: dropping `{name}` leaves a message with a hole in it, and
 * adding one leaves a literal brace the user reads. Order matters too, because positional
 * formats such as `%s` bind by position rather than by name, so reordering silently swaps the
 * values a user is shown.
 */
export function validatePlaceholders(original:string,replacement:string):PlaceholderViolation[] {
  const before=placeholders(original),after=placeholders(replacement);
  const violations:PlaceholderViolation[]=[];
  const beforeCounts=multiset(before),afterCounts=multiset(after);

  for(const [value,count] of beforeCounts){
    const present=afterCounts.get(value)??0;
    if(present===0)violations.push('PLACEHOLDER_REMOVED');
    else if(present!==count)violations.push('PLACEHOLDER_COUNT_CHANGED');
  }
  for(const value of afterCounts.keys()){
    if(!beforeCounts.has(value))violations.push(before.length?'PLACEHOLDER_ALTERED':'PLACEHOLDER_ADDED');
  }

  const positional=before.filter(value=>value.startsWith('%'));
  if(!violations.length&&positional.length>1&&before.join('')!==after.join('')){
    violations.push('PLACEHOLDER_REORDERED');
  }
  return [...new Set(violations)].sort();
}
