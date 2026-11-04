const menuButton = document.getElementById('menu-toggle');
const nav = document.getElementById('primary-nav');
const navLinks = [...document.querySelectorAll('#primary-nav a[href^="#"]')];

function closeMenu() {
  nav?.classList.remove('is-open');
  menuButton?.setAttribute('aria-expanded', 'false');
}

menuButton?.addEventListener('click', () => {
  const open = !nav?.classList.contains('is-open');
  nav?.classList.toggle('is-open', open);
  menuButton.setAttribute('aria-expanded', String(open));
});

navLinks.forEach(link => link.addEventListener('click', closeMenu));

document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !document.querySelector('dialog[open]')) {
    closeMenu();
    menuButton?.focus();
  }
});

document.addEventListener('click', event => {
  if (!nav?.classList.contains('is-open')) return;
  if (!nav.contains(event.target) && !menuButton?.contains(event.target)) closeMenu();
});

const sections = navLinks
  .map(link => ({ link, section: document.querySelector(link.getAttribute('href')) }))
  .filter(item => item.section);

if ('IntersectionObserver' in window) {
  const observer = new IntersectionObserver(entries => {
    const visible = entries
      .filter(entry => entry.isIntersecting)
      .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
    if (!visible) return;
    navLinks.forEach(link => link.removeAttribute('aria-current'));
    const match = sections.find(item => item.section === visible.target);
    match?.link.setAttribute('aria-current', 'true');
  }, { rootMargin: '-25% 0px -60% 0px', threshold: [0.05, 0.25, 0.5] });
  sections.forEach(item => observer.observe(item.section));
}

window.addEventListener('resize', () => {
  if (window.innerWidth > 1360) closeMenu();
});

const serviceIntro = document.getElementById('service-intro-dialog');
const serviceIntroBack = document.getElementById('service-intro-back');
const servicePanels = [...document.querySelectorAll('[data-service-panel]')];
let serviceIntroTrigger = null;

function showServiceIntro(service) {
  const panel = servicePanels.find(item => item.dataset.servicePanel === service);
  if (!serviceIntro || !panel) return;
  servicePanels.forEach(item => { item.hidden = item !== panel; });
  serviceIntro.setAttribute('aria-label', panel.querySelector('h2')?.textContent || service);
  if (!serviceIntro.open) serviceIntro.showModal();
  serviceIntroBack?.focus();
}

function leaveServiceIntro() {
  if (history.state?.riSwapServiceIntro) history.back();
  else serviceIntro?.close();
}

document.querySelectorAll('[data-service-intro]').forEach(link => {
  link.addEventListener('click', event => {
    event.preventDefault();
    const service = link.dataset.serviceIntro;
    serviceIntroTrigger = link;
    history.pushState({ riSwapServiceIntro: service }, '', `#intro-${service}`);
    showServiceIntro(service);
  });
});

serviceIntroBack?.addEventListener('click', leaveServiceIntro);
serviceIntro?.addEventListener('cancel', event => { event.preventDefault(); leaveServiceIntro(); });
serviceIntro?.addEventListener('close', () => { serviceIntroTrigger?.focus(); serviceIntroTrigger = null; });
window.addEventListener('popstate', () => {
  if (history.state?.riSwapServiceIntro) showServiceIntro(history.state.riSwapServiceIntro);
  else if (serviceIntro?.open) serviceIntro.close();
});
