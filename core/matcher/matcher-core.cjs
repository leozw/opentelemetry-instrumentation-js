'use strict';
// Bounded matcher core, shared by the separately reviewed major lines.
let backend, parser;
const getBackend = () => backend || (backend = require('re2js'));
const getParser = () => parser || (parser = new (require('@eslint-community/regexpp').RegExpParser)());
const nativeTest = RegExp.prototype.test;

const LIMITS = Object.freeze({
  rulesPerRole: 32, sourceUnits: 256, astNodes: 256, depth: 16, captures: 16,
  expandedPerRule: 1024, expandedTotal: 4096, normalizedPerRule: 8192,
  normalizedTotal: 32768, instructionsPerRule: 4096, instructionsTotal: 32768,
  dfaBytesPerRule: 65536, dfaBytesTotal: 4_587_520,
  inputPerRule: 65536, inputPerRecord: 65536, valuesPerRecord: 2048,
  workPerRecord: 33_554_432, ruleCallsPerRecord: 65536,
  replacementsPerValue: 128, replacementUnits: 1024, outputUnits: 65536,
});
const CODES = Object.freeze({
  syntax: 'ELVEN_MATCHER_UNSUPPORTED_PATTERN', budget: 'ELVEN_MATCHER_COMPILE_BUDGET',
  input: 'ELVEN_MATCHER_UNSUPPORTED_INPUT', work: 'ELVEN_MATCHER_RECORD_BUDGET',
  replace: 'ELVEN_MATCHER_UNSUPPORTED_REPLACER', output: 'ELVEN_MATCHER_OUTPUT_BUDGET',
  engine: 'ELVEN_MATCHER_BACKEND_FAILURE', closed: 'ELVEN_MATCHER_CLOSED',
});
const REDACTED = '[REDACTED]';
const BUILTINS = Object.freeze([
  /\b[A-Za-z0-9._%+-]{1,256}@[A-Za-z0-9.-]{1,256}\.[A-Za-z]{2,63}\b/,
  /\b(?:\d{4}[-\s]?){3}\d{4}\b/, /\b\d{3}-\d{2}-\d{4}\b/,
  /\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/,
  /Bearer\s+[A-Za-z0-9\-._~+\/=]*/i, /Basic\s+[A-Za-z0-9+\/=]*/i,
]);
const SPACE = [[9,13],[32,32],[160,160],[5760,5760],[8192,8202],[8232,8233],[8239,8239],[8287,8287],[12288,12288],[65279,65279]];
const WORD = [[48,57],[65,90],[95,95],[97,122]];
const DIGIT = [[48,57]];
const LINES = [[10,10],[13,13],[8232,8233]];
const DEFAULTS = Object.freeze([/password/i,/token/i,/secret/i,/api[_-]?key/i,/authorization/i,/credit[_-]?card/i,/ssn/i,/cpf/i]);
const CERTIFIED = [...DEFAULTS,...BUILTINS];
function fail(code) { throw { code }; }
function union(input) {
  const result = [];
  for (const [lo, hi] of input.map(range => [...range]).sort((a,b) => a[0]-b[0])) {
    const last = result[result.length-1];
    if (last && lo <= last[1]+1) last[1] = Math.max(last[1],hi);
    else result.push([lo,hi]);
  }
  return result;
}
function complement(input, max) {
  const result = []; let cursor = 0;
  for (const [lo,hi] of union(input)) {
    if (cursor < lo) result.push([cursor,lo-1]);
    cursor = hi+1;
  }
  if (cursor<=max) result.push([cursor,max]);
  return result;
}
const intersects = (ranges,lo,hi) => ranges.some(([a,b]) => a<=hi&&b>=lo);
const hex = value => '\\x{'+value.toString(16)+'}';
function characters(ranges) {
  if (!ranges.length) fail(CODES.syntax);
  return '['+ranges.map(([lo,hi]) => hex(lo)+(hi===lo?'':'-'+hex(hi))).join('')+']';
}

