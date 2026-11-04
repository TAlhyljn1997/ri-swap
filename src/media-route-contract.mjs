// Authenticated product-media contract for the Muse/RI-SWAP integration lane.
// The controller proves Offer-party authority. In production, one durable
// repository stores metadata and bytes together; legacy split stores remain
// available only for offline contract tests.
import { createHash } from 'node:crypto';
import { intakeProductMedia } from './product-media.mjs';

export class MediaRouteContractError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'MediaRouteContractError';
    this.code = code;
  }
}

const fail = (code, message) => { throw new MediaRouteContractError(code, message); };
const requiredFn = (value, name) => {
  if (typeof value !== 'function') fail('MEDIA_CONTRACT_DEPENDENCY_MISSING', `${name} is required`);
  return value;
};

export function createMediaRouteContract({ assertOfferParty, repository, mediaStore, recordStore, intake = intakeProductMedia } = {}) {
  const assertParty = requiredFn(assertOfferParty, 'assertOfferParty');
  const atomicRepository = repository && typeof repository.put === 'function' && typeof repository.get === 'function';
  if (!atomicRepository && (!mediaStore || typeof mediaStore.put !== 'function' || typeof mediaStore.get !== 'function')) {
    fail('MEDIA_CONTRACT_DEPENDENCY_MISSING', 'mediaStore put/get is required');
  }
  if (!atomicRepository && (!recordStore || typeof recordStore.put !== 'function' || typeof recordStore.get !== 'function')) {
    fail('MEDIA_CONTRACT_DEPENDENCY_MISSING', 'durable recordStore put/get is required');
  }

  async function upload({ actor, offer_id, bytes, filename } = {}) {
    if (!String(actor || '').trim()) fail('MEDIA_AUTH_REQUIRED', 'authenticated actor required');
    if (!String(offer_id || '').trim()) fail('MEDIA_OFFER_REQUIRED', 'offer_id required');
    await assertParty({ actor, offer_id, action: 'MEDIA_UPLOAD' });
    const media = intake(bytes, { filename, store: atomicRepository ? null : mediaStore });
    const scopeId = `oms-${createHash('sha256').update(`${offer_id}:${media.media_id}`).digest('hex').slice(0, 24)}`;
    const record = Object.freeze({
      media_scope_id: scopeId,
      offer_id,
      media,
      uploaded_by: actor,
      exif_policy: 'DECISION_REQUIRED_BEFORE_NON_LOCAL_USE',
      vision_eligible: false,
      human_review_required: true,
    });
    if (atomicRepository) await repository.put(record, Buffer.from(bytes));
    else await recordStore.put(record);
    return record;
  }

  async function read({ actor, offer_id, media_scope_id } = {}) {
    if (!String(actor || '').trim()) fail('MEDIA_AUTH_REQUIRED', 'authenticated actor required');
    await assertParty({ actor, offer_id, action: 'MEDIA_READ' });
    const stored = atomicRepository ? await repository.get(media_scope_id) : null;
    const record = atomicRepository ? stored?.record : await recordStore.get(media_scope_id);
    if (!record || record.offer_id !== offer_id) fail('MEDIA_NOT_FOUND', 'media is not available for this Offer');
    return atomicRepository ? stored : { record, bytes: mediaStore.get(record.media.stored_ref) };
  }

  return Object.freeze({ upload, read, status: () => Object.freeze({
    contract: 'AUTHENTICATED_OFFER_MEDIA_V1',
    controller_wired: true,
    durable_repository_required: true,
    exif_policy: 'PENDING_OWNER_DECISION',
  }) });
}

