// One-shot extractor: parses website/index.html and emits seed-builtins.json
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'website', 'index.html'), 'utf8');

function extractConstBlock(src, name) {
  const startIdx = src.indexOf(`const ${name}`);
  if (startIdx < 0) throw new Error(`Could not find const ${name}`);
  const eqIdx = src.indexOf('=', startIdx);
  const valStart = eqIdx + 1;
  // We need to scan for the matching closing bracket/brace, respecting strings and template literals.
  const text = src.slice(valStart);
  let i = 0;
  // Skip whitespace
  while (i < text.length && /\s/.test(text[i])) i++;
  const opener = text[i];
  if (opener !== '[' && opener !== '{') throw new Error(`Expected [ or { for ${name}, got ${opener}`);
  const closer = opener === '[' ? ']' : '}';
  let depth = 0;
  let inString = null; // null | "'" | '"' | '`'
  let inTemplate = false;
  let escape = false;
  let braceDepthInTemplate = 0;
  while (i < text.length) {
    const ch = text[i];
    if (escape) { escape = false; i++; continue; }
    if (inString) {
      if (ch === '\\') { escape = true; i++; continue; }
      if (inString === '`') {
        // Handle ${...} template substitution depth
        if (ch === '$' && text[i+1] === '{') {
          braceDepthInTemplate++;
          i += 2;
          continue;
        }
        if (braceDepthInTemplate > 0) {
          if (ch === '{') braceDepthInTemplate++;
          else if (ch === '}') braceDepthInTemplate--;
          i++;
          continue;
        }
        if (ch === '`') { inString = null; i++; continue; }
      } else if (ch === inString) {
        inString = null; i++; continue;
      }
      i++; continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { inString = ch; i++; continue; }
    if (ch === '/' && text[i+1] === '/') {
      // line comment
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && text[i+1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i+1] === '/')) i++;
      i += 2;
      continue;
    }
    if (ch === opener) depth++;
    else if (ch === closer) {
      depth--;
      if (depth === 0) {
        // end of block
        return text.slice(0, i + 1);
      }
    }
    i++;
  }
  throw new Error(`Unbalanced ${name}`);
}

const scenariosBlock = extractConstBlock(html, 'scenarios');
const systemPromptsBlock = extractConstBlock(html, 'systemPrompts');
const longDescriptionsBlock = extractConstBlock(html, 'longDescriptions');
const generatedSampleDataBlock = extractConstBlock(html, 'generatedSampleData');

const ctx = vm.createContext({});
const scenarios = vm.runInContext(`(${scenariosBlock})`, ctx);
const systemPrompts = vm.runInContext(`(${systemPromptsBlock})`, ctx);
const longDescriptions = vm.runInContext(`(${longDescriptionsBlock})`, ctx);
const generatedSampleData = vm.runInContext(`(${generatedSampleDataBlock})`, ctx);

const LIVE_AGENT_IDS = new Set([
  'trade-surveillance', 'fraud-detection', 'claims-fraud',
  'aml-monitoring', 'merchant-acquiring', 'sportsbook-liability', 'tender-benchmarking'
]);

const out = scenarios.map(s => ({
  id: s.id,
  name: s.title,
  description: s.description,
  longDescription: longDescriptions[s.id] || null,
  sector: s.sector,
  sectorLabel: s.sectorLabel,
  schema: s.schema || '',
  sampleData: generatedSampleData[s.id] || s.sampleData || '',
  systemPrompt: systemPrompts[s.id] || null,
  questions: (s.qanda || []).map(q => q.q),
  status: LIVE_AGENT_IDS.has(s.id) ? 'live' : 'draft',
  tags: [s.sectorLabel],
  allowDeploy: true,
  isBuiltin: true
}));

fs.writeFileSync(path.join(__dirname, 'seed-builtins.json'), JSON.stringify(out, null, 2));
console.log(`Wrote ${out.length} built-in scenarios to seed-builtins.json`);
