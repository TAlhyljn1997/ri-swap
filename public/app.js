// RI-SWAP public-test UI. Plain DOM only; user/model text is inserted with textContent.
import { riYellowLoginBoundary } from './login-boundary.js';
import { classifyOfferList, filterPublicOffers, publicOfferMeta } from './open-offers-ui.js';
import { clearClientSession, createSignOutFlow, recoverExpiredClientSession, syncSignOutButton } from './sign-out-ui.js';
import { canonicalConfirmedOffer, validateDraftCreationBinding, validateDraftReceipt } from './draft-receipt.js';
import { applyUnavailableUtilityControls } from './meta-utility-ui-state.js';
const $ = id => document.getElementById(id);
// Keep API calls under the directory that serves this app. At `/ri-swap/`,
// `/api/status` must become `/ri-swap/api/status`; at `/`, it stays `/api/status`.
const API_ROOT = new URL('.', window.location.href).pathname.replace(/\/$/, '');
const requestedLanguage = new URLSearchParams(window.location.search).get('lang');
const GUEST_DRAFT_KEY = 'ri-swap-guest-offer-draft-v1';
// English is the product default on every fresh navigation. Vietnamese remains
// an explicit choice through `?lang=vi` or the visible language toggle.
const state = { language: requestedLanguage === 'vi' ? 'vi' : 'en', token: null, me: null, businessLink: null, realOnly: true, riYellowLoginConfigured: false, riYellowChallenge: null, facebookLoginConfigured: false, googleLoginConfigured: false, locationFilter: '', offers: [], offerSearch: '', offersRequestId: 0, offersLoading: false, offersError: null, offersStale: false, offersLastUpdatedAt: null, offerActionPending: new Set(), offer: null, offerDetail: null, draftId: null, guestDraftPending: false, guestDraftAction: null, keys: new Map(), pendingAccept: null, knowledgeRequestId: 0, sessionEpoch: 0, sessionExpired: false, sessionRestoreError: null, unsavedChanges: false };
const tr = (vi, en) => state.language === 'vi' ? vi : en;
const UNSAVED_FIELD_IDS = Object.freeze(['a-text', 'o-give', 'o-receive', 'o-loc', 'o-av', 'o-pk', 'o-exp', 'business-id', 'k-question']);
const OFFER_FIELD_IDS = UNSAVED_FIELD_IDS.filter(id => id.startsWith('o-'));
let savedFieldValues = new Map(UNSAVED_FIELD_IDS.map(id => [id, $(id).value]));
const refreshUnsavedChanges = () => { state.unsavedChanges = UNSAVED_FIELD_IDS.some(id => $(id).value !== savedFieldValues.get(id)); };
const markFieldsSaved = (ids = UNSAVED_FIELD_IDS) => { for (const id of ids) savedFieldValues.set(id, $(id).value); refreshUnsavedChanges(); };
const markFieldSaved = (id, submittedValue) => { savedFieldValues.set(id, submittedValue); refreshUnsavedChanges(); };

function guestDraftSnapshot(action = state.guestDraftAction || 'save') {
  const existing = readGuestDraft();
  return {
    version: 1,
    action: action === 'open' ? 'open' : 'save',
    idempotency_key: typeof existing?.idempotency_key === 'string' && existing.idempotency_key
      ? existing.idempotency_key
      : crypto.randomUUID(),
    saved_at: new Date().toISOString(),
    fields: Object.fromEntries(['a-text', ...OFFER_FIELD_IDS].map(id => [id, $(id).value])),
  };
}

function persistGuestDraft(action) {
  const draft = guestDraftSnapshot(action);
  sessionStorage.setItem(GUEST_DRAFT_KEY, JSON.stringify(draft));
  state.guestDraftPending = true;
  state.guestDraftAction = draft.action;
  renderGuestDraftPreview();
  return draft;
}

function readGuestDraft() {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(GUEST_DRAFT_KEY) || 'null');
    if (!parsed || parsed.version !== 1 || !parsed.fields || typeof parsed.fields !== 'object') return null;
    return parsed;
  } catch {
    sessionStorage.removeItem(GUEST_DRAFT_KEY);
    return null;
  }
}

function restoreGuestDraft() {
  const draft = readGuestDraft();
  if (!draft) { renderGuestDraftPreview(); return false; }
  for (const id of ['a-text', ...OFFER_FIELD_IDS]) {
    if (typeof draft.fields[id] === 'string') $(id).value = draft.fields[id];
  }
  state.guestDraftPending = true;
  state.guestDraftAction = draft.action === 'open' ? 'open' : 'save';
  refreshUnsavedChanges();
  renderGuestDraftPreview();
  return true;
}

function clearGuestDraft() {
  sessionStorage.removeItem(GUEST_DRAFT_KEY);
  state.guestDraftPending = false;
  state.guestDraftAction = null;
  renderGuestDraftPreview();
}

function renderGuestDraftPreview() {
  const host = $('guest-draft-preview-values');
  if (!host) return;
  const rows = [
    [tr('Tôi trao', 'I give'), $('o-give').value],
    [tr('Tôi cần', 'I receive'), $('o-receive').value],
    [tr('Khu vực', 'Location'), $('o-loc').value],
    [tr('Thời gian', 'Availability'), $('o-av').value],
  ];
  host.replaceChildren(...rows.flatMap(([label, value]) => [el('dt', label), el('dd', value.trim() || '—')]));
  const confirm = $('confirm-draft-save');
  confirm.hidden = !(state.me && state.guestDraftPending);
  $('discard-guest-draft').hidden = !state.guestDraftPending;
  confirm.textContent = state.guestDraftAction === 'open'
    ? tr('Xác nhận lưu trước khi mở Offer', 'Confirm save before opening Offer')
    : tr('Xác nhận lưu vào database', 'Confirm save to database');
}

function el(tag, text, attrs = {}) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  Object.assign(node, attrs);
  return node;
}
const party = id => id || tr('Chưa xác định', 'Unknown');
const termsText = t => tr(
  `Trao: ${t.give} · Cần: ${t.receive}${t.location ? ` · Tại: ${t.location}` : ''}${t.availability ? ` · ${t.availability}` : ''}`,
  `Give: ${t.give} · Receive: ${t.receive}${t.location ? ` · At: ${t.location}` : ''}${t.availability ? ` · ${t.availability}` : ''}`,
);

const DEMO_OFFERS = Object.freeze([
  { id: 'DEMO-OFFER-WELLNESS-HERBS', vi: 'Hướng dẫn dinh dưỡng đổi rau thơm', en: 'Nutrition guidance for fresh herbs', giveVi: 'Buổi hướng dẫn dinh dưỡng cộng đồng', giveEn: 'A community nutrition guidance session', receiveVi: 'Rau thơm tươi', receiveEn: 'Fresh herbs', area: 'Fairfield · NSW', availabilityVi: 'Chiều thứ Bảy', availabilityEn: 'Saturday afternoon', packages: 2 },
  { id: 'DEMO-OFFER-BIKE-MEAL', vi: 'Sửa xe đạp đổi bữa ăn cuối tuần', en: 'Bicycle repair for a weekend meal', giveVi: 'Kiểm tra và sửa xe đạp cơ bản', giveEn: 'Basic bicycle check and repair', receiveVi: 'Một bữa ăn gia đình', receiveEn: 'A family meal', area: 'Cabramatta · NSW', availabilityVi: 'Cuối tuần', availabilityEn: 'Weekend', packages: 1 },
  { id: 'DEMO-OFFER-UPHOLSTERY-PHOTO', vi: 'Đánh giá bọc ghế đổi ảnh sản phẩm', en: 'Upholstery assessment for product photography', giveVi: 'Đánh giá tình trạng ghế', giveEn: 'Furniture condition assessment', receiveVi: 'Bộ ảnh sản phẩm giới hạn', receiveEn: 'A bounded product photo set', area: 'Canley Vale · NSW', availabilityVi: 'Theo lịch hẹn', availabilityEn: 'By appointment', packages: 2 },
]);

const DEMO_EXCHANGES = Object.freeze([
  { id: 'DEMO-EXCHANGE-DIRECT', vi: 'Đề nghị trực tiếp', en: 'Direct proposal', pathVi: 'Offer → Proposal → hai bên Accept → Agreement Reached', pathEn: 'Offer → Proposal → both parties Accept → Agreement Reached' },
  { id: 'DEMO-EXCHANGE-REVISED', vi: 'Đề nghị có điều chỉnh', en: 'Revised proposal', pathVi: 'Offer → Counteroffer phiên bản mới → hai bên Accept cùng phiên bản → Agreement Reached', pathEn: 'Offer → new Counteroffer version → both parties Accept the same version → Agreement Reached' },
]);

function demoCard(record, completed = false) {
  const article = el('article', undefined, { className: 'demo-example-card' });
  article.dataset.demoId = record.id;
  article.dataset.dataClass = 'DEMO';
  article.append(el('span', tr('DEMO · CHỈ LÀ VÍ DỤ', 'DEMO · EXAMPLE ONLY'), { className: 'demo-badge' }));
  article.append(el('h3', tr(record.vi, record.en)));
  if (completed) {
    article.append(el('p', tr(record.pathVi, record.pathEn)));
    article.append(el('p', tr('Agreement Reached chỉ ghi nhận thỏa thuận; không chứng minh giao hàng, thanh toán hay hoàn tất dịch vụ.', 'Agreement Reached records agreement only; it does not prove delivery, payment, or fulfilment.'), { className: 'demo-example-boundary' }));
  } else {
    article.append(el('p', tr(`Trao: ${record.giveVi}`, `Give: ${record.giveEn}`)));
    article.append(el('p', tr(`Nhận: ${record.receiveVi}`, `Receive: ${record.receiveEn}`)));
    article.append(el('p', tr(`${record.area} · ${record.availabilityVi} · ${record.packages} gói`, `${record.area} · ${record.availabilityEn} · ${record.packages} package${record.packages === 1 ? '' : 's'}`), { className: 'demo-example-meta' }));
    const button = el('button', tr('Xem hành trình mẫu', 'View demo journey'), { className: 'secondary', type: 'button' });
    button.onclick = () => {
      document.querySelector('#demo-examples details:nth-of-type(2)').open = true;
      $('demo-exchange-list').scrollIntoView({ block: 'center' });
      $('demo-exchange-list').setAttribute('tabindex', '-1');
      $('demo-exchange-list').focus();
    };
    article.append(button);
  }
  return article;
}