function normalize(pattern) {
  if (!(pattern instanceof RegExp) || pattern.source.length>LIMITS.sourceUnits) fail(CODES.budget);
  const source=Buffer.from(pattern.source,'utf16le').toString('utf16le');
  const certified=CERTIFIED.find(rule=>rule.source===source&&rule.flags===pattern.flags);
  if(certified)return {source:certified.source,native:new RegExp(certified.source,certified.flags),weight:certified===BUILTINS[0]?256:16,cost:1,empty:false,required:[],captures:0,names:[],flags:0};
  if (pattern.unicodeSets || pattern.flags.includes('v')) fail(CODES.syntax);
  const ast = getParser().parsePattern(source,0,source.length,{unicode:pattern.unicode});
  const meta = { unicode:pattern.unicode, global:pattern.global, sticky:pattern.sticky,
    multilineAnchors:false, codeUnitSensitive:false, repeatedCaptures:false, captures:0, nodes:0, names:[] };
  const max = pattern.unicode?0x10ffff:0xffff;
  function fold(lo,hi) {
    if (!pattern.ignoreCase) return [[lo,hi]];
    if (hi>127) {
      if (lo===hi && SPACE.some(([a,b])=>a<=lo&&b>=lo)) return [[lo,hi]];
      fail(CODES.syntax);
    }
    const ranges = [[lo,hi]];
    if (lo<=90&&hi>=65) ranges.push([Math.max(lo,65)+32,Math.min(hi,90)+32]);
    if (lo<=122&&hi>=97) ranges.push([Math.max(lo,97)-32,Math.min(hi,122)-32]);
    if (pattern.unicode) {
      if ((lo<=75&&hi>=75)||(lo<=107&&hi>=107)) ranges.push([0x212a,0x212a]);
      if ((lo<=83&&hi>=83)||(lo<=115&&hi>=115)) ranges.push([0x17f,0x17f]);
    }
    return union(ranges);
  }
  function charset(node,depth) {
    if (++meta.nodes>LIMITS.astNodes || depth>LIMITS.depth) fail(CODES.budget);
    let ranges;
    if (node.type==='Character') ranges=fold(node.value,node.value);
    else if (node.type==='CharacterClassRange') ranges=fold(node.min.value,node.max.value);
    else if (node.type==='CharacterClass') {
      ranges=union(node.elements.flatMap(child=>charset(child,depth+1)));
      if (node.negate) ranges=complement(ranges,max);
    } else if (node.type==='CharacterSet') {
      if (node.kind==='space') ranges=SPACE;
      else if (node.kind==='digit') ranges=DIGIT;
      else if (node.kind==='word') ranges=pattern.unicode&&pattern.ignoreCase?union([...WORD,[0x17f,0x17f],[0x212a,0x212a]]):WORD;
      else if (node.kind==='any') ranges=pattern.dotAll?[[0,max]]:complement(LINES,max);
      else fail(CODES.syntax);
      if (node.negate) ranges=complement(ranges,max);
    } else fail(CODES.syntax);
    if (intersects(ranges,0xd800,0xdfff)) meta.codeUnitSensitive=true;
    return ranges;
  }
  function walk(node,depth=0,repeated=false) {
    if (++meta.nodes>LIMITS.astNodes || depth>LIMITS.depth) fail(CODES.budget);
    let source, cost=1, empty=false, required=[];
    if (node.type==='Pattern'||node.type==='Group'||node.type==='CapturingGroup') {
      let prefix='(?:';
      if (node.type==='CapturingGroup') {
        meta.repeatedCaptures ||= repeated;
        if (++meta.captures>LIMITS.captures) fail(CODES.budget);
        if (node.name) {
          if (![...node.name].every((ch,i)=>{const n=ch.charCodeAt(0);return n===95||(n>=65&&n<=90)||(n>=97&&n<=122)||(i>0&&n>=48&&n<=57);})) fail(CODES.syntax);
          meta.names.push(node.name);prefix='(?P<'+node.name+'>';
        } else prefix='(';
      }
      const children=node.alternatives.map(child=>walk(child,depth+1,repeated));
      source=prefix+children.map(child=>child.source).join('|')+')';
      cost=2+children.reduce((sum,child)=>sum+child.cost,0);empty=children.some(child=>child.empty);
      required=children[0]?.required.filter(item=>children.every(child=>child.required.some(other=>other.key===item.key)))||[];
    } else if (node.type==='Alternative') {
      const children=node.elements.map(child=>walk(child,depth+1,repeated));
      source=children.map(child=>child.source).join('');cost=children.reduce((sum,child)=>sum+child.cost,0);empty=children.every(child=>child.empty);
      required=[...new Map(children.flatMap(child=>child.required).map(item=>[item.key,item])).values()].slice(0,8);
    } else if (node.type==='Quantifier') {
      const child=walk(node.element,depth+1,repeated||node.max>1);
      const repetitions=node.max===Infinity?node.min+1:node.max;
      cost=2+child.cost*repetitions;
      if (!Number.isSafeInteger(cost)||cost>LIMITS.expandedPerRule) fail(CODES.budget);
      const repeat=node.min===0&&node.max===Infinity?'*':node.min===1&&node.max===Infinity?'+':node.min===0&&node.max===1?'?':'{'+node.min+(node.max===node.min?'':','+(node.max===Infinity?'':node.max))+'}';
      source='(?:'+child.source+')'+repeat+(node.greedy?'':'?');empty=node.min===0||child.empty;
      required=node.min>0?child.required:[];
    } else if (node.type==='Assertion') {
      if (node.kind==='word') {
        if (pattern.unicode&&pattern.ignoreCase) fail(CODES.syntax);
        source=node.negate?'\\B':'\\b';
      } else if (node.kind==='start'||node.kind==='end') {
        source=node.kind==='start'?'^':'$';meta.multilineAnchors ||= pattern.multiline;
      } else fail(CODES.syntax);
      empty=true;
    } else if (node.type==='Character'||node.type==='CharacterClass'||node.type==='CharacterSet') {
      const ranges=charset(node,depth+1);source=characters(ranges);
      if(ranges.reduce((sum,[lo,hi])=>sum+hi-lo+1,0)<=4){
        const chars=ranges.flatMap(([lo,hi])=>Array.from({length:hi-lo+1},(_,i)=>String.fromCodePoint(lo+i)));
        required=[{key:JSON.stringify(ranges),chars}];
      }
    }
    else fail(CODES.syntax);
    if (cost>LIMITS.expandedPerRule||source.length>LIMITS.normalizedPerRule) fail(CODES.budget);
    return {source,cost,empty,required};
  }
  const result=walk(ast);
  return {...meta,...result,flags:pattern.multiline?getBackend().RE2JS.MULTILINE:0};
}

