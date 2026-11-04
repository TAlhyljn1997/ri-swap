// Meta tools registry + call gate for RI-SWAP. PROTOTYPE / OFFLINE.
// Every Meta tool in one list: what it is, what it needs, whether it may run.
// Nothing here sends a call. checkCallGate only answers APPROVED or a typed
// refusal, in fixed order: APPROVAL -> BOUND -> KEY -> BUDGET.
// Gate order adapted from the flagship metamodel lane (own work, not a copy
// of any governed source).
export class ToolsError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'ToolsError';
    this.code = code;
  }
}

const freezeTool = t => Object.freeze({ ...t, requirements: Object.freeze([...t.requirements]) });

export const META_TOOLS = Object.freeze([
  freezeTool({ tool: 'muse-spark-1.3', kind: 'HOSTED_API', adapter: 'src/meta-client.mjs', status: 'PREPARED_NOT_CONNECTED',
    requirements: ['MODEL_API_KEY in server env (ROO custody, never in repo)', 'current approved Meta team/project entitlement verified by operator readback', 'provider authentication verified separately from RI-SWAP route access', 'per-batch owner approval + budget cap'] }),
  freezeTool({ tool: 'web-search', kind: 'HOSTED_API', adapter: 'src/meta-client.mjs webSearchTool', status: 'DISABLED_BY_DEFAULT',
    requirements: ['live authority separate from Spark', 'explicit already-sanitised public query of 1 to 240 chars', 'no private data forwarded'] }),
  freezeTool({ tool: 'sam-3.1', kind: 'LOCAL_WEIGHTS_OR_PROVIDER', adapter: 'src/sam-client.mjs + @meta-sam/parser@0.1.0', status: 'PARSER_BOUND_PROVIDER_NOT_CONNECTED',
    requirements: ['official parser bound under the SAM License', 'local path: Python >=3.12, PyTorch >=2.7, CUDA GPU, checkpoint plus rights plus terms', 'or an authorised provider binding', 'selects objects/regions only; human confirmation required; never quality/price/ownership verification'] }),
  freezeTool({ tool: 'voice-transcribe', kind: 'HOSTED_API', adapter: 'src/meta-tools.mjs transcribeVoice', status: 'SCHEMA_UNVERIFIED',
    requirements: ['MODEL_API_KEY plus budget (docs list transcribe at $0.18/hr)', 'endpoint schema verified by a first authorised call', 'per-batch owner approval'] }),
  freezeTool({ tool: 'dinov2', kind: 'LOCAL_WEIGHTS', adapter: 'src/dinov2-client.mjs', status: 'DUPLICATE_ANALYSIS_NOT_RUN',
    requirements: ['reviewed weights and runtime', 'measured threshold and false-positive review', 'candidate use only: similarity signal with product-media; never ownership/fraud proof'] }),
  freezeTool({ tool: 'sam-3d', kind: 'NONE', adapter: 'NONE', status: 'OUT_OF_SCOPE',
    requirements: ['no RI-SWAP 3D requirement; tracked only so nothing is silently missing'] }),
]);

export function toolStatus(name) {
  const found = META_TOOLS.find(t => t.tool === name);
  if (!found) throw new ToolsError('TOOLS_UNKNOWN_TOOL', `no Meta tool named ${String(name)}`);
  return found;
}

export function checkCallGate({ approvalId = '', bound = false, keyPresent = false, callsUsed = 0, cap = 0 } = {}) {
  if (!approvalId || typeof approvalId !== 'string') throw new ToolsError('APPROVAL_REQUIRED', 'owner approval id required per call batch');
  if (!bound) throw new ToolsError('PROVIDER_NOT_CONNECTED', 'tool is not bound for live calls');
  if (!keyPresent) throw new ToolsError('KEY_NOT_BOUND', 'credential is not present in server env');
  if (!Number.isInteger(callsUsed) || !Number.isInteger(cap) || callsUsed < 0 || cap <= 0 || callsUsed >= cap) {
    throw new ToolsError('BUDGET_EXHAUSTED', 'call budget is missing or exhausted');
  }
  return { ok: true, approval: approvalId };
}

export function createBudget({ cap = 0 } = {}) {
  if (!Number.isInteger(cap) || cap <= 0) throw new ToolsError('BUDGET_EXHAUSTED', 'budget cap must be a positive integer');
  let used = 0;
  return {
    use(n = 1) {
      if (!Number.isInteger(n) || n <= 0) throw new ToolsError('TOOLS_BAD_COUNT', 'use count must be a positive integer');
      if (used + n > cap) throw new ToolsError('BUDGET_EXHAUSTED', 'call budget is exhausted');
      used += n;
      return { used, remaining: cap - used };
    },
    callsUsed: () => used,
    remaining: () => cap - used,
  };
}

export const VOICE_MAX_BYTES = 25 * 1024 * 1024;

export function transcribeVoice({ approvalId = '', bound = false, keyPresent = false, audio = null, callsUsed = 0, cap = 0 } = {}) {
  checkCallGate({ approvalId, bound, keyPresent, callsUsed, cap });
  const buf = Buffer.from(audio || []);
  if (!buf.length) throw new ToolsError('VOICE_BAD_AUDIO', 'no audio bytes received');
  if (buf.length > VOICE_MAX_BYTES) throw new ToolsError('VOICE_BAD_AUDIO', 'audio exceeds the 25 MB limit');
  throw new ToolsError('VOICE_SCHEMA_UNVERIFIED', 'voice endpoint schema is not verified; no bytes were sent');
}