function renderDemoExamples() {
  const offers = $('demo-offer-list');
  const exchanges = $('demo-exchange-list');
  if (!offers || !exchanges) return;
  offers.replaceChildren(...DEMO_OFFERS.map(item => demoCard(item)));
  exchanges.replaceChildren(...DEMO_EXCHANGES.map(item => demoCard(item, true)));
}

function showHoaMaiResult(vi, en, error = false) {
  const result = $('hoa-mai-action-result');
  result.textContent = tr(vi, en);
  result.className = `result${error ? ' bad' : ''}`;
}

function routeHoaMaiIntent() {
  const intent = $('hoa-mai-intent').value;
  const dialog = $('hoa-mai-action-dialog');
  if (intent === 'offer') {
    dialog.close();
    $('a-text').scrollIntoView({ block: 'center' });
    $('a-text').focus();
    setNotice(tr('Đã mở công cụ soạn nháp. Guest có thể hỏi Hoa Mai và xem trước; đăng nhập và xác nhận mới lưu database.', 'The draft tool is open. Guests may ask Hoa Mai and preview; sign-in and confirmation are required before any database save.'));
    return;
  }
  if (intent === 'ri-yellow' || intent === 'donghanh') {
    dialog.close();
    const trigger = document.querySelector(`[data-service-intro="${intent}"]`);
    if (trigger) trigger.click();
    else setNotice(tr('Điểm điều hướng dịch vụ hiện chưa khả dụng.', 'The service navigation entrypoint is unavailable.'), true);
    return;
  }
  if (intent === 'jobs') {
    showHoaMaiResult('Hướng dẫn hiện có: mở RI-YELLOW, tìm mục Việc làm và tự kiểm tra từng listing. Đây chỉ là điều hướng; Hoa Mai không nộp đơn thay bạn.', 'Current guidance: open RI-YELLOW, find Jobs, and review each listing yourself. This is navigation only; Hoa Mai does not apply for you.');
    return;
  }
  if (intent === 'help' || intent === 'about') {
    dialog.close();
    $(intent).scrollIntoView({ block: 'start' });
    $(intent).setAttribute('tabindex', '-1');
    $(intent).focus();
    setNotice(tr('Đã điều hướng đến nội dung có sẵn.', 'Navigated to the existing content.'));
    return;
  }
  showHoaMaiResult('Chưa có contract liên hệ riêng được xác minh trong candidate này. Hãy mở Trợ giúp; không có tin nhắn nào được gửi.', 'No dedicated contact contract is verified in this candidate. Open Help instead; no message was sent.', true);
}

function setNotice(message = '', error = false) {
  $('notice').textContent = message;
  $('notice').className = `notice${error ? ' error' : ''}`;
}
function log(line) {
  const d = document.createElement('div');
  d.textContent = `${new Date().toLocaleTimeString()} ${line}`;
  $('log').prepend(d);
}
const guard = fn => async (...args) => {
  setNotice();
  try { await fn(...args); }
  catch (error) {
    if (error.code === 'CLIENT_SESSION_CHANGED') return;
    log(`ERROR ${error.code ?? ''} ${error.message}`);
    setNotice(`${error.code ?? tr('Lỗi', 'Error')}: ${error.message}`, true);
  }
};

async function readJsonObject(res) {
  try {
    const json = await res.json();
    return json && typeof json === 'object' && !Array.isArray(json) ? json : null;
  } catch { return null; }
}