class Call {
  constructor(policy) { this.policy=policy;this.remainingWork=LIMITS.workPerRecord;this.remainingUnits=LIMITS.inputPerRecord;this.calls=0;this.engineCalls=0;this.prefilterMisses=0;this.inputs=new Map();this.failed=false;this.closed=false; }
  stop(code) { this.failed=true;this.policy.emit(code);fail(code); }
  spend(amount) { if(this.closed||this.policy.closed)this.stop(CODES.closed);if(!Number.isSafeInteger(amount)||amount>this.remainingWork)this.stop(CODES.work);this.remainingWork-=amount; }
  inspect(text,analyze=true) {
    if(typeof text!=='string'||text.length>LIMITS.inputPerRule)this.stop(CODES.work);
    let result=this.inputs.get(text);
    if(!result){
      if(this.inputs.size>=LIMITS.valuesPerRecord||text.length>this.remainingUnits)this.stop(CODES.work);
      this.remainingUnits-=text.length;this.spend(text.length+1);
      // Copy code units before either backend can retain a native last-subject/input root.
      text=Buffer.from(text,'utf16le').toString('utf16le');
      result={text,surrogate:false,lone:false,extraLine:false,analyzed:false};this.inputs.set(text,result);
    }
    if(!analyze||result.analyzed)return result;
    result.analyzed=true;
    for(let i=0;i<text.length;i++){
      const n=text.charCodeAt(i);if(n===13||n===8232||n===8233)result.extraLine=true;
      if(n>=0xd800&&n<=0xdfff){result.surrogate=true;const next=text.charCodeAt(i+1);if(n<=0xdbff&&next>=0xdc00&&next<=0xdfff)i++;else result.lone=true;}
    }
    return result;
  }
  compatible(plan,text) {
    const input=this.inspect(text);
    if(input.lone||(!plan.unicode&&input.surrogate&&(plan.codeUnitSensitive||plan.empty))||(plan.multilineAnchors&&input.extraLine))this.stop(CODES.input);
    return input;
  }
  close() { this.inputs.clear();this.closed=true; }
  summary() { return {remainingWork:this.remainingWork,inputUnits:LIMITS.inputPerRecord-this.remainingUnits,ruleCalls:this.calls,engineCalls:this.engineCalls,prefilterMisses:this.prefilterMisses,failed:this.failed,closed:this.closed}; }
  toJSON() { return this.summary(); }
  [Symbol.for('nodejs.util.inspect.custom')]() { return this.summary(); }
}

