// One truthful inventory of Meta/Muse-derived capabilities consumed by
// RI-SWAP. It points to RI-SWAP-owned adapters rather than importing Muse-App.
import { META_TOOLS } from './meta-tools.mjs';

const utility = value => Object.freeze({ ...value });

export const META_UTILITY_SUITE = Object.freeze([
  ...META_TOOLS.map(item => utility({ id: item.tool, adapter: item.adapter, state: item.status, provider_effect: false })),
  utility({ id: 'facebook-login', adapter: 'src/facebook-login.mjs', state: 'CONFIGURATION_DEPENDENT', provider_effect: false }),
  utility({ id: 'facebook-email-evidence', adapter: 'src/facebook-email-proof.mjs', state: 'CONTRACT_READY_NOT_IDENTITY_PROOF', provider_effect: false }),
  utility({ id: 'whatsapp-otp', adapter: 'src/ri-yellow-otp-login.mjs + src/wa-otp.mjs', state: 'CONFIGURATION_DEPENDENT', provider_effect: false }),
  utility({ id: 'product-media', adapter: 'src/product-media.mjs + src/media-route-contract.mjs', state: 'CONTROLLER_WIRED_MIGRATION_AND_PRIVACY_GATE_PENDING', provider_effect: false }),
  utility({ id: 'region-provenance', adapter: 'src/region-registry.mjs', state: 'LOCAL_CONTRACT_READY', provider_effect: false }),
  utility({ id: 'pii-redaction', adapter: 'src/redact.mjs', state: 'LOCAL_CONTRACT_READY', provider_effect: false }),
  utility({ id: 'messenger-page-inbound', adapter: 'src/messenger-page-intake.mjs', state: 'CONTROLLER_WIRED_PROVIDER_AND_PAGE_BINDING_PENDING', provider_effect: false }),
  utility({ id: 'assist-envelope', adapter: 'src/assist-envelope.mjs', state: 'API_WIRED_SOURCE_SEPARATED', provider_effect: false }),
  utility({ id: 'ri-yellow-readback', adapter: 'src/ri-yellow-readback.mjs', state: 'API_WIRED_READ_ONLY', provider_effect: false }),
]);

export function metaUtilityStatus() {
  return Object.freeze({
    suite: 'RI_SWAP_META_UTILITY_SUITE_V1',
    utilities: META_UTILITY_SUITE,
    registry_is_provider_proof: false,
    live_effect_verified: false,
    deployment_verified_by_registry: false,
  });
}