async function api(method, path, body) {
  const sessionEpoch = state.sessionEpoch;
  const headers = { 'content-type': 'application/json' };
  if (state.token) headers.authorization = `Bearer ${state.token}`;
  const res = await fetch(`${API_ROOT}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = await readJsonObject(res);
  if (!json) {
    if (sessionEpoch !== state.sessionEpoch) throw Object.assign(new Error('Client session changed'), { code: 'CLIENT_SESSION_CHANGED' });
    log(`${method} ${path} -> ${res.status} API_NON_JSON_RESPONSE`);
    if (res.status === 401 && (state.me || state.token)) {
      clearClientSession(state);
      state.sessionExpired = true;
      showExpiredSession();
      setNotice(tr('Không đọc được phản hồi 401. Trạng thái phiên chưa rõ; hãy đăng nhập lại rồi kiểm tra phiên. Nội dung chưa gửi vẫn ở đây.', 'Could not read the 401 response. Session status is uncertain; sign in again and check the session. Unsent text remains here.'), true);
      throw Object.assign(new Error('Session status uncertain'), { code: 'CLIENT_SESSION_CHANGED', status: 401 });
    }
    throw Object.assign(new Error(tr('Phản hồi máy chủ không đọc được. Hãy kiểm tra trạng thái trước khi thử lại.', 'The server response could not be read. Check status before retrying.')), { code: 'API_NON_JSON_RESPONSE', status: res.status });
  }
  if (sessionEpoch !== state.sessionEpoch) throw Object.assign(new Error('Client session changed'), { code: 'CLIENT_SESSION_CHANGED' });
  log(`${method} ${path} -> ${res.status}${json.error ? ` ${json.error.code}` : ''}`);
  if (recoverExpiredClientSession(state, res.status, json.error?.code)) {
    showExpiredSession();
    throw Object.assign(new Error('RI-SWAP session expired'), { code: 'CLIENT_SESSION_CHANGED', status: 401 });
  }
  if (!res.ok) throw Object.assign(new Error(json.error?.message ?? 'error'), { code: json.error?.code, status: res.status });
  return json;
}

function renderSessionRecovery() {
  const expired = state.sessionExpired === true;
  $('recheck-session').hidden = !expired;
  $('real-only-message').textContent = expired
    ? tr('Phiên RI-SWAP đã hết hạn hoặc được đăng xuất. Nội dung chưa gửi vẫn ở đây. Hãy đăng nhập trong tab mới, quay lại và kiểm tra phiên; không có yêu cầu nào tự gửi lại.', 'Your RI-SWAP session expired or was signed out. Your unsent text remains here. Sign in in a new tab, return and check the session; no request is sent again automatically.')
    : $('real-only-message').dataset[state.language];
  for (const id of ['google-login-link', 'real-login-link']) {
    const link = $(id);
    if (expired) { link.target = '_blank'; link.rel = 'noopener'; }
    else { link.removeAttribute('target'); link.removeAttribute('rel'); }
  }
}

function showExpiredSession() {
  for (const id of ['props', 'agrs', 'knowledge-answer', 'accept-review', 'log']) $(id).replaceChildren();
  for (const id of ['o-state', 'a-out', 'business-link-result']) $(id).textContent = '';
  $('sel').textContent = tr('Hãy chọn một Offer trước.', 'Select an Offer first.');
  $('p-pk').value = '1';
  $('ri-yellow-otp-code').value = '';
  $('business-link-details').open = false;
  if ($('accept-dialog').open) $('accept-dialog').close();
  if ($('ri-yellow-login-dialog').open) $('ri-yellow-login-dialog').close();
  setWorkflowAccess();
  updateIdentity();
  renderOffers();
  setNotice(tr('Phiên RI-SWAP đã hết hạn. Hãy đăng nhập lại rồi tự chọn gửi nội dung còn giữ trên trang.', 'RI-SWAP session expired. Sign in again, then choose whether to submit the text still on this page.'), true);
  $('real-only-gate').scrollIntoView({ block: 'start' });
  const focusTarget = [
    state.riYellowLoginConfigured && $('ri-yellow-login-link'),
    state.googleLoginConfigured && $('google-login-link'),
    state.facebookLoginConfigured && $('real-login-link'),
    $('recheck-session'),
  ].find(Boolean);
  focusTarget.focus();
}

function applyLanguage() {
  document.documentElement.lang = state.language;
  localStorage.setItem('ri-swap-language', state.language);
  for (const node of document.querySelectorAll('[data-vi][data-en]')) node.textContent = node.dataset[state.language];
  for (const node of document.querySelectorAll('[data-vi-placeholder][data-en-placeholder]')) node.placeholder = node.dataset[`${state.language}Placeholder`];
  for (const node of document.querySelectorAll('[data-vi-aria-label][data-en-aria-label]')) node.setAttribute('aria-label', node.dataset[`${state.language}AriaLabel`]);
  $('language-toggle').textContent = state.language === 'vi' ? 'EN' : 'VI';
  $('language-toggle').setAttribute('aria-label', state.language === 'vi' ? 'Switch to English' : 'Chuyển sang tiếng Việt');
  $('location-query').placeholder = 'Cabramatta · 2166';
  renderSessionRecovery();
  updateIdentity();
  renderOffers();
  renderDemoExamples();
  renderGuestDraftPreview();
  if (state.businessLink) renderBusinessLink(state.businessLink);
  if (state.offer) refreshProposals().catch(() => {});
  if (state.token) refreshAgreements().catch(() => {});
}

async function loadLocationOptions() {
  const source = $('location-source');
  source.textContent = tr('Đang tải suburb RI-YELLOW đã xuất bản…', 'Loading published RI-YELLOW suburbs…');
  try {
    const selectedState = $('location-state').value;
    const result = await api('GET', `/api/ri-yellow/suburbs/${encodeURIComponent(selectedState)}`);
    const list = $('ri-yellow-suburbs');
    list.replaceChildren();
    for (const item of result.suburbs || []) {
      const option = document.createElement('option');
      option.value = item.suburb;
      option.label = `${item.suburb} · ${item.published_count}`;
      list.append(option);
    }
    source.textContent = tr(
      `${result.suburbs.length} suburb từ listing RI-YELLOW đã xuất bản tại ${result.state} · RI-YELLOW public API`,
      `${result.suburbs.length} suburbs from published RI-YELLOW listings in ${result.state} · RI-YELLOW public API`,
    );
  } catch (error) {
    source.textContent = tr(`Không thể đọc location RI-YELLOW · ${error.code || 'UNAVAILABLE'}`, `RI-YELLOW locations unavailable · ${error.code || 'UNAVAILABLE'}`);
  }
}

async function applyLocationFilter() {
  const query = $('location-query').value.trim();
  const region = $('location-state').value;
  const selectedLocation = query ? `${query}, ${region}` : region;
  state.locationFilter = (query || region).toLowerCase();
  $('o-loc').value = query ? `${query}, ${region}` : region;
  if (state.me) refreshUnsavedChanges();
  const mapsLink = $('google-maps-link');
  mapsLink.href = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${selectedLocation}, Australia`)}`;
  mapsLink.hidden = false;
  const result = await refreshOffers();
  $('location-result').textContent = tr(
    `Đã áp dụng ${selectedLocation}: hiển thị ${result.shown}/${result.total} Offer đang mở.`,
    `Applied ${selectedLocation}: showing ${result.shown}/${result.total} open Offers.`,
  );
  setNotice(tr(`Đã dùng khu vực ${selectedLocation}.`, `Using ${selectedLocation}.`));
}
function updateIdentity() {
  const who = $('who');
  if (who) who.textContent = state.me
    ? tr(`Đã đăng nhập · ${party(state.me.participant_id)} · ${state.me.account_type}`, `Signed in · ${party(state.me.participant_id)} · ${state.me.account_type}`)
    : tr('Chưa đăng nhập', 'Not signed in');
  const openOffersCopy = $('open-offers-auth-copy');
  if (openOffersCopy) openOffersCopy.textContent = state.me
    ? tr('Bạn đã đăng nhập. Chọn một Offer để xem chi tiết và gửi đề nghị trao đổi.', 'You are signed in. Choose an offer to see details and make a proposal.')
    : openOffersCopy.dataset[state.language];
  const signOut = $('sign-out');
  const currentAccount = state.me?.display_name || state.me?.account_type || state.me?.participant_id;
  signOut.title = currentAccount ? tr(`Tài khoản hiện tại: ${currentAccount}`, `Current account: ${currentAccount}`) : '';
  signOut.setAttribute('aria-label', currentAccount ? tr(`Đăng xuất tài khoản ${currentAccount}`, `Sign out account ${currentAccount}`) : tr('Đăng xuất', 'Sign out'));
}

let draftSavePending = false;

function setWorkflowAccess() {
  const signedIn = Boolean(state.me);
  const linked = state.businessLink && state.businessLink.status !== 'NOT_REQUESTED';
  $('workflow').hidden = false;
  $('workflow').classList.toggle('public-preview', !signedIn);
  $('workflow-access-note').hidden = signedIn;
  $('login-shortcut').hidden = signedIn;
  document.querySelector('.nav-sign-in').hidden = signedIn;
  syncSignOutButton($('sign-out'), signedIn);
  $('real-only-gate').hidden = signedIn || !state.realOnly;
  renderSessionRecovery();
  for (const id of ['a-text', 'b-assist', 'o-give', 'o-receive', 'o-loc', 'o-av', 'o-pk', 'o-exp', 'b-draft']) $(id).disabled = false;
  for (const id of ['p-pk', 'b-propose']) $(id).disabled = !signedIn;
  $('b-draft').disabled = draftSavePending;
  updateDraftAction();
  $('business-id').disabled = !signedIn || linked;
  $('business-link-submit').disabled = !signedIn || linked;
  renderGuestDraftPreview();
}

function updateDraftAction() {
  const ready = Boolean(state.me && state.draftId && OFFER_FIELD_IDS.every(id => $(id).value === savedFieldValues.get(id)));
  $('b-publish').disabled = state.me ? !ready : false;
  $('open-offer-prerequisite').hidden = ready;
  if (!ready) $('open-offer-prerequisite').textContent = state.me
    ? tr('Xác nhận lưu bản nháp trước, rồi mở Offer.', 'Confirm and save the draft before opening the Offer.')
    : tr('Guest có thể xem trước; đăng nhập và xác nhận lưu trước khi mở Offer.', 'Guests can preview; sign in and confirm the save before opening the Offer.');
}

function setLoginAvailability(linkId, stateId, configured, providerName) {
  const link = $(linkId);
  link.dataset.configured = configured ? 'true' : 'false';
  link.classList.toggle('unavailable', !configured);
  link.setAttribute('aria-disabled', configured ? 'false' : 'true');
  if (configured) link.removeAttribute('tabindex'); else link.setAttribute('tabindex', '-1');
  $(stateId).textContent = configured
    ? tr(`${providerName} · sẵn sàng đăng nhập`, `${providerName} · ready to sign in`)
    : tr(`${providerName} · đang cấu hình`, `${providerName} · configuration in progress`);
}

function renderHoaMaiRuntimeStatus(meta = {}) {
  const badge = $('hoa-mai-utility-status');
  if (badge.dataset.lastSource === 'META_MUSE_SPARK_LIVE' && meta.live_call_verified === true) {
    badge.textContent = 'MUSE SPARK · LIVE RESULT';
    badge.className = 'ai-tool-status status-live';
    return;
  }
  if (meta.live_call_verified === true) {
    badge.textContent = 'META API · LIVE VERIFIED THIS PROCESS';
    badge.className = 'ai-tool-status status-live';
    return;
  }
  if (meta.configured === true) {
    badge.textContent = 'META API · CONFIGURED · LIVE UNVERIFIED';
    badge.className = 'ai-tool-status status-prepared';
    return;
  }
  badge.textContent = 'META API · NOT CONFIGURED';
  badge.className = 'ai-tool-status status-gated';
}

function renderHoaMaiExecutionDetails(result) {
  const live = result?.source === 'META_MUSE_SPARK_LIVE';
  const details = $('hoa-mai-ai-details');
  $('hoa-mai-ai-provider').textContent = live ? 'Meta Model API' : tr('Chưa xác minh', 'Unverified');
  $('hoa-mai-ai-model').textContent = result?.model || tr('Không được trả về', 'Not returned');
  $('hoa-mai-ai-source').textContent = result?.source || tr('Không được trả về', 'Not returned');
  $('hoa-mai-ai-schema').textContent = result?.terms && Array.isArray(result?.questions)
    ? tr('Đã kiểm tra · RI-SWAP Offer Assist', 'Validated · RI-SWAP Offer Assist')
    : tr('Không hợp lệ', 'Invalid');
  const observed = result?.observed_at ? new Date(result.observed_at) : null;
  $('hoa-mai-ai-observed').textContent = observed && !Number.isNaN(observed.valueOf())
    ? observed.toLocaleString(state.language === 'vi' ? 'vi-VN' : 'en-AU')
    : tr('Không được server trả về', 'Not returned by the server');
  $('hoa-mai-ai-execution').textContent = result?.execution_id || tr('Không được trả về', 'Not returned');
  $('hoa-mai-ai-route').textContent = result?.route && Number.isInteger(result?.http_status)
    ? `${result.route} · HTTP ${result.http_status}`
    : tr('Không được trả về', 'Not returned');
  const usage = result?.usage;
  $('hoa-mai-ai-usage').textContent = usage && typeof usage === 'object'
    ? `input ${usage.input_tokens ?? '—'} · output ${usage.output_tokens ?? '—'} · total ${usage.total_tokens ?? '—'}`
    : tr('Không được trả về', 'Not returned');
  details.hidden = false;
}

function setUtilityStatus(statusId, reasonId, label, className, reason) {
  const badge = $(statusId);
  badge.textContent = label;
  badge.className = `ai-tool-status ${className}`;
  $(reasonId).textContent = reason;
}

async function loadMetaUtilityStatus() {
  const note = $('meta-utilities-runtime-note');
  applyUnavailableUtilityControls(document);
  try {
    const payload = await api('GET', '/api/meta-utilities');
    const utilities = new Map((Array.isArray(payload.utilities) ? payload.utilities : []).map(item => [item.id, item]));
    const product = utilities.get('product-image');
    const voice = utilities.get('voice-transcribe');
    const search = utilities.get('web-search');

    const imageMediaReady = product?.availability === 'PRIVATE_MEDIA_READY_PROCESSING_GATED';
    setUtilityStatus(
      'product-image-status',
      'product-image-reason',
      imageMediaReady ? 'PRIVATE MEDIA READY · PROCESSING GATED' : 'COMING NEXT · IMAGE GATED',
      imageMediaReady ? 'status-prepared' : 'status-gated',
      imageMediaReady
        ? tr('Kho media riêng tư đã sẵn sàng, nhưng EXIF/GPS và xử lý SAM chưa được xác minh. Nút upload vẫn khóa.', 'Private media storage is ready, but EXIF/GPS handling and SAM processing are not verified. Upload remains locked.')
        : tr('Consumer ảnh, kho media riêng tư hoặc binding SAM chưa được xác minh. Không gửi ảnh.', 'The image consumer, private media repository, or SAM binding is not verified. No image is sent.'),
    );

    const voiceReady = voice?.availability === 'READY';
    setUtilityStatus(
      'voice-status',
      'voice-reason',
      voiceReady ? 'RUNTIME READY · UI CONSUMER PENDING' : 'COMING NEXT · VOICE GATED',
      voiceReady ? 'status-prepared' : 'status-gated',
      voiceReady
        ? tr('Provider báo sẵn sàng, nhưng consumer microphone chưa được xác minh trong UI này. Không thu hoặc gửi âm thanh.', 'The provider reports ready, but the microphone consumer is not verified in this UI. No audio is recorded or sent.')
        : tr('Schema hoặc binding provider chưa được xác minh. Microphone không mở và không có byte âm thanh nào được gửi.', 'The provider schema or binding is not verified. The microphone is not opened and no audio bytes are sent.'),
    );

    setUtilityStatus(
      'web-search-status',
      'web-search-reason',
      search?.availability === 'DISABLED_BY_DEFAULT' ? 'DISABLED BY DEFAULT' : 'COMING NEXT · SEPARATE APPROVAL',
      'status-gated',
      tr('Tắt mặc định. Chỉ truy vấn công khai đã loại dữ liệu riêng tư mới có thể được xét mở trong phạm vi được duyệt riêng.', 'Disabled by default. Only sanitised public queries may be considered under a separately approved scope.'),
    );

    note.textContent = payload.registry_is_provider_proof === false
      ? tr('Trạng thái này đến từ registry của server; registry không phải bằng chứng provider đã chạy.', 'These states come from the server registry; the registry is not proof of provider execution.')
      : tr('Không xác định được ranh giới bằng chứng của registry.', 'The registry evidence boundary is unknown.');
  } catch (error) {
    for (const [statusId, reasonId] of [
      ['product-image-status', 'product-image-reason'],
      ['voice-status', 'voice-reason'],
      ['web-search-status', 'web-search-reason'],
    ]) {
      setUtilityStatus(
        statusId,
        reasonId,
        'STATUS UNAVAILABLE',
        'status-gated',
        tr('Không đọc được trạng thái runtime. Tiện ích vẫn khóa và không gửi dữ liệu.', 'Runtime status could not be read. The utility remains locked and sends no data.'),
      );
    }
    note.textContent = tr(`Không đọc được trạng thái utility: ${error.code || 'UNKNOWN'}`, `Could not read utility status: ${error.code || 'UNKNOWN'}`);
  }
}

async function loadStatus() {
  const status = await api('GET', '/api/status');
  const meta = status.meta || {};
  const storage = status.storage || {};
  const directory = status.ri_yellow_directory || {};
  const knowledge = status.knowledge || {};
  const kos = status.ri_kos || {};
  const bca = status.ri_bca || {};
  const ws = status.ri_work_studio || {};
  const riYellowLogin = typeof status.ri_yellow_login === 'object' ? status.ri_yellow_login : {};
  const facebook = typeof status.facebook_login === 'object' ? status.facebook_login : { connection: status.facebook_login, configured: false };
  const google = typeof status.google_login === 'object' ? status.google_login : { connection: status.google_login, configured: false };
  renderHoaMaiRuntimeStatus(meta);
  await loadMetaUtilityStatus();
  const riYellowBoundary = riYellowLoginBoundary(state.language, riYellowLogin);
  state.realOnly = status.real_only === true;
  state.riYellowLoginConfigured = riYellowBoundary.configured;
  state.facebookLoginConfigured = facebook.configured === true;
  state.googleLoginConfigured = google.configured === true;
  $('real-only-gate').hidden = !state.realOnly;
  const riYellowLink = $('ri-yellow-login-link');
  riYellowLink.href = riYellowBoundary.href;
  riYellowLink.dataset.configured = riYellowBoundary.configured ? 'true' : 'false';
  riYellowLink.classList.toggle('unavailable', !riYellowBoundary.configured);
  riYellowLink.setAttribute('aria-disabled', riYellowBoundary.configured ? 'false' : 'true');
  if (riYellowBoundary.configured) riYellowLink.removeAttribute('tabindex'); else riYellowLink.setAttribute('tabindex', '-1');
  $('ri-yellow-login-state').textContent = riYellowBoundary.label;
  setLoginAvailability('real-login-link', 'facebook-login-state', state.facebookLoginConfigured, 'Facebook Login');
  setLoginAvailability('google-login-link', 'google-login-state', state.googleLoginConfigured, 'Google Login');
  setWorkflowAccess();
  const blockers = $('real-only-blockers');
  blockers.replaceChildren();
  if (state.realOnly) {
    const gaps = [];
    if (!state.riYellowLoginConfigured && !state.facebookLoginConfigured && !state.googleLoginConfigured) gaps.push(tr('Danh tính thật: WAIT_REAL_IDENTITY_PROVIDER', 'Real identity: WAIT_REAL_IDENTITY_PROVIDER'));
    if (facebook.business_ownership_verified !== true) gaps.push(tr('Quyền doanh nghiệp RI-YELLOW: NOT_VERIFIED', 'RI-YELLOW business authority: NOT_VERIFIED'));
    if (kos.connection !== 'CONNECTED_READY_VERIFIED') gaps.push(`RI-KOS: ${kos.connection || 'NOT_CONNECTED'}`);
    if (ws.public_api_live_verified !== true) gaps.push(`RI Work Studio API: ${ws.connection || 'NOT_CONNECTED'}`);
    for (const gap of gaps) blockers.append(el('li', gap));
  }
  const storageLabel = typeof storage === 'string'
    ? storage
    : `${storage.engine || 'UNKNOWN'} · ${storage.mode || 'UNKNOWN'} · ${storage.database_connected ? `DB connected · rev ${storage.revision}` : 'DB not connected'} · fallback ${storage.fallback || 'UNKNOWN'}`;
  const kosLabel = kos.connection === 'CONNECTED_READY_VERIFIED'
    ? tr(
      `Ready đã xác minh · assistant ${kos.assistant_binding || 'UNKNOWN'} · tri thức ${kos.knowledge_available === true ? 'sẵn sàng' : kos.knowledge_available === false ? 'chưa sẵn sàng' : 'chưa xác định'}`,
      `Ready verified · assistant ${kos.assistant_binding || 'UNKNOWN'} · knowledge ${kos.knowledge_available === true ? 'available' : kos.knowledge_available === false ? 'unavailable' : 'unknown'}`,
    )
    : kos.connection === 'CREDENTIAL_BINDING_INCOMPLETE'
      ? tr('Thiếu một phần binding/credential của assistant', 'Assistant binding/credential incomplete')
      : kos.connection === 'CONFIGURED_UNAVAILABLE'
        ? tr(`Đã cấu hình nhưng endpoint không sẵn sàng · ${kos.last_error || 'UNKNOWN'}`, `Configured but endpoint unavailable · ${kos.last_error || 'UNKNOWN'}`)
        : kos.connection || 'NOT_CONNECTED';
  const workStudioLabel = ws.public_api_live_verified
    ? tr('Public API chỉ đọc đã xác minh · import chưa kết nối', 'Public read-only API verified · import not connected')
    : ws.connection === 'PUBLIC_API_UNAVAILABLE'
      ? tr(`Public API không sẵn sàng · ${ws.last_error || 'UNKNOWN'}`, `Public API unavailable · ${ws.last_error || 'UNKNOWN'}`)
      : ws.connection || 'DRAFT_PACKAGE_ONLY';
  const values = [
    ['AUTH', status.auth],
    ['RI-YELLOW Login', riYellowLogin.live_login_verified
      ? tr('WhatsApp OTP thật đã xác minh · quyền doanh nghiệp vẫn chờ riêng', 'Live WhatsApp OTP verified · business authority remains separately pending')
      : riYellowBoundary.configured
        ? tr('Đã cấu hình · chờ một lần đăng nhập thật', 'Configured · awaiting one real login')
        : tr('Chưa cấu hình đầy đủ', 'Not fully configured')],
    ['Facebook Login', facebook.live_login_verified
      ? tr('Đăng nhập thật đã xác minh · quyền sở hữu doanh nghiệp chưa xác minh', 'Live login verified · business ownership unverified')
      : facebook.configured
        ? tr('Đã cấu hình · chờ một lần đăng nhập thật', 'Configured · awaiting one real login')
        : tr('Chưa cấu hình đầy đủ', 'Not fully configured')],
    ['Google Login', google.live_login_verified
      ? tr('Đăng nhập thật đã xác minh · quyền sở hữu doanh nghiệp chưa xác minh', 'Live login verified · business ownership unverified')
      : google.configured
        ? tr('Đã cấu hình · chờ một lần đăng nhập thật', 'Configured · awaiting one real login')
        : tr('Chưa cấu hình đầy đủ', 'Not fully configured')],
    ['RI-YELLOW', directory.verified
      ? tr('Kết nối chỉ đọc đã xác minh · quyền sở hữu chưa xác minh', 'Read-only connection verified · ownership unverified')
      : status.ri_yellow_registration === 'NOT_CONNECTED'
        ? tr('Chưa kết nối', 'Not connected')
        : tr('Đã cấu hình chỉ đọc · kết nối chưa xác minh', 'Read-only configured · connection unverified')],
    ['Meta API', meta.live_call_verified
      ? tr('Live call đã xác minh', 'Live call verified')
      : meta.configured
        ? tr('Đã có key · live chưa xác minh', 'Key present · live unverified')
        : tr('Chưa có key', 'No key')],
    ['Model', meta.model || 'muse-spark-1.3'],
    ['Storage', storageLabel],
    ['Data boundary', status.data],
    ['RKB JSON', `${knowledge.source_check || 'UNKNOWN'} · ${knowledge.provenance || 'LOCAL_CANDIDATE'}`],
    ['RI-KOS', kosLabel],
    ['RI-BCA', bca.live_call_verified ? tr('Live call đã xác minh', 'Live call verified') : (bca.configured ? tr('Đã cấu hình · live chưa xác minh', 'Configured · live unverified') : 'NOT_CONNECTED')],
    ['RI Work Studio', workStudioLabel],
  ];
  const box = $('banner'); box.replaceChildren();
  for (const [label, value] of values) {
    const chip = el('span', undefined, { className: `status-chip${/WAIT_|NOT_|IN_MEMORY|SYNTHETIC|STALE|DRAFT_|unverified|not connected|chưa xác minh/i.test(value) ? ' warn' : ''}` });
    chip.append(el('b', label), el('span', value)); box.append(chip);
  }
}

async function restoreBrowserSession() {
  const sessionEpoch = state.sessionEpoch;
  const res = await fetch(`${API_ROOT}/api/me`, { headers: { accept: 'application/json' } });
  if (sessionEpoch !== state.sessionEpoch) return false;
  state.sessionRestoreError = null;
  if (!res.ok) return false;
  const me = await readJsonObject(res);
  if (sessionEpoch !== state.sessionEpoch) return false;
  if (!me || typeof me.participant_id !== 'string' || !me.participant_id.trim() || typeof me.account_type !== 'string' || !me.account_type.trim()) {
    clearClientSession(state);
    state.sessionExpired = true;
    state.sessionRestoreError = 'SESSION_RESPONSE_INVALID';
    showExpiredSession();
    setNotice(tr('Không thể xác nhận phiên đăng nhập. Nội dung chưa gửi vẫn ở đây; hãy đăng nhập lại rồi kiểm tra phiên.', 'Could not verify the sign-in session. Your unsent text remains here; sign in again and check the session.'), true);
    return false;
  }
  if (state.me?.participant_id && state.me.participant_id !== me.participant_id) state.draftId = null;
  state.me = me;
  state.businessLink = state.me.business_link;
  state.sessionExpired = false;
  state.sessionRestoreError = null;
  updateIdentity();
  renderBusinessLink(state.businessLink);
  setWorkflowAccess();
  await refreshAll();
  return true;
}

function renderBusinessLink(link) {
  const host = $('business-link-result');
  if (!host) return;
  if (!link || link.status === 'NOT_REQUESTED') {
    host.textContent = tr('Chưa có yêu cầu liên kết doanh nghiệp.', 'No business link has been requested.');
    return;
  }
  host.textContent = tr(
    `${link.trading_name || link.business_id} · ${link.status} · quyền sở hữu chưa xác minh · chưa đủ điều kiện giao dịch doanh nghiệp`,
    `${link.trading_name || link.business_id} · ${link.status} · ownership unverified · not eligible for business transactions`,
  );
  $('business-id').value = link.business_id || '';
  $('business-id').disabled = true;
  $('business-link-submit').disabled = true;
}

async function refreshOffers() {
  const requestId = ++state.offersRequestId;
  state.offersLoading = true;
  state.offersError = null;
  $('b-refresh').disabled = true;
  renderOffers();
  try {
    const result = await api('GET', '/api/offers');
    if (requestId !== state.offersRequestId) return offerCounts();
    if (!Array.isArray(result.offers)) throw Object.assign(new Error('Offer list is unavailable'), { code: 'OFFERS_INVALID_RESPONSE' });
    state.offers = result.offers;
    state.offersLastUpdatedAt = new Date();
    state.offersStale = false;
    if (state.offer) state.offer = state.offers.find(offer => offer.offer_id === state.offer.offer_id) || null;
    return renderOffers();
  } catch (error) {
    if (requestId === state.offersRequestId) {
      state.offersError = error;
      state.offersStale = state.offers.length > 0;
      renderOffers();
    }
    throw error;
  } finally {
    if (requestId === state.offersRequestId) {
      state.offersLoading = false;
      $('b-refresh').disabled = false;
      renderOffers();
    }
  }
}

function visibleOffers() {
  return filterPublicOffers(state.offers, { search: state.offerSearch, location: state.locationFilter });
}

function offerCounts() {
  return { shown: visibleOffers().length, total: state.offers.length };
}

function offerStateMessage(kind, shown, loaded) {
  const filtered = Boolean(state.offerSearch || state.locationFilter);
  const messages = {
    LOADING: tr('Đang tải Offer công khai…', 'Loading public Offers…'),
    EMPTY: tr('Chưa có Offer đang mở.', 'No open offers yet.'),
    NO_MATCH: tr('Không có Offer phù hợp. Hãy xóa tìm kiếm hoặc đổi khu vực.', 'No offers match. Clear the search or change location.'),
    ERROR: tr('Không thể tải Offer. Hãy thử lại.', 'Open Offers could not be loaded. Try again.'),
    STALE: tr(`Không thể làm mới. Đang hiển thị ${shown} kết quả từ lần tải thành công gần nhất.`, `Refresh failed. Showing ${shown} results from the last successful load.`),
    POPULATED: filtered
      ? tr(`Đang hiển thị ${shown} trong ${loaded} Offer đã tải.`, `Showing ${shown} of ${loaded} loaded Offers.`)
      : tr(`${shown} Offer đang mở đã tải.`, `${shown} open Offers loaded.`),
  };
  return messages[kind];
}

function offerMetaText(meta) {
  if (meta.key === 'packages') return tr(`${meta.remaining}/${meta.total} gói còn lại`, `${meta.remaining}/${meta.total} packages left`);
  if (meta.key === 'version') return `v${meta.value}`;
  if (meta.key === 'time') {
    const date = new Date(meta.value);
    return Number.isNaN(date.valueOf()) ? meta.value : date.toLocaleString(state.language === 'vi' ? 'vi-VN' : 'en-AU', { dateStyle: 'medium', timeStyle: 'short' });
  }
  return meta.value;
}

function publicTermsText(terms = {}) {
  const parts = [];
  if (terms.give) parts.push(tr(`Trao: ${terms.give}`, `Give: ${terms.give}`));
  if (terms.receive) parts.push(tr(`Cần: ${terms.receive}`, `Receive: ${terms.receive}`));
  if (terms.location) parts.push(tr(`Tại: ${terms.location}`, `At: ${terms.location}`));
  if (terms.availability) parts.push(String(terms.availability));
  return parts.join(' · ') || tr('Điều khoản công khai chưa có sẵn.', 'Public terms are unavailable.');
}

async function selectPublicOffer(offer, action) {
  const actionKey = offer.offer_id || String(state.offers.indexOf(offer));
  if (state.offerActionPending.has(actionKey)) return;
  state.offerActionPending.add(actionKey);
  state.offer = offer;
  renderOffers();
  try {
    await refreshProposals();
    if (action === 'proposal') {
      if (!state.me) {
        setNotice(tr('Offer đã được giữ trong phiên này. Hãy đăng nhập thật để gửi Proposal.', 'The Offer is retained in this session. Sign in with a real identity to submit a Proposal.'));
        $('real-only-gate').scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
      }
      $('proposal-title').scrollIntoView({ behavior: 'smooth', block: 'start' });
      $('p-pk').focus();
    } else {
      setNotice(tr('Đã chọn Offer để xem trong phiên này.', 'Offer selected for this session.'));
    }
  } finally {
    state.offerActionPending.delete(actionKey);
    renderOffers();
  }
}

function renderOffers() {
  const offers = visibleOffers();
  const loaded = state.offers.length;
  const filtered = Boolean(state.offerSearch || state.locationFilter);
  const kind = classifyOfferList({ loading: state.offersLoading, error: state.offersError, stale: state.offersStale, loaded, shown: offers.length, filtered });
  const box = $('offers');
  const host = $('open-offers');
  host.setAttribute('aria-busy', state.offersLoading ? 'true' : 'false');
  box.replaceChildren();
  const summary = $('offers-summary');
  const hasStateCard = ['LOADING', 'EMPTY', 'NO_MATCH', 'ERROR'].includes(kind);
  summary.hidden = hasStateCard;
  summary.textContent = hasStateCard ? '' : offerStateMessage(kind, offers.length, loaded);
  summary.dataset.state = kind;
  const updated = $('offers-updated');
  if (state.offersLastUpdatedAt) {
    updated.hidden = false;
    updated.dateTime = state.offersLastUpdatedAt.toISOString();
    updated.textContent = tr(`Cập nhật ${state.offersLastUpdatedAt.toLocaleTimeString('vi-VN')}`, `Updated ${state.offersLastUpdatedAt.toLocaleTimeString('en-AU')}`);
  } else updated.hidden = true;
  if (hasStateCard) {
    box.append(el('div', offerStateMessage(kind, offers.length, loaded), { className: 'empty offer-list-message' }));
    return { shown: offers.length, total: loaded };
  }
  for (const offer of offers) {
    const selected = state.offer?.offer_id === offer.offer_id;
    const card = el('article', undefined, { className: 'open-offer-card' });
    card.setAttribute('aria-current', selected ? 'true' : 'false');
    card.append(el('div', '↔', { className: 'open-offer-icon', ariaHidden: 'true' }));
    const body = el('div', undefined, { className: 'open-offer-body' });
    const displayLabel = offer.public_display_label || offer.display_label;
    if (displayLabel) body.append(el('p', displayLabel, { className: 'open-offer-label' }));
    body.append(el('p', publicTermsText(offer.terms), { className: 'open-offer-terms' }));
    const meta = el('div', undefined, { className: 'open-offer-meta' });
    for (const item of publicOfferMeta(offer)) meta.append(el('span', offerMetaText(item)));
    if (meta.childNodes.length) body.append(meta);
    card.append(body);
    const actions = el('div', undefined, { className: 'open-offer-actions' });
    const view = el('button', tr('Xem Offer', 'View offer'), { className: 'secondary', type: 'button' });
    const propose = el('button', tr('Gửi Proposal', 'Submit proposal'), { type: 'button' });
    const actionKey = offer.offer_id || String(state.offers.indexOf(offer));
    const pending = state.offerActionPending.has(actionKey);
    view.disabled = pending;
    propose.disabled = pending;
    view.onclick = guard(() => selectPublicOffer(offer, 'view'));
    propose.onclick = guard(() => selectPublicOffer(offer, 'proposal'));
    actions.append(view, propose);
    card.append(actions);
    box.append(card);
  }
  return { shown: offers.length, total: loaded };
}

function counterForm(proposal, host) {
  const form = el('form', undefined, { className: 'inline-form' });
  const give = el('input', undefined, { value: proposal.terms.give, maxLength: 300 });
  const receive = el('input', undefined, { value: proposal.terms.receive, maxLength: 300 });
  const packages = el('input', undefined, { value: String(proposal.packages), type: 'number', min: '1' });
  const giveLabel = el('label'); giveLabel.append(el('span', tr('Bên A trao', 'Party A gives')), give);
  const receiveLabel = el('label'); receiveLabel.append(el('span', tr('Bên A nhận', 'Party A receives')), receive);
  const packageLabel = el('label'); packageLabel.append(el('span', tr('Số gói', 'Packages')), packages);
  const actions = el('div', undefined, { className: 'actions wide' });
  const cancel = el('button', tr('Hủy', 'Cancel'), { className: 'secondary', type: 'button' });
  const save = el('button', tr('Gửi Counteroffer', 'Send counteroffer'), { type: 'submit' });
  cancel.onclick = () => form.remove();
  actions.append(cancel, save); form.append(giveLabel, receiveLabel, packageLabel, actions);
  form.onsubmit = guard(async event => {
    event.preventDefault();
    await api('POST', `/api/proposals/${proposal.proposal_id}/counter`, { terms: { ...proposal.terms, give: give.value.trim(), receive: receive.value.trim() }, packages: Number(packages.value) });
    setNotice(tr('Counteroffer mới đã được ghi riêng cho Proposal này.', 'The new counteroffer was recorded only for this Proposal.'));
    await refreshAll();
  });
  host.append(form); give.focus();
}

async function refreshProposals() {
  const offer = state.offer; const box = $('props'); box.replaceChildren();
  $('b-close-offer').hidden = true;
  if (!offer) return;
  $('sel').textContent = tr(`Đã chọn: ${termsText(offer.terms)} · còn ${offer.packages_remaining} gói`, `Selected: ${termsText(offer.terms)} · ${offer.packages_remaining} left`);
  if (!state.token && !state.me) return box.append(el('div', tr('Đăng nhập thật để xem Proposal.', 'Use a real login to view Proposals.'), { className: 'empty' }));
  state.offerDetail = await api('GET', `/api/offers/${offer.offer_id}`);
  const owner = state.offerDetail.owner_id === state.me.participant_id;
  $('b-close-offer').hidden = !owner;
  const { proposals } = await api('GET', `/api/offers/${offer.offer_id}/proposals`);
  if (!proposals.length) return box.append(el('div', tr('Chưa có Proposal cho Offer này.', 'No Proposals for this Offer yet.'), { className: 'empty' }));
  for (const proposal of proposals) {
    const card = el('article', undefined, { className: 'item' });
    const acceptanceState = proposal.status === 'AGREED'
      ? tr('Hai bên đã chấp thuận · Agreement Reached', 'Both parties accepted · Agreement Reached')
      : tr('Đang chờ đủ hai chấp thuận', 'Awaiting both acceptances');
    card.append(
      el('div', tr(`Đề nghị v${proposal.version} · ${proposal.packages} gói`, `Proposal v${proposal.version} · ${proposal.packages} packages`), { className: 'item-title' }),
      el('div', tr(`Bên A: ${party(proposal.owner_id)} · Bên B: ${party(proposal.counterparty_id)}`, `Party A: ${party(proposal.owner_id)} · Party B: ${party(proposal.counterparty_id)}`), { className: 'item-meta' }),
      el('div', termsText(proposal.terms)),
      el('div', acceptanceState, { className: 'item-meta' }),
    );
    const verification = el('details', undefined, { className: 'proposal-verification' });
    verification.append(
      el('summary', tr('Chi tiết phiên bản', 'Version details')),
      el('div', `hash ${String(proposal.content_hash).slice(0, 16)}…`, { className: 'mono muted' }),
    );
    card.append(verification);
    if (proposal.status !== 'AGREED') {
      const actions = el('div', undefined, { className: 'item-actions' });
      const acceptButton = el('button', tr(`Xem lại & Accept v${proposal.version}`, `Review & Accept v${proposal.version}`));
      const counterButton = el('button', tr('Tạo Counteroffer', 'Create counteroffer'), { className: 'secondary' });
      acceptButton.onclick = () => openAcceptance(proposal);
      counterButton.onclick = () => { if (!card.querySelector('form')) counterForm(proposal, card); };
      actions.append(acceptButton, counterButton); card.append(actions);
    }
    box.append(card);
  }
}

function reviewRow(label, value) {
  $('accept-review').append(el('dt', label), el('dd', value));
}
function openAcceptance(proposal) {
  state.pendingAccept = proposal;
  $('accept-review').replaceChildren();
  reviewRow(tr('Bên A', 'Party A'), party(proposal.owner_id));
  reviewRow(tr('Bên B', 'Party B'), party(proposal.counterparty_id));
  reviewRow('Proposal version', String(proposal.version));
  reviewRow(tr('Nội dung', 'Terms'), termsText(proposal.terms));
  reviewRow(tr('Phân bổ', 'Allocation'), tr(`${proposal.packages} gói`, `${proposal.packages} package(s)`));
  reviewRow('Outcome scope', 'AGREEMENT_REACHED only');
  const dialog = $('accept-dialog');
  if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', '');
}

// One idempotency key per proposal version. An unknown response is resolved with the same key.
async function accept(proposal) {
  const slot = `${proposal.proposal_id}:${proposal.version}`;
  if (!state.keys.has(slot)) state.keys.set(slot, crypto.randomUUID());
  const key = state.keys.get(slot);
  try {
    const result = await api('POST', `/api/proposals/${proposal.proposal_id}/accept`, { version: proposal.version, idempotency_key: key });
    setNotice(result.status === 'AGREEMENT_COMMITTED'
      ? tr(`Agreement ${result.agreement.agreement_id.slice(0, 8)} đã được tạo.`, `Agreement ${result.agreement.agreement_id.slice(0, 8)} was created.`)
      : tr('Acceptance đã ghi. Đang chờ bên còn lại Accept cùng version.', 'Acceptance recorded. Waiting for the other party to accept the same version.'));
  } catch (error) {
    if (error.status !== undefined) throw error;
    setNotice(tr('Verification Pending: đang đọc lại bằng cùng idempotency key.', 'Verification Pending: reading back with the same idempotency key.'));
    const result = await api('POST', `/api/proposals/${proposal.proposal_id}/resolve`, { idempotency_key: key });
    setNotice(result.status === 'COMMITTED' ? tr(`Đã phục hồi Agreement ${result.agreement_id.slice(0, 8)}.`, `Recovered Agreement ${result.agreement_id.slice(0, 8)}.`) : tr('Chưa commit; có thể thử lại bằng cùng key.', 'Not committed; retry with the same key is safe.'));
  }
  await refreshAll();
}

function issueForm(agreement, host) {
  const form = el('form', undefined, { className: 'inline-form' });
  const reason = el('textarea', undefined, { rows: 3, maxLength: 500, placeholder: tr('Mô tả vấn đề cần ghi nhận…', 'Describe the issue to record…') });
  const label = el('label', undefined, { className: 'wide' }); label.append(el('span', tr('Nội dung ghi nhận', 'Issue record')), reason);
  const actions = el('div', undefined, { className: 'actions wide' });
  const cancel = el('button', tr('Hủy', 'Cancel'), { type: 'button', className: 'secondary' });
  const send = el('button', tr('Ghi nhận vấn đề', 'Record issue'), { type: 'submit' });
  cancel.onclick = () => form.remove(); actions.append(cancel, send); form.append(label, actions);
  form.onsubmit = guard(async event => {
    event.preventDefault();
    if (!reason.value.trim()) return setNotice(tr('Vui lòng mô tả vấn đề.', 'Please describe the issue.'), true);
    await api('POST', `/api/agreements/${agreement.agreement_id}/report`, { kind: 'REPORT_ISSUE', reason: reason.value.trim() });
    setNotice(tr('Đã ghi nhận yêu cầu; chưa có phạt hay kết luận lỗi.', 'Request recorded; no penalty or fault finding was applied.'));
    form.remove();
  });
  host.append(form); reason.focus();
}

async function refreshAgreements() {
  const box = $('agrs'); box.replaceChildren();
  if (!state.token && !state.me) return box.append(el('div', tr('Đăng nhập thật để xem Agreement.', 'Use a real login to view Agreements.'), { className: 'empty' }));
  const { agreements } = await api('GET', '/api/agreements');
  if (!agreements.length) return box.append(el('div', tr('Chưa có Agreement.', 'No Agreements yet.'), { className: 'empty' }));
  for (const agreement of agreements) {
    const card = el('article', undefined, { className: 'item' });
    card.append(
      el('div', `Agreement ${agreement.agreement_id.slice(0, 8)}…`, { className: 'item-title mono' }),
      el('div', `${party(agreement.parties[0])} ↔ ${party(agreement.parties[1])}`, { className: 'item-meta' }),
      el('div', tr(`${agreement.packages} gói · ${termsText(agreement.agreed_terms)}`, `${agreement.packages} package(s) · ${termsText(agreement.agreed_terms)}`)),
    );
    const output = el('div', '', { className: 'mono' });
    const actions = el('div', undefined, { className: 'item-actions' });
    const verify = el('button', tr('Verify · đọc lại', 'Verify · readback'));
    const report = el('button', tr('Báo vấn đề', 'Report issue'), { className: 'secondary' });
    const workStudio = el('button', tr('Xuất draft Work Studio', 'Export Work Studio draft'), { className: 'secondary' });
    verify.onclick = guard(async () => {
      const result = await api('GET', `/api/agreements/${agreement.agreement_id}/verify`);
      output.className = `mono ${result.vo ? 'ok' : 'bad'}`;
      output.textContent = `${result.vo ? 'VERIFIED' : 'NOT VERIFIED'} · scope ${result.scope} · ${result.verifier_version} · ${result.reasons.join(', ')}`;
    });
    report.onclick = () => { if (!card.querySelector('form')) issueForm(agreement, card); };
    workStudio.onclick = guard(async () => {
      const result = await api('GET', `/api/agreements/${agreement.agreement_id}/work-studio-package`);
      output.className = 'mono';
      output.textContent = `${result.status} · ${result.schema} · external execution ${result.external_execution_performed}`;
    });
    actions.append(verify, report, workStudio); card.append(actions, output); box.append(card);
  }
}

async function refreshAll() { await refreshOffers(); await refreshProposals(); await refreshAgreements(); }

const offerBody = () => ({
  terms: { give: $('o-give').value.trim(), receive: $('o-receive').value.trim(), location: $('o-loc').value.trim(), availability: $('o-av').value.trim() },
  packages_total: Number($('o-pk').value),
  expires_at: new Date(Date.now() + Number($('o-exp').value) * 3600e3).toISOString(),
});

const signOut = createSignOutFlow({
  button: $('sign-out'),
  beforeRequest: () => !state.unsavedChanges || window.confirm(tr('Bạn có thay đổi chưa lưu. Đăng xuất và bỏ các thay đổi này?', 'You have unsaved changes. Sign out and discard them?')),
  request: async () => {
    const result = await api('POST', '/api/auth/logout');
    if (result.ok !== true) throw Object.assign(new Error('Sign-out response not confirmed'), { code: 'LOGOUT_NOT_CONFIRMED' });
  },
  onSuccess: () => {
    clearClientSession(state);
    for (const id of [...UNSAVED_FIELD_IDS, 'ri-yellow-business-ref', 'ri-yellow-otp-code']) $(id).value = ['o-pk', 'o-exp'].includes(id) ? $(id).defaultValue : '';
    markFieldsSaved();
    for (const id of ['props', 'agrs', 'knowledge-answer', 'accept-review', 'log']) $(id).replaceChildren();
    for (const id of ['o-state', 'a-out', 'business-link-result']) $(id).textContent = '';
    $('sel').textContent = tr('Hãy chọn một Offer trước.', 'Select an Offer first.');
    $('p-pk').value = '1';
    $('business-link-details').open = false;
    if ($('accept-dialog').open) $('accept-dialog').close();
    if ($('ri-yellow-login-dialog').open) $('ri-yellow-login-dialog').close();
    setWorkflowAccess();
    updateIdentity();
    renderOffers();
    setNotice(tr('Đã đăng xuất khỏi RI-SWAP. Phiên của nhà cung cấp đăng nhập được quản lý riêng.', 'Signed out of RI-SWAP. Your sign-in provider manages its own session.'));
    $('real-only-gate').scrollIntoView({ block: 'start' });
    const mobileShortcut = $('login-shortcut');
    const focusTarget = getComputedStyle(mobileShortcut).display === 'none' ? document.querySelector('.nav-sign-in') : mobileShortcut;
    focusTarget?.focus();
  },
  onError: error => {
    if (error.code === 'CLIENT_SESSION_CHANGED') return;
    log(`SIGN_OUT_UNCONFIRMED ${error.code || 'NETWORK'}`);
    setNotice(tr('Chưa xác nhận đăng xuất. Hãy thử lại hoặc tải lại trang để kiểm tra phiên.', 'Sign-out was not confirmed. Retry or reload to check your session.'), true);
  },
});
$('sign-out').onclick = signOut;
async function recheckSession() {
  const restored = await restoreBrowserSession();
  if (!restored) {
    if (state.sessionRestoreError === 'SESSION_RESPONSE_INVALID') return;
    setNotice(tr('Chưa có phiên RI-SWAP mới. Hãy đăng nhập ở một tab khác rồi quay lại kiểm tra.', 'No new RI-SWAP session was found. Sign in in another tab, then return to check.'), true);
    return;
  }
  refreshUnsavedChanges();
  setNotice(tr('Đã đọc lại phiên mới. Nội dung chưa gửi vẫn ở đây; chỉ gửi khi bạn tự bấm nút.', 'New session confirmed. Your unsent text remains here; it will be sent only if you choose to submit it.'));
  $('a-text').focus();
}
$('recheck-session').onclick = guard(recheckSession);
for (const id of UNSAVED_FIELD_IDS) {
  $(id).addEventListener('input', () => {
    if (state.me) refreshUnsavedChanges();
    if (OFFER_FIELD_IDS.includes(id)) {
      updateDraftAction();
      renderGuestDraftPreview();
    }
  });
}

$('language-toggle').onclick = () => { state.language = state.language === 'vi' ? 'en' : 'vi'; applyLanguage(); loadStatus().catch(() => {}); };
$('ri-yellow-login-link').onclick = event => {
  event.preventDefault();
  if (!state.riYellowLoginConfigured) {
    setNotice(tr('RI-YELLOW WhatsApp OTP chưa được cấu hình đầy đủ. Không có đăng nhập dự phòng.', 'RI-YELLOW WhatsApp OTP is not fully configured. There is no fallback login.'), true);
    return;
  }
  state.riYellowChallenge = null;
  $('ri-yellow-otp-step').hidden = true;
  $('ri-yellow-otp-code').value = '';
  $('ri-yellow-login-dialog').showModal();
};
$('ri-yellow-login-form').onsubmit = guard(async event => {
  event.preventDefault();
  const button = $('ri-yellow-send-otp');
  button.disabled = true;
  try {
    const result = await api('POST', '/api/auth/ri-yellow/start', { business_ref: $('ri-yellow-business-ref').value.trim() });
    state.riYellowChallenge = result.challenge_id;
    $('ri-yellow-otp-hint').textContent = tr(
      `Mã đã được gửi qua WhatsApp đến số kết thúc bằng ${result.destination_hint}. Mã hết hạn sau ${result.expires_in_seconds} giây.`,
      `A code was sent by WhatsApp to the number ending ${result.destination_hint}. It expires in ${result.expires_in_seconds} seconds.`,
    );
    $('ri-yellow-otp-step').hidden = false;
    $('ri-yellow-otp-code').focus();
  } finally {
    button.disabled = false;
  }
});
$('ri-yellow-verify-otp').onclick = guard(async () => {
  if (!state.riYellowChallenge) throw new Error(tr('Hãy yêu cầu mã OTP trước', 'Request an OTP first'));
  const button = $('ri-yellow-verify-otp');
  button.disabled = true;
  try {
    await api('POST', '/api/auth/ri-yellow/verify', { challenge_id: state.riYellowChallenge, code: $('ri-yellow-otp-code').value.trim() });
    if (state.sessionExpired) { $('ri-yellow-login-dialog').close(); await recheckSession(); }
    else window.location.reload();
  } finally {
    button.disabled = false;
  }
});
$('ri-yellow-login-cancel').onclick = () => $('ri-yellow-login-dialog').close();
for (const id of ['real-login-link', 'google-login-link']) {
  $(id).onclick = event => {
    if ($(id).dataset.configured === 'true') return;
    event.preventDefault();
    setNotice(tr('Nhà cung cấp đăng nhập này đang được cấu hình. Chưa có credential nào được gửi tới trình duyệt.', 'This login provider is being configured. No credential is exposed to the browser.'), true);
  };
}
$('location-state').onchange = guard(async () => {
  $('location-query').value = '';
  state.locationFilter = '';
  $('location-result').textContent = '';
  $('google-maps-link').hidden = true;
  await loadLocationOptions();
  await refreshOffers();
});
$('apply-location').onclick = guard(applyLocationFilter);
$('business-link-form').onsubmit = guard(async event => {
  event.preventDefault();
  const button = $('business-link-submit');
  button.disabled = true;
  const businessIdInput = $('business-id').value;
  const businessId = businessIdInput.trim();
  try {
    state.businessLink = await api('POST', '/api/business-links', { business_id: businessId });
    markFieldSaved('business-id', businessIdInput);
    renderBusinessLink(state.businessLink);
    setNotice(tr('Đã ghi yêu cầu OWNERSHIP_PENDING. Chưa có quyền doanh nghiệp nào được cấp.', 'The OWNERSHIP_PENDING request was recorded. No business authority was granted.'));
  } finally {
    if (state.businessLink?.status !== 'OWNERSHIP_PENDING') button.disabled = false;
  }
});
$('offer-search').oninput = event => { state.offerSearch = event.target.value; renderOffers(); };
$('b-clear-offer-search').onclick = () => { $('offer-search').value = ''; state.offerSearch = ''; renderOffers(); $('offer-search').focus(); };
$('b-refresh').onclick = guard(refreshOffers);
async function saveDraftToServer() {
  if (draftSavePending) return;
  draftSavePending = true;
  $('b-draft').disabled = true;
  $('confirm-draft-save').disabled = true;
  try {
    const actor = await api('GET', '/api/me');
    if (!actor?.participant_id || actor.participant_id !== state.me?.participant_id) {
      throw Object.assign(new Error('authenticated actor readback mismatch'), { code: 'RECEIPT_READBACK_MISMATCH' });
    }
    const pendingGuestDraft = readGuestDraft();
    const draftId = state.draftId;
    if (draftId && pendingGuestDraft) {
      throw Object.assign(new Error('guest confirmation cannot target a previously selected draft'), { code: 'RECEIPT_ACTION_BINDING_MISMATCH' });
    }
    const offer = offerBody();
    const currentDraft = draftId ? await api('GET', `/api/offers/${draftId}`) : null;
    const expected = canonicalConfirmedOffer(draftId
      ? { terms: offer.terms, packages_total: currentDraft.packages_total, expires_at: currentDraft.expires_at }
      : offer);
    if (!draftId) {
      const slot = 'CREATE_OFFER_DRAFT';
      const createKey = pendingGuestDraft?.idempotency_key || state.keys.get(slot) || crypto.randomUUID();
      state.keys.set(slot, createKey);
      offer.idempotency_key = createKey;
    }
    const submittedValues = new Map(OFFER_FIELD_IDS.map(id => [id, $(id).value]));
    if (draftId) {
      const result = await api('PUT', `/api/offers/${draftId}`, { terms: offer.terms });
      const readback = await api('GET', `/api/offers/${draftId}`);
      const receiptMatches = await validateDraftReceipt({ actor, result, readback, expected });
      if (!receiptMatches
        || result.offer_id !== draftId
        || readback.offer_id !== draftId
        || result.status !== 'DRAFT'
        || result.version !== currentDraft.version + 1) {
        throw Object.assign(new Error('authenticated draft edit receipt/readback mismatch'), { code: 'RECEIPT_ACTION_BINDING_MISMATCH' });
      }
      state.draftId = draftId;
      for (const [id, value] of submittedValues) markFieldSaved(id, value);
      updateDraftAction();
      $('o-state').textContent = tr(`LOCAL/API_READBACK_ONLY · DATABASE_RECEIPT_NOT_VERIFIED · Draft ${draftId.slice(0, 8)} v${result.version} đã khớp target, identity, nội dung và hash trong API readback.`, `LOCAL/API_READBACK_ONLY · DATABASE_RECEIPT_NOT_VERIFIED · Draft ${draftId.slice(0, 8)} v${result.version} matched target, identity, content and hash in API readback.`);
      return;
    }

    const operation = 'CREATE_OFFER_DRAFT';
    const idempotencyKey = offer.idempotency_key;
    let postResult = null;
    try {
      postResult = await api('POST', '/api/offers', offer);
    } catch (error) {
      const commitUnknown = error.code === 'API_NON_JSON_RESPONSE' || error.name === 'TypeError' || error.status === undefined;
      if (!commitUnknown) throw error;
      setNotice(tr('Verification Pending: kết quả ghi chưa rõ. Đang resolve bằng cùng idempotency key; không tạo yêu cầu mới.', 'Verification Pending: the write result is uncertain. Resolving with the same idempotency key; no new request is created.'));
    }

    let resolver;
    let readback;
    try {
      // Always resolve the exact creation action, including after a successful POST.
      resolver = await api('POST', '/api/offers/resolve-draft', { idempotency_key: idempotencyKey });
      if (resolver?.status === 'COMMITTED' && resolver.offer_id) {
        readback = await api('GET', `/api/offers/${resolver.offer_id}`);
      }
    } catch (error) {
      throw Object.assign(new Error('creation resolver/readback unavailable'), { code: 'RECEIPT_ACTION_BINDING_MISMATCH', cause: error });
    }

    const binding = await validateDraftCreationBinding({
      operation,
      idempotencyKey,
      actor,
      postResult,
      resolver,
      readback,
      expected,
    });
    if (!binding.ok) {
      throw Object.assign(new Error('creation receipt is not bound to the requested action and target'), { code: 'RECEIPT_ACTION_BINDING_MISMATCH' });
    }

    const result = postResult || resolver.receipt;
    state.draftId = resolver.offer_id;
    state.keys.delete(operation);
    for (const [id, value] of submittedValues) markFieldSaved(id, value);
    clearGuestDraft();
    updateDraftAction();
    $('o-state').textContent = tr(`LOCAL/API_READBACK_ONLY · DATABASE_RECEIPT_NOT_VERIFIED · ${operation} · key ${binding.keyIdentity.slice(0, 16)} · Draft ${resolver.offer_id.slice(0, 8)} v${result.version} đã khớp resolver, target, identity, nội dung và hash.`, `LOCAL/API_READBACK_ONLY · DATABASE_RECEIPT_NOT_VERIFIED · ${operation} · key ${binding.keyIdentity.slice(0, 16)} · Draft ${resolver.offer_id.slice(0, 8)} v${result.version} matched resolver, target, identity, content and hash.`);
  } finally {
    draftSavePending = false;
    $('b-draft').disabled = false;
    $('confirm-draft-save').disabled = false;
  }
}

$('b-draft').onclick = guard(async () => {
  if (!state.me) {
    persistGuestDraft('save');
    setNotice(tr('Bản nháp chỉ được giữ trong tab này. Hãy đăng nhập; sau đó kiểm tra và bấm Xác nhận lưu. Chưa có dữ liệu nào được gửi tới server.', 'The draft is kept only in this tab. Sign in, then review and press Confirm save. No data has been sent to the server.'));
    $('real-only-gate').scrollIntoView({ block: 'start' });
    return;
  }
  await saveDraftToServer();
});
$('b-publish').onclick = guard(async () => {
  if (!state.me) {
    persistGuestDraft('open');
    setNotice(tr('Đã giữ bản xem trước trong tab này. Đăng nhập và xác nhận lưu trước; Open Offer vẫn là thao tác riêng sau khi server readback khớp.', 'The preview is held in this tab. Sign in and confirm the save first; Open Offer remains a separate action after server readback matches.'));
    $('real-only-gate').scrollIntoView({ block: 'start' });
    return;
  }
  if (!state.draftId) throw new Error(tr('Hãy lưu bản nháp trước', 'save a draft first'));
  const result = await api('POST', `/api/offers/${state.draftId}/publish`);
  $('o-state').textContent = tr(`Offer ${result.offer_id.slice(0, 8)} đã mở. Nội dung bị cố định; chưa có Acceptance.`, `Offer ${result.offer_id.slice(0, 8)} is open. Terms are fixed; no Acceptance occurred.`);
  state.draftId = null; updateDraftAction(); await refreshAll();
});
$('confirm-draft-save').onclick = guard(async () => {
  if (!state.me) {
    $('real-only-gate').scrollIntoView({ block: 'start' });
    return;
  }
  await saveDraftToServer();
});
$('discard-guest-draft').onclick = () => {
  clearGuestDraft();
  $('o-state').textContent = '';
  setNotice(tr('Đã hủy bản xem trước trong tab này. Không có API hoặc thao tác ghi nào được gọi.', 'The preview in this tab was discarded. No API or write operation was called.'));
  $('b-draft').focus();
};
$('b-propose').onclick = guard(async () => {
  if (!state.offer) throw new Error(tr('Hãy chọn một Offer trước', 'select an Offer first'));
  await api('POST', `/api/offers/${state.offer.offer_id}/proposals`, { packages: Number($('p-pk').value) });
  setNotice(tr('Proposal riêng của bạn đã được tạo.', 'Your separate Proposal was created.'));
  await refreshProposals();
});
$('b-close-offer').onclick = guard(async () => {
  if (!state.offer || state.offerDetail?.owner_id !== state.me?.participant_id) throw new Error(tr('Chỉ chủ Offer có thể đóng', 'only the Offer owner may close it'));
  await api('POST', `/api/offers/${state.offer.offer_id}/close`);
  setNotice(tr('Đã đóng phần capacity chưa ghép. Agreement đã commit không bị thay đổi.', 'Unmatched capacity was closed. Existing committed Agreements were not changed.'));
  state.offer = null; state.offerDetail = null; $('sel').textContent = tr('Hãy chọn một Offer trước.', 'Select an Offer first.'); await refreshAll();
});
$('b-assist').onclick = guard(async () => {
  const out = $('a-out'); out.textContent = ''; out.className = 'assistant-output';
  try {
    const result = await api('POST', '/api/assist/offer', { text: $('a-text').value });
    $('o-give').value = result.terms.give; $('o-receive').value = result.terms.receive; $('o-loc').value = result.terms.location; $('o-av').value = result.terms.availability;
    refreshUnsavedChanges();
    renderGuestDraftPreview();
    $('hoa-mai-utility-status').dataset.lastSource = result.source || '';
    renderHoaMaiExecutionDetails(result);
    renderHoaMaiRuntimeStatus({ configured: true, live_call_verified: result.source === 'META_MUSE_SPARK_LIVE' });
    out.textContent = tr(`Gợi ý từ ${result.model}. Hãy xem lại trước khi lưu.${result.questions.length ? ` Cần hỏi thêm: ${result.questions.join(' / ')}` : ''}`, `Suggestion from ${result.model}. Review before saving.${result.questions.length ? ` Questions: ${result.questions.join(' / ')}` : ''}`);
    await loadStatus();
  } catch (error) {
    const messages = {
      META_NOT_CONFIGURED: tr('Chưa cấu hình Meta key; không có gợi ý được tạo.', 'Meta key is not configured; no suggestion was produced.'),
      META_AUTH_REJECTED: tr('Meta từ chối key (401). Không retry và không tạo gợi ý dự phòng.', 'Meta rejected the key (401). No retry and no fallback suggestion.'),
      META_LOCAL_RATE_LIMIT: tr('Muse Spark đang giãn nhịp. Vui lòng chờ rồi thử lại.', 'Muse Spark is pacing calls. Please wait and retry.'),
      META_DAILY_BUDGET_EXHAUSTED: tr('Đã đạt giới hạn Muse Spark trong ngày.', 'The daily Muse Spark limit has been reached.'),
      META_SENSITIVE_INPUT_REJECTED: tr('Hãy bỏ email, số điện thoại, mật khẩu, OTP hoặc thông tin thanh toán.', 'Remove email, phone, passwords, OTPs, or payment details.'),
    };
    if (messages[error.code]) { out.textContent = messages[error.code]; out.className = 'assistant-output bad'; return; }
    throw error;
  }
});
$('b-knowledge').onclick = guard(async () => {
  const host = $('knowledge-answer');
  const button = $('b-knowledge');
  const requestId = ++state.knowledgeRequestId;
  button.disabled = true;
  host.replaceChildren();
  host.append(el('p', tr('Đang hỏi các nguồn đã kết nối…', 'Checking connected sources…'), { className: 'source-loading' }));
  try {
    const question = $('k-question').value;
    const result = await api('POST', '/api/assist/explain', { text: question, lang: state.language });
    if (requestId !== state.knowledgeRequestId) return;
    markFieldSaved('k-question', question);
    host.replaceChildren();
    const local = result.local_knowledge;
    const ko = result.ri_kos.ko;
    const answer = ko && result.ri_kos.answer
      ? { source: 'RI-KOS', text: result.ri_kos.answer }
      : local.answer
        ? { source: 'RKB', text: local.answer }
        : result.ri_bca.answer
          ? { source: 'RI-BCA', text: result.ri_bca.answer }
          : null;
    const card = el('article', undefined, { className: `source-result primary-answer${answer ? '' : ' source-unavailable'}` });
    card.append(
      el('strong', answer ? `${tr('Trả lời', 'Answer')} · ${answer.source}` : tr('Chưa có câu trả lời', 'Answer unavailable')),
      el('p', answer?.text || tr('Hiện chưa có nguồn nào trả lời được câu hỏi này. Vui lòng thử lại sau.', 'No connected source can answer this question right now. Please try again later.')),
    );
    host.append(card);

    const details = el('details', undefined, { className: 'source-details' });
    details.append(el('summary', tr('Chi tiết kỹ thuật', 'Technical details')));
    const list = el('ul');
    list.append(
      el('li', `RKB · ${local.source_check || local.abstain || 'UNKNOWN'}`),
      el('li', `RI-KOS · ${result.ri_kos.status || 'UNKNOWN'}`),
      el('li', `RI-BCA · ${result.ri_bca.status || 'UNKNOWN'}`),
    );
    details.append(list);
    host.append(details);
    await loadStatus();
  } finally {
    if (requestId === state.knowledgeRequestId) button.disabled = false;
  }
});
$('accept-cancel').onclick = () => { state.pendingAccept = null; $('accept-dialog').close(); };
$('accept-confirm').onclick = guard(async () => {
  const proposal = state.pendingAccept;
  if (!proposal) return;
  $('accept-dialog').close(); state.pendingAccept = null; await accept(proposal);
});

$('b-open-hoa-mai').onclick = () => {
  $('a-text').scrollIntoView({ block: 'center' });
  $('a-text').focus();
};
$('b-open-hoa-mai-actions').onclick = () => {
  $('hoa-mai-action-result').textContent = '';
  $('hoa-mai-action-dialog').showModal();
  $('hoa-mai-intent').focus();
};
$('hoa-mai-action-close').onclick = () => $('hoa-mai-action-dialog').close();
$('b-hoa-mai-action').onclick = routeHoaMaiIntent;
$('b-open-system').onclick = () => {
  const panel = $('knowledge-help');
  panel.scrollIntoView({ block: 'start' });
  $('k-question').focus();
};
$('b-toggle-demo').onclick = () => {
  const section = $('demo-examples');
  const hidden = !section.classList.contains('demo-hidden');
  section.classList.toggle('demo-hidden', hidden);
  $('b-toggle-demo').setAttribute('aria-pressed', String(!hidden));
  $('b-toggle-demo').textContent = hidden ? tr('Hiện ví dụ DEMO', 'Show DEMO examples') : tr('Ẩn ví dụ DEMO', 'Hide DEMO examples');
};

async function initialize() {
  await loadStatus();
  await restoreBrowserSession();
  const restoredGuestDraft = restoreGuestDraft();
  setWorkflowAccess();
  if (restoredGuestDraft && state.me) {
    setNotice(tr('Đã khôi phục bản nháp tạm sau đăng nhập. Hãy kiểm tra rồi bấm Xác nhận lưu; chưa có thao tác nào tự gửi.', 'The temporary draft was restored after sign-in. Review it, then press Confirm save; nothing was submitted automatically.'));
  }
  await refreshAll();
}

applyLanguage();
guard(initialize)();
guard(loadLocationOptions)();
