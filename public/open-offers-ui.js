const fold = value => String(value ?? '').trim().toLocaleLowerCase();

export function publicOfferSearchText(offer = {}) {
  const terms = offer.terms || {};
  return [
    offer.public_display_label,
    offer.display_label,
    terms.give,
    terms.receive,
    terms.location,
    terms.availability,
    offer.status,
    offer.version,
  ].filter(value => value !== undefined && value !== null).join(' ').toLocaleLowerCase();
}

export function filterPublicOffers(offers, { search = '', location = '' } = {}) {
  const query = fold(search);
  const locationQuery = fold(location);
  return (Array.isArray(offers) ? offers : []).filter(offer => {
    const text = publicOfferSearchText(offer);
    const offerLocation = fold(offer?.terms?.location);
    return (!query || text.includes(query)) && (!locationQuery || offerLocation.includes(locationQuery));
  });
}

export function classifyOfferList({ loading = false, error = null, stale = false, loaded = 0, shown = 0, filtered = false } = {}) {
  if (loading && loaded === 0) return 'LOADING';
  if (error && stale && loaded > 0) return 'STALE';
  if (error) return 'ERROR';
  if (loaded === 0) return 'EMPTY';
  if (filtered && shown === 0) return 'NO_MATCH';
  return 'POPULATED';
}

export function publicOfferMeta(offer = {}) {
  const values = [];
  if (Number.isFinite(offer.packages_remaining) && Number.isFinite(offer.packages_total)) {
    values.push({ key: 'packages', remaining: offer.packages_remaining, total: offer.packages_total });
  }
  if (offer.status) values.push({ key: 'status', value: String(offer.status) });
  if (offer.version !== undefined && offer.version !== null) values.push({ key: 'version', value: String(offer.version) });
  const time = offer.updated_at || offer.published_at || offer.created_at || null;
  if (time) values.push({ key: 'time', value: String(time) });
  return values;
}