class Policy {
  constructor({sensitive=[],selectors=[],builtins=[],sanitize=true,onDiagnostic=()=>{}}={}) {
    this.closed=false;this.onDiagnostic=onDiagnostic;this.diagnostics=new Set();this.roles={sensitive:[],selectors:[]};this.invalid={};
    this.sanitize=sanitize;
    this.customCount=sensitive.length;this.nativeGroups={};
    this.stats={engineCompiles:0,nativeRules:0,programInstructions:0,expandedCost:0,normalizedUnits:0,dfaBytes:0};
    if(![sensitive,selectors,builtins].every(Array.isArray)||sensitive.length>LIMITS.rulesPerRole||selectors.length>LIMITS.rulesPerRole||builtins.length>6){this.invalid={sensitive:CODES.budget,selectors:CODES.budget};this.emit(CODES.budget);return;}
    const prepared={};
    for(const [role,rules]of Object.entries({sensitive:sanitize?[...sensitive,...builtins]:[],selectors})){
      try {
        if((role==='sensitive'?sensitive:selectors).length>LIMITS.rulesPerRole||builtins.length>6)fail(CODES.budget);
        prepared[role]=rules.map(normalize);
      }catch(error){this.invalid[role]=error?.code===CODES.budget?CODES.budget:CODES.syntax;this.emit(this.invalid[role]);prepared[role]=[];}
    }
    if(Object.keys(this.invalid).length)return;
    const all=[...prepared.sensitive,...prepared.selectors];
    if(all.reduce((sum,p)=>sum+p.cost,0)>LIMITS.expandedTotal||all.reduce((sum,p)=>sum+p.source.length,0)>LIMITS.normalizedTotal||all.length*LIMITS.dfaBytesPerRule>LIMITS.dfaBytesTotal){
      this.invalid={sensitive:CODES.budget,selectors:CODES.budget};this.emit(CODES.budget);return;
    }
    for(const [role,plans]of Object.entries(prepared))for(const plan of plans){
      try {
        if(plan.native){this.stats.nativeRules++;this.roles[role].push(plan);continue;}
        const {RE2JS,RE2Set}=getBackend();
        const set=new RE2Set(plan.sticky?RE2Set.ANCHOR_START:RE2Set.UNANCHORED,plan.flags,LIMITS.dfaBytesPerRule);
        this.stats.engineCompiles++;set.add(plan.source);set.compile();
        const capture=RE2JS.compile(plan.source,plan.flags);
        const instructions=set.prog.numInst()+capture.programSize();
        if(instructions>LIMITS.instructionsPerRule||this.stats.programInstructions+instructions>LIMITS.instructionsTotal)fail(CODES.budget);
        this.stats.programInstructions+=instructions;this.stats.expandedCost+=plan.cost;this.stats.normalizedUnits+=plan.source.length;this.stats.dfaBytes+=LIMITS.dfaBytesPerRule;
        this.roles[role].push({...plan,set,capture,instructions,executionInstructions:Math.max(set.prog.numInst(),capture.programSize())});
      }catch(error){this.invalid[role]=error?.code===CODES.budget?CODES.budget:CODES.engine;this.emit(this.invalid[role]);break;}
    }
    for(const [role,plans]of Object.entries(this.roles))this.nativeGroups[role]=this.nativeGroup(plans);
    this.nativeGroups.keys=this.nativeGroup(this.roles.sensitive.slice(0,this.customCount));
  }
  nativeGroup(plans){return plans.length&&plans.every(plan=>plan.native)?{regexp:new RegExp(plans.map(plan=>'(?:'+plan.source+')').join('|'),'i'),count:plans.length,weight:Math.max(...plans.map(plan=>plan.weight))}:null;}
  nativeDecision(group,text,call){
    // Certified native rules still require the generic path's UTF-16 safety check.
    try{const input=call.inspect(text);if(input.lone)call.stop(CODES.input);call.calls+=group.count;if(call.calls>LIMITS.ruleCallsPerRecord)call.stop(CODES.work);call.spend((text.length+1)*group.weight);return nativeTest.call(group.regexp,input.text);}
    catch(error){call.failed=true;this.emit(Object.values(CODES).includes(error?.code)?error.code:CODES.engine);return null;}
  }
  emit(code) { if(!Object.values(CODES).includes(code))code=CODES.engine;if(this.diagnostics.has(code))return;this.diagnostics.add(code);try{this.onDiagnostic(code);}catch{} }
  begin() { return new Call(this); }
  testRule(role,index,text,call) {
    const fallback=role==='sensitive';
    if(role==='sensitive'&&!this.sanitize&&!this.closed&&!call.closed)return false;
    if(call.failed)return fallback;
    if(this.closed||call.closed){this.emit(CODES.closed);call.failed=true;return fallback;}
    if(Object.keys(this.invalid).length){this.emit(this.invalid[role]||Object.values(this.invalid)[0]);call.failed=true;return fallback;}
    try {
      const plan=this.roles[role][index];if(!plan)fail(CODES.engine);
      if(plan.native){const decision=this.nativeDecision({regexp:plan.native,count:1,weight:plan.weight},text,call);return decision===null?fallback:decision;}
      text=call.compatible(plan,text).text;if(++call.calls>LIMITS.ruleCallsPerRecord)call.stop(CODES.work);
      for(const item of plan.required){call.spend((text.length+1)*item.chars.length);if(!item.chars.some(ch=>text.indexOf(ch)>=0)){call.prefilterMisses++;return false;}}
      call.spend((text.length+1)*plan.executionInstructions);
      call.engineCalls++;
      return plan.set.match(text).length>0;
    }catch(error){call.failed=true;this.emit(Object.values(CODES).includes(error?.code)?error.code:CODES.engine);return fallback;}
  }
  any(role,text,call) {
    if(this.closed||call.closed||Object.keys(this.invalid).length||call.failed)return this.testRule(role,0,text,call);
    const group=this.nativeGroups[role];if(group){const decision=this.nativeDecision(group,text,call);return decision===null?role==='sensitive':decision;}
    for(let i=0;i<this.roles[role].length;i++)if(this.testRule(role,i,text,call))return true;
    return false;
  }
  privacy(text,call) { return !this.sanitize&&!this.closed&&!call.closed?false:this.any('sensitive',text,call); }
  sensitiveKey(text,call){
    if(!this.sanitize&&!this.closed&&!call.closed)return false;
    if(this.closed||call.closed||Object.keys(this.invalid).length||call.failed)return this.testRule('sensitive',0,text,call);
    const group=this.nativeGroups.keys;if(group){const decision=this.nativeDecision(group,text,call);return decision===null?true:decision;}
    for(let i=0;i<this.customCount;i++)if(this.testRule('sensitive',i,text,call))return true;return false;
  }
  include(text,call) { return !this.closed&&!call.closed&&!Object.keys(this.invalid).length&&this.roles.selectors.length===0&&!call.failed?true:this.any('selectors',text,call); }
  replace(index,text,replacement,call) {
    if(!this.sanitize&&!this.closed&&!call.closed)return typeof text==='string'?text:REDACTED;
    if(Object.keys(this.invalid).length||call.failed){this.emit(Object.values(this.invalid)[0]||CODES.work);return REDACTED;}
    try {
      const plan=this.roles.sensitive[index];if(!plan||plan.native||plan.sticky||plan.repeatedCaptures||typeof replacement!=='string')fail(CODES.replace);
      if(replacement.length>LIMITS.replacementUnits)fail(CODES.output);
      text=call.compatible(plan,text).text;
      replacement=Buffer.from(replacement,'utf16le').toString('utf16le');
      const matcher=plan.capture.matcher(text);const chunks=[];let units=0,previous=0,matches=0;
      function append(part){if(units+part.length>LIMITS.outputUnits)fail(CODES.output);units+=part.length;chunks.push(part);call.spend(part.length+1);}
      function slice(from,to){if(units+to-from>LIMITS.outputUnits)fail(CODES.output);append(text.slice(from,to));}
      while(true){
        if(++call.calls>LIMITS.ruleCallsPerRecord)call.stop(CODES.work);
        call.spend((text.length-previous+1)*plan.executionInstructions);
        if(!matcher.find())break;
        if(++matches>LIMITS.replacementsPerValue)fail(CODES.output);
        const start=matcher.start(),end=matcher.end();if(start<previous||end<start||end>text.length)fail(CODES.engine);slice(previous,start);
        for(let i=0;i<replacement.length;i++){
          const ch=replacement[i],next=replacement[i+1];if(ch!=='$'||next===undefined){append(ch);continue;}
          if(next==='$'){append('$');i++;}else if(next==='&'){slice(start,end);i++;}else if(next==='`'){slice(0,start);i++;}else if(next==="'"){slice(end,text.length);i++;}
          else if(next==='<'&&plan.names.length){const close=replacement.indexOf('>',i+2);if(close<0){append('$');continue;}const name=replacement.slice(i+2,close);append(plan.names.includes(name)?matcher.group(name)||'':'');i=close;}
          else if(next>='0'&&next<='9'){
            let count=1,n=Number(next);const second=replacement[i+2];if(second>='0'&&second<='9'&&Number(next+second)>0&&Number(next+second)<=plan.captures){n=Number(next+second);count=2;}
            if(n>0&&n<=plan.captures){append(matcher.group(n)||'');i+=count;}else append('$');
          }else append('$');
        }
        previous=end;if(!plan.global)break;
      }
      slice(previous,text.length);return chunks.join('');
    }catch(error){call.failed=true;this.emit(Object.values(CODES).includes(error?.code)?error.code:CODES.engine);return REDACTED;}
  }
  close() { for(const plans of Object.values(this.roles))for(const plan of plans){plan.capture?.reset();plan.capture=null;plan.set=null;plan.native=null;plan.source=null;plan.required=[];}this.roles={sensitive:[],selectors:[]};this.nativeGroups={};this.closed=true;this.onDiagnostic=()=>{}; }
  toJSON() { return {closed:this.closed,ready:!this.closed&&!Object.keys(this.invalid).length,codes:[...this.diagnostics],stats:{...this.stats}}; }
  [Symbol.for('nodejs.util.inspect.custom')]() { return this.toJSON(); }
}

module.exports={Policy,LIMITS,CODES,REDACTED,BUILTINS,DEFAULTS,normalize};
